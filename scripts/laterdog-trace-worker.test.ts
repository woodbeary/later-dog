import { describe, expect, it } from "vitest";
import { MAX_RETENTION_DAYS, handleTrace, retentionDays, sweepDue, sweepTraces, type TraceBucket } from "../deploy/laterdog/cloudflare/src/traces.ts";

const JOB = "5f2d8c0e-1111-4222-8333-444455556666";
const KEY = `traces/${JOB}.jsonl.gz`;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const GZIP = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);

class FakeBucket implements TraceBucket {
  readonly objects = new Map<string, { value: ArrayBuffer; customMetadata?: Record<string, string> }>();
  async get(key: string) {
    const found = this.objects.get(key);
    return found ? { body: new Response(found.value).body!, httpEtag: '"etag"', customMetadata: found.customMetadata } : null;
  }
  async head(key: string) { return this.objects.get(key) ?? null; }
  async put(key: string, value: ArrayBuffer, options?: { customMetadata?: Record<string, string> }) { this.objects.set(key, { value, customMetadata: options?.customMetadata }); }
  async delete(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key); }
  async list(options: { prefix: string; cursor?: string; limit?: number }) {
    const all = [...this.objects.entries()].filter(([key]) => key.startsWith(options.prefix)).map(([key, value]) => ({ key, customMetadata: value.customMetadata }));
    const start = Number(options.cursor ?? 0);
    const page = all.slice(start, start + (options.limit ?? 1000));
    const more = start + page.length < all.length;
    return { objects: page, truncated: more, ...(more ? { cursor: String(start + page.length) } : {}) };
  }
}

const put = (bucket: FakeBucket, headers: Record<string, string> = {}, body: Uint8Array = GZIP, configuredDays?: string, now = NOW, key = KEY) =>
  handleTrace(new Request(`http://state.r2/${key}`, { method: "PUT", body, headers }), bucket, key, { configuredDays, now });

describe("the supervisor Worker's trace store", () => {
  it("keeps a trace 30 days by default and as long as the Worker is configured to", async () => {
    const bucket = new FakeBucket();
    const answer = await put(bucket);
    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ key: KEY, bytes: GZIP.length, expiresAt: "2026-11-13T12:00:00.000Z" });
    expect(bucket.objects.get(KEY)?.customMetadata).toMatchObject({ retainDays: "30", truncated: "0" });
    await put(bucket, {}, GZIP, "90");
    expect(bucket.objects.get(KEY)?.customMetadata?.retainDays).toBe("90");
  });

  it("lets the supervisor ask for another retention, within one to 365 days", async () => {
    const bucket = new FakeBucket();
    await put(bucket, { "x-laterdog-retain-days": "7", "x-laterdog-truncated": "1" });
    expect(bucket.objects.get(KEY)?.customMetadata).toMatchObject({ retainDays: "7", truncated: "1" });
    await put(bucket, { "x-laterdog-retain-days": "99999" });
    expect(bucket.objects.get(KEY)?.customMetadata?.retainDays).toBe(String(MAX_RETENTION_DAYS));
    expect(retentionDays("0", "45")).toBe(45);
    expect(retentionDays("soon", undefined)).toBe(30);
    expect(retentionDays(null, "abc")).toBe(30);
  });

  it("refuses what is not a gzip trace of a sane size, and keys that are not a job's", async () => {
    const bucket = new FakeBucket();
    expect((await put(bucket, {}, new Uint8Array([1, 2, 3, 4]))).status).toBe(415);
    expect((await put(bucket, {}, new Uint8Array(0))).status).toBe(413);
    expect((await put(bucket, {}, GZIP, undefined, NOW, "traces/../latest/config.json")).status).toBe(400);
    expect((await put(bucket, {}, GZIP, undefined, NOW, "traces/not-a-job.jsonl.gz")).status).toBe(400);
    expect(bucket.objects.size).toBe(0);
  });

  it("serves a live trace and forgets an expired one", async () => {
    const bucket = new FakeBucket();
    await put(bucket);
    const live = await handleTrace(new Request(`http://state.r2/${KEY}`), bucket, KEY, { now: NOW + 86_400_000 });
    expect(live.status).toBe(200);
    expect(new Uint8Array(await live.arrayBuffer())).toEqual(GZIP);
    expect((await handleTrace(new Request(`http://state.r2/${KEY}`, { method: "HEAD" }), bucket, KEY, { now: NOW })).status).toBe(200);
    const gone = await handleTrace(new Request(`http://state.r2/${KEY}`), bucket, KEY, { now: NOW + 31 * 86_400_000 });
    expect(gone.status).toBe(410);
    expect(bucket.objects.size).toBe(0);
    expect((await handleTrace(new Request(`http://state.r2/${KEY}`), bucket, KEY, { now: NOW })).status).toBe(404);
    expect((await handleTrace(new Request(`http://state.r2/${KEY}`, { method: "DELETE" }), bucket, KEY)).status).toBe(405);
  });

  it("sweeps every expired trace across pages and leaves the rest, once an hour", async () => {
    const bucket = new FakeBucket();
    for (let index = 0; index < 5; index += 1) {
      const key = `traces/5f2d8c0e-1111-4222-8333-44445555000${index}.jsonl.gz`;
      await put(bucket, { "x-laterdog-retain-days": index < 3 ? "1" : "30" }, GZIP, undefined, NOW, key);
    }
    bucket.objects.set("latest/config.json", { value: new ArrayBuffer(1) });
    expect(await sweepTraces(bucket, NOW + 2 * 86_400_000)).toBe(3);
    expect([...bucket.objects.keys()].sort()).toEqual(["latest/config.json", "traces/5f2d8c0e-1111-4222-8333-444455550003.jsonl.gz", "traces/5f2d8c0e-1111-4222-8333-444455550004.jsonl.gz"]);
    expect(sweepDue(Date.parse("2026-10-14T12:00:00Z"))).toBe(true);
    expect(sweepDue(Date.parse("2026-10-14T12:05:00Z"))).toBe(false);
  });
});
