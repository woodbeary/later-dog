import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createClaudeRefreshGate } from "./claude-refresh-lock.ts";
import { CLAUDE_RENEW_ARGS, createClaudeRenewer, runClaudeRenewal, type ClaudeRenewal } from "./engine-renewal.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function account(expiresAt: number) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-renewal-")));
  scratch.push(base);
  const config = join(base, "config");
  mkdirSync(config, { recursive: true });
  const file = join(config, ".credentials.json");
  const save = (at: number, access = "renewed-access") => writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: "refresh", expiresAt: at } }));
  save(expiresAt, "first-access");
  const renewal: ClaudeRenewal = { command: "/nonexistent/claude", env: { HOME: base, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin" } };
  return { base, config, file, save, renewal };
}
const later = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const gate = (leadMs = 2_000) => createClaudeRefreshGate({ platform: "linux", pollMs: 5, leadMs });

it("renews only near expiry and only while a remote engine holds the account", async () => {
  const fresh = account(Date.now() + 3 * 3600_000);
  const runs: string[] = [];
  const renewer = createClaudeRenewer({ gate: gate(), checkMs: 60_000, run: async (renewal) => { runs.push(renewal.env.CLAUDE_CONFIG_DIR!); fresh.save(Date.now() + 8 * 3600_000); return true; } });
  const release = renewer.hold(fresh.renewal);
  await renewer.check();
  expect(runs).toEqual([]);
  release();
  fresh.save(Date.now() + 60_000);
  await renewer.check();
  expect(runs).toEqual([]);
  const again = renewer.hold(fresh.renewal);
  await renewer.check();
  expect(runs).toEqual([fresh.config]);
  expect(JSON.parse(readFileSync(fresh.file, "utf8")).claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600_000);
  await renewer.check();
  expect(runs).toHaveLength(1);
  again();
  again();
  expect(renewer.held()).toEqual([]);
  fresh.save(Date.now() + 60_000);
  await renewer.check();
  expect(runs).toHaveLength(1);
});

it("waits for a home turn that is already refreshing, and never refreshes after it", async () => {
  const shared = gate();
  const a = account(Date.now() + 60_000);
  let runs = 0;
  const renewer = createClaudeRenewer({ gate: shared, run: async () => { runs += 1; return true; } });
  await shared.enter(a.renewal.env);
  const release = renewer.hold(a.renewal);
  const checking = renewer.check();
  await later(60);
  expect(runs).toBe(0);
  a.save(Date.now() + 8 * 3600_000);
  await checking;
  expect(runs).toBe(0);
  release();
});

it("holds home turns back while it refreshes, and renews each account once however many engines share it", async () => {
  const shared = gate(5_000);
  const a = account(Date.now() + 60_000);
  let finish!: () => void;
  let runs = 0;
  const renewer = createClaudeRenewer({ gate: shared, run: async () => {
    runs += 1;
    await new Promise<void>((resolve) => { finish = resolve; });
    a.save(Date.now() + 8 * 3600_000);
    return true;
  } });
  const first = renewer.hold(a.renewal);
  const second = renewer.hold(a.renewal);
  await later(30);
  await Promise.race([renewer.check(), later(30)]);
  expect(runs).toBe(1);
  let homeStarted = false;
  const home = shared.enter(a.renewal.env).then(() => { homeStarted = true; });
  await later(60);
  expect(homeStarted).toBe(false);
  finish();
  await home;
  expect(homeStarted).toBe(true);
  expect(runs).toBe(1);
  first();
  expect(renewer.held()).toHaveLength(1);
  second();
  expect(renewer.held()).toEqual([]);
});

it("takes over after a home turn's refresh fails, and retries its own failure only after a back-off", async () => {
  let clock = Date.now();
  const a = account(clock + 60_000);
  const shared = gate(80);
  let runs = 0;
  let succeed = false;
  const renewer = createClaudeRenewer({ gate: shared, now: () => clock, retryMs: 120_000, run: async () => {
    runs += 1;
    if (succeed) a.save(Date.now() + 8 * 3600_000);
    return succeed;
  } });
  await shared.enter(a.renewal.env);
  const started = Date.now();
  const release = renewer.hold(a.renewal);
  await renewer.check();
  expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  expect(runs).toBe(1);
  await renewer.check();
  expect(runs).toBe(1);
  clock += 121_000;
  succeed = true;
  await renewer.check();
  expect(runs).toBe(2);
  clock += 121_000;
  await renewer.check();
  expect(runs).toBe(2);
  release();
});

it("asks the account's own CLI for its sign-in status, which renews a near-expiry sign-in without a model call", async () => {
  const a = account(Date.now() + 60_000);
  const cli = join(a.base, "claude");
  const seen = join(a.base, "seen.json");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" "$CLAUDE_CONFIG_DIR" "$PWD" > ${JSON.stringify(seen)}\n`);
  chmodSync(cli, 0o755);
  expect(await runClaudeRenewal({ ...a.renewal, command: cli })).toBe(true);
  expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual([CLAUDE_RENEW_ARGS.join(" "), a.config, a.config]);
  expect(CLAUDE_RENEW_ARGS).toEqual(["auth", "status", "--json"]);
  writeFileSync(cli, "#!/bin/sh\nexit 1\n");
  expect(await runClaudeRenewal({ ...a.renewal, command: cli })).toBe(false);
  expect(await runClaudeRenewal(a.renewal)).toBe(false);
  expect(existsSync(a.file)).toBe(true);
});
