import { hex, sha256 } from "./encoding.ts";
import { requireGeneration, requireTenant } from "./history-routing.ts";
import { putReceiptObject } from "./history-receipts.ts";

export type ReceiptPack = {
  sha256: string;
  items: { sha256: string; bytes: number }[];
};

type Location = { member: string; pack: string; start: number; bytes: number };
const validHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const hash = async (bytes: Uint8Array) => hex(await sha256(bytes));
const key = (stable: string, generation: string, pack: string) => {
  requireTenant(stable);
  requireGeneration(generation);
  if (!validHash(pack)) throw Error("Invalid history receipt pack checksum");
  return (
    "homes/" + stable + "/history/receipts/v1/" + generation + "/packs/" + pack
  );
};

async function limitedBytes(stream: ReadableStream<Uint8Array>, size: number) {
  const reader = stream.getReader(),
    output = new Uint8Array(size);
  let used = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > size - used)
        throw Error("History receipt pack exceeds expected size");
      output.set(part.value, used);
      used += part.value.byteLength;
    }
    if (used !== size) throw Error("History receipt pack was truncated");
    return output;
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export class HistoryReceiptPacks {
  private readonly sql: SqlStorage;
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly bucket: R2Bucket,
  ) {
    this.sql = storage.sql;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS history_receipt_packs (generation TEXT NOT NULL, member TEXT NOT NULL, pack TEXT NOT NULL, start INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(generation,member)) WITHOUT ROWID",
    );
  }
  private locate(generation: string, member: string) {
    if (!validHash(member)) throw Error("Invalid history receipt checksum");
    return this.sql
      .exec<Location>(
        "SELECT member,pack,start,bytes FROM history_receipt_packs WHERE generation=? AND member=?",
        generation,
        member,
      )
      .toArray()[0];
  }
  async publish(
    stable: string,
    generation: string,
    pack: ReceiptPack,
    body: ReadableStream<Uint8Array>,
    allowed: () => void,
  ) {
    if (
      !pack ||
      !validHash(pack.sha256) ||
      !Array.isArray(pack.items) ||
      !pack.items.length ||
      pack.items.length > 1024
    )
      throw Error("Invalid history receipt pack");
    const seen = new Set<string>();
    let bytes = 0;
    const locations = pack.items.map((item) => {
      if (
        !item ||
        !validHash(item.sha256) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 0 ||
        seen.has(item.sha256)
      )
        throw Error("Invalid history receipt pack member");
      seen.add(item.sha256);
      const start = bytes;
      bytes += item.bytes;
      if (bytes > 2 * 1024 * 1024)
        throw Error("History receipt pack is too large");
      return {
        member: item.sha256,
        pack: pack.sha256,
        start,
        bytes: item.bytes,
      };
    });
    const content = await limitedBytes(body, bytes);
    if ((await hash(content)) !== pack.sha256)
      throw Error("History receipt pack checksum differs");
    for (let i = 0; i < locations.length; i += 64) {
      await Promise.all(
        locations.slice(i, i + 64).map(async (row) => {
          const part = content.subarray(row.start, row.start + row.bytes);
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            part,
          );
          if ((await hash(part)) !== row.member)
            throw Error("History receipt member checksum differs");
        }),
      );
    }
    allowed();
    const path = key(stable, generation, pack.sha256);
    await putReceiptObject(this.bucket, path, pack.sha256, content);
    const stored = await this.bucket.get(path);
    if (
      !stored ||
      stored.size !== bytes ||
      !stored.checksums.sha256 ||
      hex(new Uint8Array(stored.checksums.sha256)) !== pack.sha256 ||
      (await hash(await limitedBytes(stored.body, bytes))) !== pack.sha256
    )
      throw Error("History receipt pack failed independent readback");
    allowed();
    this.storage.transactionSync(() => {
      for (const row of locations)
        this.sql.exec(
          "INSERT INTO history_receipt_packs(generation,member,pack,start,bytes) VALUES(?,?,?,?,?) ON CONFLICT(generation,member) DO NOTHING",
          generation,
          row.member,
          row.pack,
          row.start,
          row.bytes,
        );
    });
    return { sha256: pack.sha256, bytes, count: locations.length };
  }
  async read(stable: string, generation: string, member: string) {
    const row = this.locate(generation, member);
    if (!row) return null;
    const path = key(stable, generation, row.pack);
    const obj = row.bytes
      ? await this.bucket.get(path, {
          range: { offset: row.start, length: row.bytes },
        })
      : await this.bucket.head(path);
    if (
      !obj ||
      obj.size < row.start + row.bytes ||
      !obj.checksums.sha256 ||
      hex(new Uint8Array(obj.checksums.sha256)) !== row.pack
    )
      throw Error("Verified history receipt pack is missing");
    const part =
      "body" in obj
        ? await limitedBytes((obj as R2ObjectBody).body, row.bytes)
        : new Uint8Array();
    if ((await hash(part)) !== member)
      throw Error("Packed history receipt value differs");
    return new Blob([part]).stream();
  }
  batch(stable: string, generation: string) {
    const packs = new Map<string, Promise<Uint8Array>>();
    return async (member: string, inline: number) => {
      const row = this.locate(generation, member);
      if (!row) return null;
      if (row.bytes > inline) return { sha256: member, bytes: row.bytes };
      let stored = packs.get(row.pack);
      if (!stored) {
        if (packs.size >= 4) packs.delete(packs.keys().next().value!);
        stored = (async () => {
          const obj = await this.bucket.get(key(stable, generation, row.pack));
          if (
            !obj ||
            obj.size > 2 * 1024 * 1024 ||
            !obj.checksums.sha256 ||
            hex(new Uint8Array(obj.checksums.sha256)) !== row.pack
          )
            throw Error("Packed history data is missing");
          const data = await limitedBytes(obj.body, obj.size);
          if ((await hash(data)) !== row.pack)
            throw Error("Packed history data checksum differs");
          return data;
        })();
        packs.set(row.pack, stored);
      }
      const data = await stored,
        part = data.subarray(row.start, row.start + row.bytes);
      if (part.length !== row.bytes || (await hash(part)) !== member)
        throw Error("Packed history receipt value differs");
      return {
        sha256: member,
        bytes: part.length,
        value: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(part),
      };
    };
  }
}
