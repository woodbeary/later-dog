import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalTraceStore, StateTraceStore, TRACE_COMMAND, TRACE_DEFAULT_RETENTION_DAYS, captureTrace, jobTraceStoreFromEnv, limitBytes, parseTraceReport, readableTraceStream, redactTrace, traceCommand, traceExpired, traceExpiry, traceKey, traceRetentionDays,
} from "./job-trace.ts";
import { FakeTraceState, slurp } from "./trace-state-fake.ts";

const JOB = "5f2d8c0e-1111-4222-8333-444455556666";
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), "laterdog-trace-")); roots.push(dir); return dir; };

describe("trace retention", () => {
  it("keeps traces 30 days unless the supervisor says otherwise, and ignores nonsense", () => {
    expect(traceRetentionDays({})).toBe(TRACE_DEFAULT_RETENTION_DAYS);
    expect(traceRetentionDays({ LATERDOG_TRACE_RETENTION_DAYS: "90" })).toBe(90);
    expect(traceRetentionDays({ LATERDOG_TRACE_RETENTION_DAYS: "0" })).toBe(30);
    expect(traceRetentionDays({ LATERDOG_TRACE_RETENTION_DAYS: "9999" })).toBe(30);
    expect(traceRetentionDays({ LATERDOG_TRACE_RETENTION_DAYS: "soon" })).toBe(30);
    expect(traceRetentionDays({ LATERDOG_TRACE_RETENTION_DAYS: "7.5" })).toBe(30);
  });

  it("computes and checks the expiry", () => {
    const stored = new Date("2026-10-14T00:00:00.000Z");
    expect(traceExpiry(stored, 30)).toBe("2026-11-13T00:00:00.000Z");
    expect(traceExpired({ expiresAt: "2026-11-13T00:00:00.000Z" }, Date.parse("2026-11-12T23:59:59Z"))).toBe(false);
    expect(traceExpired({ expiresAt: "2026-11-13T00:00:00.000Z" }, Date.parse("2026-11-13T00:00:00Z"))).toBe(true);
  });

  it("keys traces by job id only", () => {
    expect(traceKey(JOB)).toBe(`traces/${JOB}.jsonl.gz`);
    expect(() => traceKey("../../etc/passwd")).toThrow(/Invalid job id/);
  });
});

describe("trace contents", () => {
  it("blanks the Claude and GitHub tokens, and anything shaped like one, before the trace is stored", async () => {
    const claude = `sk-ant-oat01-${"a".repeat(90)}`;
    const text = `{"out":"${claude}"}\n{"out":"ghp_${"b".repeat(36)}"}\n{"out":"github_pat_${"c".repeat(40)}"}\n{"out":"plain text"}\n{"out":"my-own-secret-value"}`;
    const clean = redactTrace(text, ["my-own-secret-value"]);
    expect(clean).not.toMatch(/sk-ant|ghp_|github_pat_|my-own-secret/);
    expect(clean).toContain("plain text");
    const capture = await captureTrace(gzipSync(Buffer.from(text)), false, ["my-own-secret-value"]);
    expect(gunzipSync(capture.gz).toString("utf8")).toBe(clean);
    expect(capture.rawBytes).toBe(Buffer.byteLength(clean));
  });

  it("reads the computer's report about the packed trace", () => {
    expect(parseTraceReport("none\n")).toEqual({ kind: "none" });
    expect(parseTraceReport("whole 120\n44\n")).toEqual({ kind: "kept", truncated: false, rawBytes: 120, gzipBytes: 44 });
    expect(parseTraceReport("truncated 90000000\n7000\n")).toEqual({ kind: "kept", truncated: true, rawBytes: 90_000_000, gzipBytes: 7000 });
    expect(() => parseTraceReport("weird\n")).toThrow(/unreadable/);
    expect(TRACE_COMMAND).toContain("out.jsonl");
  });
});

describe("the trace store in R2", () => {
  it("uploads a trace with its retention and reads it back", async () => {
    const state = new FakeTraceState();
    const store = new StateTraceStore("http://state.r2/", { token: "state-token", fetch: state.fetch, now: () => new Date("2026-10-14T00:00:00Z") });
    const gz = gzipSync(Buffer.from('{"type":"result"}\n'));
    const trace = await store.put(JOB, gz, { retentionDays: 45, truncated: true });
    expect(trace).toMatchObject({ where: "r2", bytes: gz.length, truncated: true });
    expect(Date.parse(trace.expiresAt)).toBeGreaterThan(Date.now());
    expect(state.requests[0]).toMatchObject({ method: "PUT", path: `/traces/${JOB}.jsonl.gz` });
    expect(state.requests[0].headers).toMatchObject({ authorization: "Bearer state-token", "x-laterdog-retain-days": "45", "x-laterdog-truncated": "1", "content-type": "application/gzip" });
    expect((await slurp(await store.open(JOB)))!.length).toBeGreaterThan(0);
    expect(gunzipSync((await slurp(await store.open(JOB)))!).toString()).toBe('{"type":"result"}\n');
    expect(await store.open("11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("falls back to its own clock when the store answers without an expiry, and refuses when the store fails", async () => {
    const plain = (async () => new Response("Stored", { status: 201 })) as unknown as typeof fetch;
    const store = new StateTraceStore("http://state.r2", { fetch: plain, now: () => new Date("2026-10-14T00:00:00Z") });
    expect((await store.put(JOB, Buffer.from("x"), { retentionDays: 30, truncated: false })).expiresAt).toBe("2026-11-13T00:00:00.000Z");
    const failing = new StateTraceStore("http://state.r2", { fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    await expect(failing.put(JOB, Buffer.from("x"), { retentionDays: 30, truncated: false })).rejects.toThrow(/answered 500/);
    await expect(failing.open(JOB)).rejects.toThrow(/answered 500/);
  });

  it("treats an expired trace as gone", async () => {
    const gone = new StateTraceStore("http://state.r2", { fetch: (async () => new Response("expired", { status: 410 })) as unknown as typeof fetch });
    expect(await gone.open(JOB)).toBeNull();
  });
});

describe("the trace store on disk", () => {
  it("keeps a trace as a private file and sweeps what no job keeps", async () => {
    const dir = tmp();
    const store = new LocalTraceStore(join(dir, "traces"), () => new Date("2026-10-14T00:00:00Z"));
    const other = "6a2d8c0e-1111-4222-8333-444455556666";
    const trace = await store.put(JOB, Buffer.from("one"), { retentionDays: 2, truncated: false });
    await store.put(other, Buffer.from("two"), { retentionDays: 2, truncated: false });
    expect(trace).toMatchObject({ where: "local", expiresAt: "2026-10-16T00:00:00.000Z" });
    expect((await slurp(await store.open(JOB)))?.toString()).toBe("one");
    expect(store.sweep(new Set([JOB]))).toBe(1);
    expect(readdirSync(join(dir, "traces"))).toEqual([`${JOB}.jsonl.gz`]);
    expect(await store.open(other)).toBeNull();
    store.forget(JOB);
    expect(readdirSync(join(dir, "traces"))).toEqual([]);
  });

  it("uses the state URL when there is one and the supervisor's disk otherwise", () => {
    const dir = tmp();
    expect(jobTraceStoreFromEnv({}, dir).primary.where).toBe("local");
    expect(jobTraceStoreFromEnv({ LATERDOG_STATE_URL: "http://state.r2" }, dir).primary.where).toBe("r2");
  });
});

describe("packing the trace on the computer", () => {
  const run = (home: string, command: string) => execFileSync("bash", ["-c", command], { env: { ...process.env, HOME: home }, encoding: "utf8" });
  const prepare = (text: string) => {
    const home = tmp();
    mkdirSync(join(home, "task"));
    writeFileSync(join(home, "task", "out.jsonl"), text);
    return home;
  };
  const noise = (seed: number, length: number) => { let x = seed; let out = ""; while (out.length < length) { x = (x * 1103515245 + 12345) % 2147483648; out += x.toString(36); } return out.slice(0, length); };
  const lines = (count: number, width: number) => Array.from({ length: count }, (_, index) => `{"n":${index},"pad":"${noise(index + 7, width)}"}\n`).join("");

  it("reports nothing for an empty or missing stream", () => {
    const home = tmp();
    mkdirSync(join(home, "task"));
    expect(run(home, TRACE_COMMAND).trim()).toBe("none");
    writeFileSync(join(home, "task", "out.jsonl"), "");
    expect(run(home, TRACE_COMMAND).trim()).toBe("none");
  });

  it("packs a small stream whole", () => {
    const text = lines(20, 40);
    const home = prepare(text);
    const report = parseTraceReport(run(home, TRACE_COMMAND));
    expect(report).toMatchObject({ kind: "kept", truncated: false, rawBytes: text.length });
    expect(gunzipSync(readFileSync(join(home, "task", "trace.jsonl.gz"))).toString()).toBe(text);
  });

  it("retries with a smaller tail when the packed stream is over the limit, keeping whole lines", () => {
    const text = lines(400, 300);
    const home = prepare(text);
    const command = traceCommand({ rawBytes: 1_000_000, gzipBytes: 20_000, tails: [60_000, 30_000, 15_000, 8_000, 4_000] });
    const report = parseTraceReport(run(home, command));
    expect(report).toMatchObject({ kind: "kept", truncated: true, rawBytes: text.length });
    if (report.kind !== "kept") throw new Error("expected a kept report");
    expect(report.gzipBytes).toBeLessThanOrEqual(20_000);
    expect(report.gzipBytes).toBe(readFileSync(join(home, "task", "trace.jsonl.gz")).length);
    const kept = gunzipSync(readFileSync(join(home, "task", "trace.jsonl.gz"))).toString();
    expect(kept.length).toBeLessThan(60_000);
    expect(text.endsWith(kept)).toBe(true);
    expect(kept.split("\n").filter(Boolean).every((line) => line.startsWith('{"n":') && line.endsWith("}"))).toBe(true);
  });

  it("drops the first line only when the cut lands inside it", () => {
    const text = lines(10, 90);
    const lineLength = text.indexOf("\n") + 1;
    const onBoundary = prepare(text);
    const boundaryCommand = traceCommand({ rawBytes: 1, gzipBytes: 1_000_000, tails: [lineLength * 4] });
    run(onBoundary, boundaryCommand);
    const whole = gunzipSync(readFileSync(join(onBoundary, "task", "trace.jsonl.gz"))).toString();
    expect(whole.split("\n").filter(Boolean)).toHaveLength(4);
    expect(text.endsWith(whole)).toBe(true);
    const inside = prepare(text);
    run(inside, traceCommand({ rawBytes: 1, gzipBytes: 1_000_000, tails: [lineLength * 4 + 5] }));
    const trimmed = gunzipSync(readFileSync(join(inside, "task", "trace.jsonl.gz"))).toString();
    expect(trimmed.split("\n").filter(Boolean)).toHaveLength(4);
    expect(trimmed.startsWith('{"n":')).toBe(true);
  });
});

describe("streaming a trace out", () => {
  it("unpacks a stored trace as a stream and stops one that grows past its limit", async () => {
    const text = '{"type":"result"}\n'.repeat(1000);
    expect((await slurp(readableTraceStream(Readable.from([gzipSync(Buffer.from(text))]))))!.toString()).toBe(text);
    await expect(slurp(Readable.from([Buffer.alloc(100), Buffer.alloc(100)]).pipe(limitBytes(150, "The trace")))).rejects.toThrow(/larger than/);
  });

  it("fails a stream that is not gzip instead of sending it on", async () => {
    await expect(slurp(readableTraceStream(Readable.from([Buffer.from("not gzip at all")])))).rejects.toThrow();
  });
});
