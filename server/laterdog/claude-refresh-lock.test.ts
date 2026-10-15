import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance } from "../contracts.ts";
import { ClaudeDriver } from "../drivers/claude.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import {
  CLAUDE_REFRESH_LOCK_RETRY_DELAYS_MS,
  CLAUDE_REFRESH_LOCK_STALE_MS,
  CLAUDE_REFRESH_MARGIN_MS,
  claudeRefreshLockFrame,
  claudeRefreshLockResult,
  claudeSignInAgainMessage,
  claudeTokenExpiry,
  createClaudeRefreshGate,
} from "./claude-refresh-lock.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-claude-cli.ts");
const CLI_WORDS = "Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. This is usually transient; retry in a minute, and if it persists close other Claude Code processes or sign in again";
const CLAUDE_OWN_LOCK_WAIT_MS = 7_500;

describe("recognising Claude Code's refresh-lock failure", () => {
  it("matches the CLI's own error frame in either wording, and never a dog's ordinary reply that quotes it", () => {
    expect(claudeRefreshLockFrame({ error: "server_error", is_api_error_message: true }, CLI_WORDS)).toBe(true);
    expect(claudeRefreshLockFrame({ is_api_error_message: true }, "OAuth access token could not be refreshed: another Claude Code process is holding the refresh lock")).toBe(true);
    expect(claudeRefreshLockFrame({}, `You asked about this: "${CLI_WORDS}"`)).toBe(false);
    expect(claudeRefreshLockFrame({ error: "server_error", is_api_error_message: true }, "API Error: 529 Overloaded")).toBe(false);
    expect(claudeRefreshLockResult({ is_error: true, result: CLI_WORDS })).toBe(true);
    expect(claudeRefreshLockResult({ is_error: false, result: CLI_WORDS })).toBe(false);
  });

  it("waits long enough across both retries for a lock left by a dead process to go stale", () => {
    expect(CLAUDE_REFRESH_LOCK_RETRY_DELAYS_MS).toHaveLength(2);
    const waited = CLAUDE_REFRESH_LOCK_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0) + 2 * CLAUDE_OWN_LOCK_WAIT_MS;
    expect(waited).toBeGreaterThan(CLAUDE_REFRESH_LOCK_STALE_MS);
  });

  it("names the account in one plain line", () => {
    expect(claudeSignInAgainMessage("Anthony")).toBe("Anthony needs signing in again.");
    expect(claudeSignInAgainMessage("  ")).toBe("This Claude account needs signing in again.");
  });
});

describe("one refresh per account before the others start", () => {
  let scratch: string;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "laterdog-refresh-gate-"));
  });
  afterEach(async () => {
    await removeTempDir(scratch);
  });

  const account = (name: string, expiresAt: number | null) => {
    const directory = join(scratch, name);
    mkdirSync(directory, { recursive: true });
    if (expiresAt !== null) writeFileSync(join(directory, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresAt } }));
    return { HOME: scratch, CLAUDE_CONFIG_DIR: directory };
  };
  const settled = async (promise: Promise<void>, ms = 60) =>
    Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

  it("reads only the expiry from a saved sign-in", () => {
    const env = account("reader", 1_700_000_000_000);
    expect(claudeTokenExpiry(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"))).toBe(1_700_000_000_000);
    expect(claudeTokenExpiry(join(scratch, "missing", ".credentials.json"))).toBeNull();
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), "{not json");
    expect(claudeTokenExpiry(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"))).toBeNull();
  });

  it("lets the first process refresh an expired sign-in while the others wait for the fresh one", async () => {
    const env = account("claude-2", Date.now() - 60_000);
    const gate = createClaudeRefreshGate({ platform: "linux", pollMs: 5, leadMs: 5_000 });
    expect(await settled(gate.enter(env))).toBe(true);
    const second = gate.enter(env);
    const third = gate.enter(env);
    expect(await settled(second)).toBe(false);
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 8 * 3_600_000 } }));
    expect(await settled(Promise.all([second, third]).then(() => undefined), 1_000)).toBe(true);
    expect(await settled(gate.enter(env))).toBe(true);
  });

  it("stops holding the others back once the first process has had its window, even if its refresh failed", async () => {
    const env = account("dead", Date.now() - 60_000);
    const gate = createClaudeRefreshGate({ platform: "linux", pollMs: 5, leadMs: 80 });
    await gate.enter(env);
    const started = Date.now();
    await gate.enter(env);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("never waits on a fresh sign-in, another account, an API key, or the Mac's Keychain", async () => {
    const fresh = account("fresh", Date.now() + CLAUDE_REFRESH_MARGIN_MS + 60_000);
    const expired = account("expired", Date.now() - 1);
    const other = account("other", Date.now() - 1);
    const linux = createClaudeRefreshGate({ platform: "linux", pollMs: 5, leadMs: 5_000 });
    expect(await settled(linux.enter(fresh))).toBe(true);
    expect(await settled(linux.enter(fresh))).toBe(true);
    await linux.enter(expired);
    expect(await settled(linux.enter(other))).toBe(true);
    expect(await settled(linux.enter({ ...expired, ANTHROPIC_API_KEY: "sk-ant-fixture" }))).toBe(true);
    const mac = createClaudeRefreshGate({ platform: "darwin", pollMs: 5, leadMs: 5_000 });
    await mac.enter(expired);
    expect(await settled(mac.enter(expired))).toBe(true);
  });
});

describe("a dog's turn that hits Claude Code's refresh lock", () => {
  let scratch: string;
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "laterdog-refresh-lock-turn-"));
  });

  afterEach(async () => {
    for (const name of ["FAKE_CLAUDE_REFRESH_LOCK_FAILS", "FAKE_CLAUDE_REFRESH_LOCK_STATE", "FAKE_CLAUDE_PROMPTS", "FAKE_CLAUDE_RETRY_SCALE"]) delete process.env[name];
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  const create = async (fails: number, retryScale: number) => {
    process.env.FAKE_CLAUDE_REFRESH_LOCK_FAILS = String(fails);
    process.env.FAKE_CLAUDE_REFRESH_LOCK_STATE = join(scratch, "refresh-lock-state");
    process.env.FAKE_CLAUDE_PROMPTS = join(scratch, "prompts.jsonl");
    process.env.FAKE_CLAUDE_RETRY_SCALE = String(retryScale);
    instance = await ClaudeDriver.create({
      instanceId: "claude-2",
      displayName: "Nimbus's account",
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, permissionMode: "acceptEdits" },
    });
    recorder = recordEvents(instance.adapter);
  };
  const prompts = () => existsSync(join(scratch, "prompts.jsonl"))
    ? readFileSync(join(scratch, "prompts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line).message.content)
    : [];
  const shown = () => JSON.stringify(recorder.events);

  it("retries the first message by itself and answers, with nothing about the lock shown", async () => {
    await create(1, 0.001);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-nimbus", text: "Hi Nimbus" });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: true });
    expect(prompts()).toEqual(["Hi Nimbus", "Hi Nimbus"]);
    expect(recorder.events.some((event) => event.type === "runtime.error")).toBe(false);
    expect(recorder.events.some((event) => event.type === "turn.retrying")).toBe(false);
    expect(recorder.events.filter((event) => event.type === "item.completed" && (event as { itemType?: string }).itemType === "assistant_text")).toHaveLength(1);
    expect(shown()).not.toContain("another Claude Code process");
  });

  it("gives up after two retries with one plain sign-in line, never the CLI's words", async () => {
    await create(3, 0.001);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-stuck", text: "Hi again" });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(prompts()).toEqual(["Hi again", "Hi again", "Hi again"]);
    const errors = recorder.events.filter((event) => event.type === "runtime.error");
    expect(errors).toEqual([expect.objectContaining({ message: "Nimbus's account needs signing in again.", setup: true })]);
    expect(recorder.events.some((event) => event.type === "item.completed" && (event as { itemType?: string }).itemType === "assistant_text")).toBe(false);
    expect(recorder.events.some((event) => event.type === "content.delta")).toBe(false);
    expect(shown()).not.toContain("another Claude Code process");
  });

  it("sends nothing more when the person stops the turn while it waits to retry", async () => {
    await create(1, 1);
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-stop", text: "Never mind" });
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(scratch, "refresh-lock-state")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await instance.adapter.interruptTurn("t-stop");
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
    expect(prompts()).toEqual(["Never mind"]);
    expect(shown()).not.toContain("another Claude Code process");
  });
});
