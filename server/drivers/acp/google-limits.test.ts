import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, ensureDirs } from "../../config.ts";
import type { ProviderInstance } from "../../contracts.ts";
import { GuestProviderChannel } from "../../laterdog/guest-provider-channel.ts";
import { AccountBattery, DEFAULT_REST_MS, type BatteryAccount } from "../../laterdog/account-battery.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { AntigravityDriver } from "../antigravity.ts";
import { antigravityProfileDirectory } from "../antigravity-acp.ts";
import { GeminiAgentDriver } from "./gemini.ts";
import { googleUsageLimit, UNREPORTED_GEMINI_REST_MS } from "./google-limits.ts";

const FAKE_ACP = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "testing", "fake-acp-cli.ts");
const NOW = Date.parse("2026-11-26T20:00:00Z");
const HOUR = 3_600_000;

interface Sample {
  name: string;
  status: "confirmed" | "inferred";
  source: string;
  error: { message?: string; code?: number; data?: unknown };
}

export const ANTIGRAVITY_SAMPLES: Sample[] = [
  {
    name: "weekly lockout with a reset time",
    status: "confirmed",
    source: "user log in the Ultra quota lockout forum thread, June 2026; the ACP wrapper around the text is inferred",
    error: { code: 429, message: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Contact your administrator to enable overages. Resets in 53h16m34s." },
  },
  {
    name: "session lockout with a reset time",
    status: "inferred",
    source: "same wording with a five-hour window",
    error: { code: 429, message: "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Contact your administrator to enable overages. Resets in 4h59m." },
  },
  {
    name: "bare exhausted body",
    status: "confirmed",
    source: "error body quoted in the Ultra streamGenerateContent forum thread",
    error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", data: { status: "RESOURCE_EXHAUSTED" } },
  },
];

export const GEMINI_SAMPLES: Sample[] = [
  {
    name: "ACP wrapper for any 429 after retries",
    status: "confirmed",
    source: "gemini-cli packages/cli/src/acp/acpSession.ts, prompt catch block",
    error: { code: 429, message: "Rate limit exceeded. Try again later." },
  },
  {
    name: "free tier per-minute quota with a short retry",
    status: "confirmed",
    source: "gemini-cli googleQuotaErrors.test.ts raw message",
    error: { code: 429, message: "You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 2\nPlease retry in 44.097740004s." },
  },
  {
    name: "daily quota message",
    status: "confirmed",
    source: "gemini-cli googleQuotaErrors.ts message string",
    error: { message: "You have exhausted your daily quota on this model." },
  },
  {
    name: "daily quota with structured details",
    status: "confirmed",
    source: "gemini-cli googleQuotaErrors.ts quota id substrings",
    error: { code: 429, message: "Quota exceeded", data: { details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" }] } },
  },
  {
    name: "per-minute quota id",
    status: "confirmed",
    source: "gemini-cli googleQuotaErrors.ts quota id substrings",
    error: { code: 429, message: "Quota exceeded", data: { details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel" }] }] } },
  },
  {
    name: "long retry delay",
    status: "confirmed",
    source: "gemini-cli googleQuotaErrors.test.ts: delays over 300 seconds are terminal",
    error: { code: 429, message: "Too many requests", data: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7200s" }] } },
  },
  {
    name: "model capacity",
    status: "confirmed",
    source: "gemini-cli googleQuotaErrors.ts capacity phrases",
    error: { code: 429, message: "You have exhausted your capacity on this model." },
  },
  {
    name: "spending cap",
    status: "confirmed",
    source: "gemini-cli googleQuotaErrors.test.ts",
    error: { code: 429, message: "Your project has exceeded its monthly spending cap." },
  },
];

const sample = (list: Sample[], name: string) => list.find((entry) => entry.name === name)!.error;

describe("Google exhaustion shapes", () => {
  it("keeps a status on every sample so the pull request can say which are confirmed", () => {
    for (const entry of [...ANTIGRAVITY_SAMPLES, ...GEMINI_SAMPLES]) expect(["confirmed", "inferred"]).toContain(entry.status);
  });

  it("rests an Antigravity account until the time it reports", () => {
    const weekly = googleUsageLimit(sample(ANTIGRAVITY_SAMPLES, "weekly lockout with a reset time"), "antigravity", NOW);
    expect(weekly).toEqual({ resetsAt: new Date(NOW + 53 * HOUR + 16 * 60_000 + 34_000).toISOString(), kind: "weekly", scope: "model" });
    const session = googleUsageLimit(sample(ANTIGRAVITY_SAMPLES, "session lockout with a reset time"), "antigravity", NOW);
    expect(session).toEqual({ resetsAt: new Date(NOW + 4 * HOUR + 59 * 60_000).toISOString(), kind: "session", scope: "model" });
  });

  it("leaves the rest time to the battery when Antigravity reports none", () => {
    expect(googleUsageLimit(sample(ANTIGRAVITY_SAMPLES, "bare exhausted body"), "antigravity", NOW)).toEqual({ scope: "model" });
  });

  it("rests a Gemini CLI account until midnight Pacific for a daily quota", () => {
    const midnight = new Date("2026-11-27T08:00:00Z").toISOString();
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "daily quota message"), "gemini", NOW)).toEqual({ resetsAt: midnight, kind: "daily", scope: "model" });
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "daily quota with structured details"), "gemini", NOW)).toEqual({ resetsAt: midnight, kind: "daily", scope: "model" });
  });

  it("follows Pacific daylight time at the day boundary", () => {
    const summer = Date.parse("2026-07-10T20:00:00Z");
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "daily quota message"), "gemini", summer)?.resetsAt).toBe("2026-07-11T07:00:00.000Z");
  });

  it("backs off without resting for per-minute throttles", () => {
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "free tier per-minute quota with a short retry"), "gemini", NOW)).toBeNull();
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "per-minute quota id"), "gemini", NOW)).toBeNull();
  });

  it("rests for a retry delay past five minutes", () => {
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "long retry delay"), "gemini", NOW)).toEqual({ resetsAt: new Date(NOW + 2 * HOUR).toISOString(), scope: "model" });
  });

  it("never rests an account for model capacity", () => {
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "model capacity"), "gemini", NOW)).toBeNull();
  });

  it("marks a spending cap as monthly with no reset time", () => {
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "spending cap"), "gemini", NOW)).toEqual({ kind: "monthly" });
  });

  it("rests briefly for the bare wrapper Gemini CLI sends over ACP", () => {
    expect(googleUsageLimit(sample(GEMINI_SAMPLES, "ACP wrapper for any 429 after retries"), "gemini", NOW))
      .toEqual({ resetsAt: new Date(NOW + UNREPORTED_GEMINI_REST_MS).toISOString(), scope: "model" });
  });

  it("ignores errors that are not limits", () => {
    for (const message of ["Model not found", "Authentication required", "Internal error", "ECONNRESET"]) {
      expect(googleUsageLimit({ message, code: -32603 }, "gemini", NOW)).toBeNull();
      expect(googleUsageLimit({ message }, "antigravity", NOW)).toBeNull();
    }
  });
});

describe("Google limits through the ACP core", () => {
  const scratch: string[] = [];
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  beforeEach(() => ensureDirs());
  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    for (const dir of scratch.splice(0)) await removeTempDir(dir);
  });

  const folder = () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-google-limits-"));
    scratch.push(dir);
    return dir;
  };

  const geminiTurn = async (fail: { rpc?: unknown; result?: unknown }) => {
    const dir = folder();
    const environment: Record<string, string> = { GEMINI_API_KEY: "fixture" };
    if (fail.rpc) {
      const file = join(dir, "failure.json");
      writeFileSync(file, JSON.stringify(fail.rpc));
      environment.FAKE_ACP_RPC_FAILURE_FILE = file;
    }
    if (fail.result) environment.FAKE_ACP_PROMPT_RESULT = JSON.stringify(fail.result);
    chmodSync(FAKE_ACP, 0o755);
    instance = await GeminiAgentDriver.create({ instanceId: "gemini-key", displayName: "Gemini key", environment, enabled: true, config: { cli: FAKE_ACP, fullAuto: false } });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "gemini-thread", text: "go", cwd: dir });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    return recorder.events.filter((event) => event.type === "runtime.error");
  };

  const antigravityTurn = async (rpc: unknown) => {
    const dir = folder();
    const executable = join(dir, "fake-antigravity.ts");
    copyFileSync(FAKE_ACP, executable);
    copyFileSync(FAKE_ACP, join(dir, process.platform === "win32" ? "localharness_external.exe" : "localharness_external"));
    chmodSync(executable, 0o755);
    chmodSync(join(dir, "localharness_external"), 0o755);
    const failure = join(dir, "failure.json");
    writeFileSync(failure, JSON.stringify(rpc));
    const instanceId = "antigravity-limit";
    const tokens = join(antigravityProfileDirectory(instanceId), "antigravity-acp");
    mkdirSync(tokens, { recursive: true });
    writeFileSync(join(tokens, "acp_token.json"), '{"client_id":"fixture-client","refresh_token":"fixture-refresh"}', { mode: 0o600 });
    instance = await AntigravityDriver.create({
      instanceId, displayName: "Antigravity", enabled: true, config: { cli: executable, fullAuto: false },
      environment: { FAKE_ACP_AUTH_METHOD: "oauth-personal", FAKE_ACP_MODELS: "gemini-3.8-flash-high", FAKE_ACP_MODES: "default,yolo,auto_edit", FAKE_ACP_RPC_FAILURE_FILE: failure, TEMP: dir, TMP: dir },
    });
    recorder = recordEvents(instance.adapter);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "agy-thread", text: "go", cwd: dir, resumeCursor: "fake-acp-session", model: "gemini-3.8-flash-high" });
    await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    return recorder.events.filter((event) => event.type === "runtime.error");
  };

  it("emits a daily Gemini CLI quota with the reset time when the prompt call fails", async () => {
    const errors = await geminiTurn({ rpc: { code: 429, message: "Quota exceeded", data: sample(GEMINI_SAMPLES, "daily quota with structured details").data } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ terminal: true, quota: { kind: "daily" } });
    expect((errors[0] as { quota: { resetsAt: string } }).quota.resetsAt).toMatch(/T0[78]:00:00\.000Z$/);
  });

  it("emits the quota when the prompt returns an error stop reason", async () => {
    const errors = await geminiTurn({ result: { stopReason: "error", error: "You have exhausted your daily quota on this model." } });
    expect(errors[0]).toMatchObject({ terminal: true, quota: { kind: "daily" } });
  });

  it("does not rest the account for a per-minute throttle", async () => {
    const errors = await geminiTurn({ rpc: { code: 429, ...sample(GEMINI_SAMPLES, "free tier per-minute quota with a short retry") } });
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toHaveProperty("quota");
    expect(errors[0]).not.toHaveProperty("terminal");
  });

  it("emits an Antigravity weekly quota with its reset time", async () => {
    const errors = await antigravityTurn(sample(ANTIGRAVITY_SAMPLES, "weekly lockout with a reset time"));
    expect(errors[0]).toMatchObject({ terminal: true, quota: { kind: "weekly" } });
    const until = Date.parse((errors[0] as { quota: { resetsAt: string } }).quota.resetsAt) - Date.now();
    expect(until).toBeGreaterThan(53 * HOUR);
    expect(until).toBeLessThan(54 * HOUR);
  });

  it("reaches the account battery from the event the driver emitted", async () => {
    const errors = await antigravityTurn(sample(ANTIGRAVITY_SAMPLES, "weekly lockout with a reset time"));
    const dir = folder();
    const accounts: BatteryAccount[] = [{ instanceId: "antigravity-limit", driverKind: "antigravityAgent", displayName: "Antigravity", enabled: true, eligible: true, signedIn: true, models: ["gemini-3.8-flash-high"] }];
    const battery = new AccountBattery({ file: join(dir, "battery.json"), config: () => ({ enabled: true, order: {} }), accounts: () => accounts });
    const quota = (errors[0] as { quota: { resetsAt?: string; kind?: string } }).quota;
    const rest = battery.markExhausted("antigravity-limit", quota, "gemini-3.8-flash-high");
    expect(rest.until).toBe(quota.resetsAt);
    expect(rest.estimated).toBeUndefined();
  });

  it("falls back to the battery's default rest when the provider names no time", () => {
    const dir = folder();
    const battery = new AccountBattery({ file: join(dir, "battery.json"), config: () => ({ enabled: true, order: {} }), accounts: () => [], now: () => NOW });
    const rest = battery.markExhausted("antigravity-limit", googleUsageLimit(sample(ANTIGRAVITY_SAMPLES, "bare exhausted body"), "antigravity", NOW)!);
    expect(Date.parse(rest.until) - NOW).toBe(DEFAULT_REST_MS);
    expect(rest.estimated).toBe(true);
  });

  it("keeps the quota when a machine relays the event to the home", async () => {
    const stdout = new PassThrough();
    const engine = Object.assign(new EventEmitter(), { stdout, stderr: new PassThrough(), stdin: new PassThrough(), exitCode: null, notDispatched: false }) as never;
    const published: unknown[] = [];
    const channel = new GuestProviderChannel(engine, "antigravityAgent", "antigravity-limit", "agy-thread", DATA_DIR, { threadId: "agy-thread", text: "go" } as never, (event) => published.push(event));
    const event = {
      eventId: "1", createdAt: new Date().toISOString(), provider: "antigravityAgent", providerInstanceId: "antigravity-limit", threadId: "agy-thread", turnId: "turn",
      type: "runtime.error", message: "Individual quota reached", terminal: true, quota: { kind: "weekly", resetsAt: new Date(NOW + 53 * HOUR).toISOString() },
    };
    stdout.write(JSON.stringify({ event }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(published).toEqual([expect.objectContaining({ type: "runtime.error", terminal: true, quota: event.quota })]);
    void channel;
  });
});
