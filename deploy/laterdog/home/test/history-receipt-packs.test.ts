import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { HistoryReceiptPacks } from "../src/history-receipt-packs.ts";

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
function fixture() {
  const db = new DatabaseSync(":memory:");
  const state = {
    sql: {
      exec: (query: string, ...args: unknown[]) => {
        const stmt = db.prepare(query),
          rows = stmt.all(...(args as string[]));
        return { toArray: () => rows };
      },
    },
    transactionSync: (op: () => void) => {
      db.exec("BEGIN");
      try {
        op();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
  const objects = new Map<
    string,
    {
      raw: Buffer;
      etag: string;
      checksums: { sha256?: ArrayBuffer };
      customMetadata?: Record<string, string>;
    }
  >();
  const entry = (obj: NonNullable<ReturnType<typeof objects.get>>) => ({
    ...obj,
    size: obj.raw.length,
  });
  const bucket = {
    head: async (key: string) => {
      const obj = objects.get(key);
      return obj ? entry(obj) : null;
    },
    get: async (
      key: string,
      opts?: { range: { offset: number; length: number } },
    ) => {
      const obj = objects.get(key);
      if (!obj) return null;
      const bytes = opts
        ? obj.raw.subarray(
            opts.range.offset,
            opts.range.offset + opts.range.length,
          )
        : obj.raw;
      return { ...entry(obj), body: new Blob([bytes]).stream() };
    },
    put: async (
      key: string,
      bytes: Uint8Array,
      opts: {
        onlyIf: { etagMatches?: string; etagDoesNotMatch?: string };
        customMetadata?: Record<string, string>;
        sha256?: string;
      },
    ) => {
      const old = objects.get(key);
      if (
        (opts.onlyIf.etagDoesNotMatch && old) ||
        (opts.onlyIf.etagMatches && old?.etag !== opts.onlyIf.etagMatches)
      )
        return null;
      const raw = Buffer.from(bytes),
        obj = {
          raw,
          etag: digest(raw),
          checksums: opts.sha256
            ? {
                sha256: Uint8Array.from(Buffer.from(opts.sha256, "hex")).buffer,
              }
            : {},
          customMetadata: opts.customMetadata,
        };
      objects.set(key, obj);
      return entry(obj);
    },
  };
  return {
    store: new HistoryReceiptPacks(
      state as unknown as DurableObjectStorage,
      bucket as unknown as R2Bucket,
    ),
    db,
    objects,
  };
}
function pack(values: string[]) {
  const data = Buffer.from(values.join(""));
  return {
    desc: {
      sha256: digest(data),
      items: values.map((v) => ({
        sha256: digest(v),
        bytes: Buffer.byteLength(v),
      })),
    },
    body: () => new Blob([data]).stream(),
  };
}
it("reads original UTF-8 values after interrupted grouped publication, retry and overlapping pack layouts", async () => {
  const { db, store, objects } = fixture(),
    stable = "a".repeat(64);
  try {
    const values = ["", "\uFEFF🐕", "ab", "c"],
      x = pack(values);
    let checked = 0;
    const stop = () => {
      if (++checked === 2) throw Error("closing");
    };
    await expect(
      store.publish(stable, "first", x.desc, x.body(), stop),
    ).rejects.toThrow("closing");
    expect(objects.size).toBe(1);
    expect(await store.read(stable, "first", digest("ab"))).toBeNull();
    const allow = () => {};
    const ack = await store.publish(stable, "first", x.desc, x.body(), allow);
    expect(ack.count).toBe(4);
    expect(
      await store.publish(stable, "first", x.desc, x.body(), allow),
    ).toEqual(ack);
    const y = pack(["", "\uFEFF🐕", "a", "bc"]);
    expect(y.desc.sha256).toBe(x.desc.sha256);
    await store.publish(stable, "first", y.desc, y.body(), allow);
    expect(objects.size).toBe(1);
    for (const v of [...values, "a", "bc"]) {
      const stream = await store.read(stable, "first", digest(v));
      expect(Buffer.from(await new Response(stream).arrayBuffer())).toEqual(
        Buffer.from(v),
      );
      expect(await store.batch(stable, "first")(digest(v), 100)).toEqual({
        sha256: digest(v),
        value: v,
        bytes: Buffer.byteLength(v),
      });
    }
    expect(await store.read(stable, "other", digest("ab"))).toBeNull();
    const bad = pack(["broken"]);
    bad.desc.items[0].sha256 = digest("foreign");
    await expect(
      store.publish(stable, "first", bad.desc, bad.body(), allow),
    ).rejects.toThrow("member checksum");
    expect(await store.read(stable, "first", digest("foreign"))).toBeNull();
  } finally {
    db.close();
  }
});
