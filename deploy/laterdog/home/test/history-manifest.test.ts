import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeHome,
  publishManifest,
  stageManifest,
} from "../migration/history/home-manifest.mjs";
import { digest } from "../migration/history/sqlite.mjs";
import { capture } from "../migration/history/package.mjs";
import { compact } from "../migration/history/projection.mjs";

it("retains exact source database bytes and publishes only the projected history row after a source-bound CAS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migration-manifest-"));
  const objects = new Map<string, { raw: Buffer; etag: string }>();
  const bucket = {
    async head(k: string) {
      return objects.get(k) ?? null;
    },
    async get(k: string) {
      const o = objects.get(k);
      return o && { etag: o.etag, arrayBuffer: async () => o.raw };
    },
    async put(
      k: string,
      body: Buffer,
      options?: {
        sha256: string;
        onlyIf: { etagMatches?: string; etagDoesNotMatch?: string };
      },
    ) {
      const o = objects.get(k);
      if (
        (options?.onlyIf.etagMatches &&
          o?.etag !== options.onlyIf.etagMatches) ||
        (o && options?.onlyIf.etagDoesNotMatch === "*")
      )
        return null;
      if (options?.sha256) expect(digest(body)).toBe(options.sha256);
      const item = { raw: body, etag: randomUUID() };
      objects.set(k, item);
      return { etag: item.etag };
    },
  };
  try {
    const db = new DatabaseSync(join(dir, "src.db"));
    db.exec(
      "CREATE TABLE messages(thread_id TEXT,id TEXT,at INTEGER,role TEXT,kind TEXT,text TEXT,json TEXT,PRIMARY KEY(thread_id,id));CREATE TABLE thread_state(thread_id TEXT PRIMARY KEY,active_leaf_id TEXT);INSERT INTO messages VALUES('a','b',1,'user','text','kept','{}')",
    );
    db.close();
    const raw = readFileSync(join(dir, "src.db")),
      h = digest(raw),
      stable = "c".repeat(64),
      root = "homes/" + stable + "/";
    const unrelated = {
      path: ".laterdog/note",
      mode: 384,
      mtimeMs: 10,
      type: "file",
      size: 1,
      chunks: [digest("n")],
    };
    const source = {
      version: 1,
      createdAt: 123,
      app: "source",
      entries: [
        unrelated,
        {
          path: ".laterdog/messages.db",
          mode: 384,
          mtimeMs: 9,
          type: "file",
          size: raw.length,
          chunks: [h],
        },
      ],
    };
    const manifest = Buffer.from(JSON.stringify(source));
    await bucket.put(root + "blobs/" + h, raw);
    await bucket.put(root + "manifest.json", manifest);
    const baseline = await materializeHome(
      bucket,
      stable,
      "forward",
      dir,
      join(dir, "cache"),
    );
    const file = join(baseline.directory, "data", "messages.db"),
      pack = join(dir, "pack"),
      result = join(dir, "result.db"),
      generation = "test";
    const c = await capture(file, pack),
      p = await compact(file, pack, c.sha256, result, generation);
    const plan = await stageManifest(
      bucket,
      stable,
      baseline.directory,
      join(dir, "cache"),
      result,
      p,
    );
    expect((await bucket.get(root + "manifest.json"))?.etag).toBe(
      baseline.etag,
    );
    await expect(
      (
        await bucket.get(root + "work-folders/legacy-blobs/" + h)
      )?.arrayBuffer(),
    ).resolves.toEqual(raw);
    const expected = { physicalId: "f".repeat(64), boot: "source" };
    const hold = {
      phase: "committed",
      ...expected,
      manifest: baseline.sha256,
      etag: '"' + baseline.etag + '"',
      projected: plan.target,
      target: { mode: "remote", generation },
    };
    const publish = () =>
      publishManifest(
        bucket,
        stable,
        baseline.directory,
        plan.target,
        expected,
        () => hold,
      );
    await expect(
      publishManifest(
        bucket,
        stable,
        baseline.directory,
        plan.target,
        expected,
        () => ({ ...hold, phase: "held" }),
      ),
    ).rejects.toThrow("did not commit");
    const prior = objects.get(root + "manifest.json")!;
    await bucket.put(
      root + "manifest.json",
      Buffer.from(JSON.stringify({ ...source, createdAt: 124 })),
    );
    await expect(publish()).rejects.toThrow("has changed");
    objects.set(root + "manifest.json", prior);
    const a = await publish(),
      b = await publish();
    expect(a).toEqual(b);
    const live = JSON.parse(
      objects.get(root + "manifest.json")!.raw.toString(),
    );
    expect(live.entries[0]).toEqual(unrelated);
    expect(live.entries[1].path).toBe(".laterdog/history-control.db");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
