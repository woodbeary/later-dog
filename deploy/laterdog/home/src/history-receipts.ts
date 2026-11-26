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
  const object = await bucket.put(path, data, {
    sha256: sha,
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/octet-stream" },
  });
  if (!object) {
    const prior = await bucket.head(path);
    if (
      !prior ||
      prior.size !== data.length ||
      !prior.checksums.sha256 ||
      hex(new Uint8Array(prior.checksums.sha256)) !== sha
    )
      throw Error("Existing history receipt differs");
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
    const part = await Promise.all(
      req.items.slice(i, i + 8).map(async (item) => {
        if (req.op === "get") {
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
    records.push(...part);
  }
  return { items: records };
}
