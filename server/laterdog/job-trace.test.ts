import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalTraceStore, StateTraceStore, TRACE_COMMAND, TRACE_DEFAULT_RETENTION_DAYS, captureTrace, jobTraceStoreFromEnv, parseTraceReport, readableTrace, redactTrace, traceExpired, traceExpiry, traceKey, traceRetentionDays,
} from "./job-trace.ts";
import { FakeTraceState } from "./trace-state-fake.ts";

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
  it("blanks the Claude and GitHub tokens, and anything shaped like one, before the trace is stored", () => {
    const claude = `sk-ant-oat01-${"a".repeat(90)}`;
    const text = `{"out":"${claude}"}\n{"out":"ghp_${"b".repeat(36)}"}\n{"out":"github_pat_${"c".repeat(40)}"}\n{"out":"plain text"}\n{"out":"my-own-secret-value"}`;
    const clean = redactTrace(text, ["my-own-secret-value"]);
    expect(clean).not.toMatch(/sk-ant|ghp_|github_pat_|my-own-secret/);
    expect(clean).toContain("plain text");
    const capture = captureTrace(gzipSync(Buffer.from(text)), false, ["my-own-secret-value"]);
    expect(readableTrace(capture.gz).toString("utf8")).toBe(clean);
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
    expect(gunzipSync((await store.get(JOB))!).toString()).toBe('{"type":"result"}\n');
    expect(await store.get("11111111-1111-4111-8111-111111111111")).toBeNull();
  });

  it("falls back to its own clock when the store answers without an expiry, and refuses when the store fails", async () => {
    const plain = (async () => new Response("Stored", { status: 201 })) as unknown as typeof fetch;
    const store = new StateTraceStore("http://state.r2", { fetch: plain, now: () => new Date("2026-10-14T00:00:00Z") });
    expect((await store.put(JOB, Buffer.from("x"), { retentionDays: 30, truncated: false })).expiresAt).toBe("2026-11-13T00:00:00.000Z");
    const failing = new StateTraceStore("http://state.r2", { fetch: (async () => new Response("no", { status: 500 })) as unknown as typeof fetch });
    await expect(failing.put(JOB, Buffer.from("x"), { retentionDays: 30, truncated: false })).rejects.toThrow(/answered 500/);
    await expect(failing.get(JOB)).rejects.toThrow(/answered 500/);
  });

  it("treats an expired trace as gone", async () => {
    const gone = new StateTraceStore("http://state.r2", { fetch: (async () => new Response("expired", { status: 410 })) as unknown as typeof fetch });
    expect(await gone.get(JOB)).toBeNull();
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
    expect((await store.get(JOB))?.toString()).toBe("one");
    expect(store.sweep(new Set([JOB]))).toBe(1);
    expect(readdirSync(join(dir, "traces"))).toEqual([`${JOB}.jsonl.gz`]);
    expect(await store.get(other)).toBeNull();
    store.forget(JOB);
    expect(readdirSync(join(dir, "traces"))).toEqual([]);
  });

  it("uses the state URL when there is one and the supervisor's disk otherwise", () => {
    const dir = tmp();
    expect(jobTraceStoreFromEnv({}, dir).primary.where).toBe("local");
    expect(jobTraceStoreFromEnv({ LATERDOG_STATE_URL: "http://state.r2" }, dir).primary.where).toBe("r2");
  });
});
