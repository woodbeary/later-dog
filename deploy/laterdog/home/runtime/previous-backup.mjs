import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { signPreviousBackup, verifyPreviousBackupSignature } from "./previous-backup-signature.mjs";
import { CHUNK_BYTES } from "./sync.mjs";

const hashPattern = /^[0-9a-f]{64}$/;
const path = ".laterdog/.backups/cloud-previous/workspace.dogbackup";
const maxArchive = 10 * 1024 ** 3 + 256 * 1024 ** 2;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const invalid = () => {
  throw Object.assign(new Error("Invalid previous backup reference."), { status: 422 });
};
const validSize = (value) => Number.isSafeInteger(value) && value > 0 && value <= maxArchive;

async function bounded(request, limit) {
  const parts = [];
  let total = 0;
  for await (const bytes of request) {
    total += bytes.length;
    if (total > limit) throw Object.assign(new Error("Previous backup request exceeds limit."), { status: 413 });
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

export function previousBackupHandler(store, secret) {
  const baseline = new Map();
  const checkedChunk = async (digest, archived) => {
    const bytes = Buffer.from(await (archived ? store.getArchived(digest) : store.get(digest)));
    if (bytes.length > CHUNK_BYTES || sha(bytes) !== digest)
      throw new Error("Previous backup object checksum mismatch.");
    return bytes;
  };
  const resolve = async (ref) => {
    if (ref?.v !== 1 || !validSize(ref.size)) invalid();
    if (ref.source === "baseline") {
      if (!hashPattern.test(ref.baseline)) invalid();
      const placement = await store.workFolderPlacement();
      if (placement?.mode !== "folders" || placement.baselineManifest !== ref.baseline) invalid();
      let entry = baseline.get(ref.baseline);
      if (!entry) {
        entry = (await store.legacyManifest(ref.baseline)).entries.find(
          (row) => row.path === path && row.type === "file",
        );
        if (!entry) invalid();
        baseline.clear();
        baseline.set(ref.baseline, entry);
      }
      if (
        entry.size !== ref.size ||
        entry.chunks?.length !== Math.ceil(ref.size / CHUNK_BYTES) ||
        !entry.chunks.every((h) => hashPattern.test(h))
      )
        invalid();
      return { chunks: entry.chunks, archived: false };
    }
    if (
      ref.source !== "archive" ||
      !hashPattern.test(ref.sha256) ||
      !Array.isArray(ref.chunks) ||
      ref.chunks.length !== Math.ceil(ref.size / CHUNK_BYTES) ||
      !ref.chunks.every((h) => hashPattern.test(h)) ||
      !hashPattern.test(ref.signature) ||
      !(await verifyPreviousBackupSignature(secret, ref))
    )
      invalid();
    return { chunks: ref.chunks, archived: true };
  };
  return async (route, request, response) => {
    if (!secret || request.method !== "POST")
      throw Object.assign(new Error("Previous backup access is unavailable."), { status: 403 });
    if (route === "/previous-cloud/block") {
      const bytes = await bounded(request, CHUNK_BYTES);
      if (!bytes.length) invalid();
      const digest = sha(bytes);
      if (!(await store.hasArchived(digest))) await store.putArchived(digest, bytes);
      await checkedChunk(digest, true);
      const tag = createHmac("sha256", secret)
        .update("laterdog.previous-block.v1\n" + digest)
        .digest("hex");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ sha256: digest, tag }));
      return;
    }
    const body = JSON.parse((await bounded(request, 1024 * 1024)).toString("utf8"));
    if (route === "/previous-cloud/seal") {
      if (
        !validSize(body.size) ||
        !hashPattern.test(body.sha256) ||
        !Array.isArray(body.blocks) ||
        body.blocks.length !== Math.ceil(body.size / CHUNK_BYTES)
      )
        invalid();
      const total = createHash("sha256"),
        chunks = [];
      let bytes = 0;
      for (const block of body.blocks) {
        if (!hashPattern.test(block.sha256) || !hashPattern.test(block.tag)) invalid();
        const tag = createHmac("sha256", secret)
          .update("laterdog.previous-block.v1\n" + block.sha256)
          .digest();
        if (!timingSafeEqual(tag, Buffer.from(block.tag, "hex"))) invalid();
        const part = await checkedChunk(block.sha256, true);
        if (part.length !== Math.min(CHUNK_BYTES, body.size - bytes)) invalid();
        bytes += part.length;
        total.update(part);
        chunks.push(block.sha256);
      }
      if (bytes !== body.size || total.digest("hex") !== body.sha256) invalid();
      const ref = { v: 1, source: "archive", size: bytes, sha256: body.sha256, chunks };
      const descriptor = { ...ref, signature: await signPreviousBackup(secret, ref) };
      await store.verifyPreviousBackup(descriptor);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(descriptor));
      return;
    }
    if (route !== "/previous-cloud/range")
      throw Object.assign(new Error("Unknown previous backup operation."), { status: 404 });
    const { reference, offset, length } = body;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > CHUNK_BYTES ||
      offset + length > reference?.size
    )
      invalid();
    const { chunks, archived } = await resolve(reference);
    const parts = [];
    for (let position = offset; position < offset + length; ) {
      const i = Math.floor(position / CHUNK_BYTES),
        inside = position % CHUNK_BYTES;
      const chunk = await checkedChunk(chunks[i], archived);
      if (chunk.length !== Math.min(CHUNK_BYTES, reference.size - i * CHUNK_BYTES)) invalid();
      const take = Math.min(offset + length - position, chunk.length - inside);
      parts.push(chunk.subarray(inside, inside + take));
      position += take;
    }
    response
      .writeHead(200, { "content-type": "application/octet-stream", "content-length": length })
      .end(Buffer.concat(parts));
  };
}
