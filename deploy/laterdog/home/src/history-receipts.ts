import { requireGeneration, requireTenant } from "./history-routing.ts";
import { hex, sha256 } from "./encoding.ts";

export interface ReceiptBatch {
  generation: string;
  op: "put" | "get";
  items: { sha256: string; value?: string }[];
}
function key(stable: string, generation: string, sha: string) {
  requireTenant(stable);
  requireGeneration(generation);
  if (!/^[a-f0-9]{64}$/.test(sha))
    throw Error("Invalid history receipt checksum");
  return "homes/" + stable + "/history/receipts/v1/" + generation + "/" + sha;
}
export async function putReceipt(
  bucket: R2Bucket,
  stable: string,
  generation: string,
  sha: string,
  body: ReadableStream<Uint8Array> | Uint8Array,
) {
  const path = key(stable, generation, sha);
  const data =
    body instanceof Uint8Array
      ? body
      : new Uint8Array(await new Response(body).arrayBuffer());
  if (hex(await sha256(data)) !== sha)
    throw Error("History receipt checksum mismatch");
  return putReceiptObject(bucket,path,sha,data);
}
export async function putReceiptObject(
  bucket: R2Bucket,
  path: string,
  sha: string,
  data: Uint8Array,
) {
  const reserved = await bucket.put(
    path,
    crypto.getRandomValues(new Uint8Array(32)),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { historyReceipt: "reservation" },
    },
  );
  const guard = reserved ?? (await bucket.head(path));
  const matches = (object: R2Object | null) =>
    object?.size === data.length &&
    !!object.checksums.sha256 &&
    hex(new Uint8Array(object.checksums.sha256)) === sha;
  if (!matches(guard)) {
    if (!guard || guard.customMetadata?.historyReceipt !== "reservation")
      throw Error("Existing history receipt differs");
    const object = await bucket.put(path, data, {
      sha256: sha,
      onlyIf: { etagMatches: guard.etag },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    if (!object && !matches(await bucket.head(path)))
      throw Error("History receipt upload was fenced");
  }
  return { sha256: sha, bytes: data.length };
}
export async function getReceipt(
  bucket: R2Bucket,
  stable: string,
  generation: string,
  sha: string,
) {
  const object = await bucket.get(key(stable, generation, sha));
  if (
    !object ||
    !object.checksums.sha256 ||
    hex(new Uint8Array(object.checksums.sha256)) !== sha
  )
    throw Error("A verified history receipt is missing");
  return object.body;
}
export async function receiptBatch(
  bucket: R2Bucket,
  stable: string,
  req: ReceiptBatch,
  packed?: (member:string,inline:number)=>Promise<{sha256:string,bytes:number,value?:string}|null>,
) {
  if (
    !["get", "put"].includes(req.op) ||
    !Array.isArray(req.items) ||
    req.items.length > 64 ||
    new TextEncoder().encode(JSON.stringify(req)).length > 512 * 1024
  )
    throw Error("Invalid history receipt batch");
  const records: { sha256: string; bytes?: number; value?: string }[] = [];
  let returnedBytes = 0;
  for (let i = 0; i < req.items.length; i += 8) {
    const part = await Promise.allSettled(
      req.items.slice(i, i + 8).map(async (item) => {
        if (req.op === "get") {
          const cached = packed && await packed(item.sha256,384*1024-returnedBytes);
          if (cached) {
            if (cached.value!==undefined && returnedBytes+cached.bytes<=384*1024) { returnedBytes+=cached.bytes;return cached; }
            return {sha256:cached.sha256,bytes:cached.bytes};
          }
          const object = await bucket.get(
            key(stable, req.generation, item.sha256),
          );
          if (
            !object ||
            !object.checksums.sha256 ||
            hex(new Uint8Array(object.checksums.sha256)) !== item.sha256
          )
            throw Error("A verified history receipt is missing");
          if (returnedBytes + object.size > 384 * 1024) {
            await object.body.cancel();
            return { sha256: item.sha256, bytes: object.size };
          }
          returnedBytes += object.size;
          const bytes = await object.arrayBuffer();
          return {
            sha256: item.sha256,
            value: new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(bytes),
          };
        }
        if (typeof item.value !== "string")
          throw Error("Missing history receipt bytes");
        return putReceipt(
          bucket,
          stable,
          req.generation,
          item.sha256,
          new TextEncoder().encode(item.value),
        );
      }),
    );
    for (const item of part) {
      if (item.status === "rejected") throw item.reason;
      records.push(item.value);
    }
  }
  return { items: records };
}
