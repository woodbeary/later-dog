import { WorkerEntrypoint } from "cloudflare:workers";
import policy from "./catalog.generated.json";

const allowed = new Set(policy.batches);
const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
const sha = async bytes => hex(await crypto.subtle.digest("SHA-256", bytes));
const utf8 = new TextEncoder();
const privatePrefix = stable => "homes/" + stable + "/work-folders/v1/";

async function read(bucket, key) {
  const object = await bucket.get(key);
  if (!object) throw new Error("The immutable object is missing");
  if (object.size > 8 * 1024 * 1024) { await object.body.cancel(); throw new Error("Invalid folder object size"); }
  return object.arrayBuffer();
}

export class ImmutableFolderCopy extends WorkerEntrypoint {
  inventory() {
    const { batches, ...identity } = policy;
    return { ...identity, batches: batches.length };
  }

  async process(action, scope, objects) {
    if (!["copy", "verify"].includes(action) || typeof scope !== "string" || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(scope) || !Array.isArray(objects) || objects.length > 48 || !objects.length) throw new Error("Unsupported immutable batch");
    const identity = await sha(utf8.encode(JSON.stringify([scope, objects])));
    if (!allowed.has(identity)) throw new Error("Batch is outside the signed-off catalog");
    let size = 0;
    for (let start = 0; start < objects.length; start += 3) {
      const lengths = await Promise.all(objects.slice(start, start + 3).map(async pair => {
        if (!Array.isArray(pair) || pair.length !== 2 || !["blobs", "manifests", "summaries"].includes(pair[0]) || !/^[a-f0-9]{64}$/.test(pair[1])) throw new Error("Invalid immutable key");
        const [kind, digest] = pair, relative = scope + "/" + kind + "/" + digest;
        const source = privatePrefix(policy.sourceStable) + relative, target = privatePrefix(policy.stable) + relative;
        if (action === "copy") {
          if (await this.env.DESTINATION.head(target)) return 0;
          const original = await read(this.env.SOURCE, source), checksum = await sha(original);
          if (kind !== "summaries" && checksum !== digest) throw new Error("Source checksum mismatch");
          await this.env.DESTINATION.put(target, original, { sha256: checksum, onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: kind === "blobs" ? "application/octet-stream" : "application/json" } });
          return original.byteLength;
        }
        const bytes = await read(this.env.DESTINATION, target);
        const expected = kind === "summaries" ? await sha(await read(this.env.SOURCE, source)) : digest;
        if (await sha(bytes) !== expected) throw new Error("Independent destination readback differs");
        return bytes.byteLength;
      }));
      size += lengths.reduce((total, n) => total + n, 0);
    }
    return { batch: identity, count: objects.length, bytes: size, action };
  }
}

export default { fetch() { return new Response(null, { status: 404 }); } };
