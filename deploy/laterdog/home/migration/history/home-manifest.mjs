import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { open, link, rm, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CHUNK_BYTES, parseManifest } from "../../runtime/sync.mjs";
import { checkpoint, digest, fileHash } from "./sqlite.mjs";
import { mapLimit } from "./transfer.mjs";
import { saveJson, writeOnce } from "./artifact.mjs";

const sha = /^[0-9a-f]{64}$/;
const scope = ".laterdog/";
function assert(v, m) {
  if (!v) throw Error(m);
}
const json = (path) => JSON.parse(readFileSync(path));
function relevant(path, mode) {
  if (!path.startsWith(scope)) return false;
  const name = path.slice(scope.length);
  return mode === "forward"
    ? /^messages\.db(?:-(?:wal|shm|journal))?$/.test(name) ||
        /^messages-[^/]+\.json$/.test(name)
    : /^history-control\.db(?:-(?:wal|shm|journal))?$/.test(name) ||
        name === "history-pending.json";
}
function sourceName(mode) {
  if (!["forward", "reverse"].includes(mode))
    throw Error("Invalid history direction");
  return mode === "forward" ? "messages.db" : "history-control.db";
}
export async function currentManifest(bucket, stable) {
  assert(sha.test(stable), "Invalid home namespace");
  const root = "homes/" + stable + "/",
    obj = await bucket.get(root + "manifest.json");
  assert(obj, "Missing home manifest");
  const raw = Buffer.from(await obj.arrayBuffer()),
    manifest = parseManifest(JSON.parse(raw));
  const paths = new Set();
  for (const entry of manifest.entries) {
    assert(!paths.has(entry.path), "Duplicate saved-home path");
    paths.add(entry.path);
  }
  return { stable, root, raw, manifest, etag: obj.etag, sha256: digest(raw) };
}
function selection(manifest, mode) {
  const selected = manifest.entries.filter((e) => relevant(e.path, mode));
  assert(
    selected.some((e) => e.path === scope + sourceName(mode)) &&
      selected.every(
        (e) =>
          e.type === "file" &&
          Number.isSafeInteger(e.size) &&
          e.size >= 0 &&
          !e.hardlink,
      ),
    "Missing or invalid source history files",
  );
  if (selected.some((e) => e.path === scope + "history-pending.json"))
    throw Error(
      "A history operation is still pending in the saved coordinator",
    );
  return selected;
}
async function readBlob(bucket, root, id, cache) {
  const file = join(cache, id);
  if (existsSync(file)) {
    const raw = readFileSync(file);
    assert(digest(raw) === id, "Corrupt local history chunk cache");
    return raw;
  }
  const o =
    (await bucket.get(root + "blobs/" + id)) ??
    (await bucket.get(root + "work-folders/legacy-blobs/" + id));
  assert(o, "Missing saved history chunk");
  const bytes = Buffer.from(await o.arrayBuffer());
  assert(digest(bytes) === id, "Saved history chunk checksum differs");
  writeOnce(file, bytes);
  return bytes;
}
export async function materializeHome(
  bucket,
  stable,
  mode,
  directory,
  cache,
  expected = {},
) {
  const c = await currentManifest(bucket, stable);
  if (expected.sha256)
    assert(
      c.sha256 === expected.sha256 &&
        (!expected.etag || expected.etag === c.etag),
      "Foreign source home manifest",
    );
  const selected = selection(c.manifest, mode),
    dir = join(directory, c.sha256),
    files = join(dir, "data");
  await mkdir(files, { recursive: true, mode: 0o700 });
  writeOnce(join(dir, "manifest.json"), c.raw);
  const result = [];
  for (const entry of selected) {
    const name = entry.path.slice(scope.length);
    if (name.endsWith("-shm")) continue;
    const file = join(files, name),
      tmp = file + "." + randomUUID() + ".part";
    const handle = await open(tmp, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for (let at = 0; at < entry.chunks.length; at += 8) {
        const parts = await Promise.all(
          entry.chunks
            .slice(at, at + 8)
            .map((h) => readBlob(bucket, c.root, h, cache)),
        );
        for (const b of parts) {
          hash.update(b);
          size += b.length;
          await handle.writeFile(b);
        }
      }
      assert(size === entry.size, "Saved database length differs");
      await handle.sync();
      await handle.close();
      const sha256 = hash.digest("hex");
      try {
        await link(tmp, file);
      } catch (error) {
        if (error.code !== "EEXIST" || (await fileHash(file)) !== sha256)
          throw error;
      }
      result.push({ name, sha256, size });
    } finally {
      await handle.close();
      await rm(tmp, { force: true });
    }
  }
  const receipt = {
    v: 1,
    stable,
    mode,
    sha256: c.sha256,
    etag: c.etag,
    files: result,
  };
  saveJson(join(dir, "source.json"), receipt);
  return { ...receipt, directory: dir };
}
async function immutable(bucket, key, bytes, id) {
  const old = await bucket.head(key);
  if (!old)
    await bucket.put(key, bytes, {
      sha256: id,
      onlyIf: { etagDoesNotMatch: "*" },
    });
  const actual = await bucket.get(key);
  assert(
    actual && digest(Buffer.from(await actual.arrayBuffer())) === id,
    "Immutable R2 history data failed readback",
  );
}
export async function stageManifest(
  bucket,
  stable,
  directory,
  cache,
  dbFile,
  projection,
) {
  const source = json(join(directory, "source.json")),
    raw = readFileSync(join(directory, "manifest.json"));
  const c = await currentManifest(bucket, stable);
  assert(
    source.stable === stable &&
      source.sha256 === digest(raw) &&
      source.sha256 === c.sha256 &&
      source.etag === c.etag,
    "Source changed before history projection",
  );
  const old = parseManifest(JSON.parse(raw)),
    entries = selection(old, source.mode);
  const src = sourceName(source.mode),
    dest = sourceName(source.mode === "forward" ? "reverse" : "forward");
  assert(
    !old.entries.some(
      (e) => e.path === scope + dest || e.path.startsWith(scope + dest + "-"),
    ),
    "A conflicting destination database already exists in the source",
  );
  const sourceControl = source.files.find((f) => f.name === src);
  assert(
    sourceControl &&
      sha.test(projection.sha256) &&
      (await fileHash(dbFile)) === projection.sha256 &&
      sha.test(projection.catalog),
    "Wrong projected history database",
  );
  for (const row of source.files)
    assert(
      (await fileHash(join(directory, "data", row.name))) === row.sha256,
      "Materialized source changed after R2 readback",
    );
  const check = join(directory, randomUUID() + ".part");
  try {
    await checkpoint(join(directory, "data", src), check);
    assert(
      (await fileHash(check)) === projection.sourceSha256,
      "Projected SQL was built from a different source SQLite snapshot",
    );
  } finally {
    await rm(check, { force: true });
  }
  if (source.mode === "forward") {
    const fallback = source.files.filter((row) =>
      /^messages-[^/]+\.json$/.test(row.name),
    );
    const known = new Map(
      (projection.legacy ?? []).map((row) => [
        "messages-" + row.threadId + ".json",
        row.sha256,
      ]),
    );
    assert(
      known.size === fallback.length &&
        fallback.every((row) => known.get(row.name) === row.sha256),
      "Active legacy thread files differ from the verified capture",
    );
  }
  const existing = entries.find((e) => e.path === scope + src);
  await immutable(
    bucket,
    c.root + "history-migration/manifests/" + source.sha256,
    raw,
    source.sha256,
  );
  const hashes = [...new Set(entries.flatMap((row) => row.chunks))];
  await mapLimit(hashes, 8, async (id) => {
    const bytes = await readBlob(bucket, c.root, id, cache);
    await immutable(
      bucket,
      c.root + "work-folders/legacy-blobs/" + id,
      bytes,
      id,
    );
  });
  const chunks = [],
    handle = await open(dbFile, "r");
  const total = (await stat(dbFile)).size;
  const whole = createHash("sha256");
  try {
    for (let at = 0; at < total; at += CHUNK_BYTES * 4) {
      const sizes = Array.from(
        { length: Math.min(4, Math.ceil((total - at) / CHUNK_BYTES)) },
        (_, i) => Math.min(CHUNK_BYTES, total - at - i * CHUNK_BYTES),
      );
      const parts = await Promise.all(
        sizes.map(async (size, i) => {
          const bytes = Buffer.alloc(size);
          let n = 0;
          while (n < size) {
            const r = await handle.read(
              bytes,
              n,
              size - n,
              at + i * CHUNK_BYTES + n,
            );
            if (!r.bytesRead) throw Error("Projected database shortened");
            n += r.bytesRead;
          }
          const id = digest(bytes);
          await immutable(
            bucket,
            c.root + "work-folders/legacy-blobs/" + id,
            bytes,
            id,
          );
          await immutable(bucket, c.root + "blobs/" + id, bytes, id);
          return { bytes, id };
        }),
      );
      for (const { bytes, id } of parts) {
        chunks.push(id);
        whole.update(bytes);
      }
    }
  } finally {
    await handle.close();
  }
  assert(
    whole.digest("hex") === projection.sha256,
    "Projected database changed during upload",
  );
  const entry = {
    path: scope + dest,
    mode: existing.mode,
    mtimeMs: existing.mtimeMs,
    type: "file",
    size: total,
    chunks,
  };
  const result = {
    ...old,
    entries: old.entries.flatMap((e) =>
      e.path === existing.path
        ? [entry]
        : relevant(e.path, source.mode)
          ? []
          : [e],
    ),
  };
  const body = Buffer.from(JSON.stringify(result)),
    target = digest(body);
  writeOnce(join(directory, target + ".json"), body);
  await immutable(
    bucket,
    c.root + "history-migration/manifests/" + target,
    body,
    target,
  );
  const got = await currentManifest(bucket, stable);
  assert(
    got.sha256 === source.sha256 && got.etag === source.etag,
    "Source changed while building manifest",
  );
  const plan = {
    v: 1,
    stable,
    mode: source.mode,
    source: source.sha256,
    etag: source.etag,
    target,
    catalog: projection.catalog,
    generation: projection.generation,
    sourceDatabase: sourceControl.sha256,
    projectedDatabase: projection.sha256,
    projectedBytes: total,
    priorChunks: hashes.length,
    targetChunks: chunks.length,
  };
  saveJson(join(directory, target + ".plan.json"), plan);
  return plan;
}
export async function publishManifest(
  bucket,
  stable,
  directory,
  target,
  expected,
  control,
) {
  const p = json(join(directory, target + ".plan.json")),
    body = readFileSync(join(directory, target + ".json"));
  assert(
    sha.test(target) &&
      p.stable === stable &&
      p.target === target &&
      digest(body) === target,
    "Invalid authorized history projection",
  );
  const hold = await control();
  assert(
    hold.phase === "committed" &&
      hold.physicalId === expected.physicalId &&
      hold.boot === expected.boot &&
      hold.manifest === p.source &&
      hold.projected === target &&
      hold.etag.replace(/^"|"$/g, "") === p.etag &&
      hold.target.mode === (p.mode === "forward" ? "remote" : "legacy") &&
      (p.mode === "forward"
        ? hold.target.generation
        : hold.source.generation) === p.generation,
    "Serving home did not commit this exact history projection",
  );
  const before = await currentManifest(bucket, stable);
  if (before.sha256 === target) return { sha256: target, etag: before.etag };
  assert(
    before.sha256 === p.source && before.etag === p.etag,
    "Source home has changed since authorization",
  );
  const saved = await bucket.put(before.root + "manifest.json", body, {
    sha256: target,
    onlyIf: { etagMatches: p.etag },
    httpMetadata: { contentType: "application/json" },
  });
  const after = await currentManifest(bucket, stable);
  assert(
    after.sha256 === target && (saved === null || saved.etag === after.etag),
    "R2 history publication lost its compare-and-set",
  );
  return { sha256: target, etag: after.etag };
}
