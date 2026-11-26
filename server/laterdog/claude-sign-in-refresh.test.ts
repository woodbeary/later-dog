import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAccountKeeper } from "./account-keeper.ts";
import { keepSignIn } from "./account-sign-ins.ts";
import { CLAUDE_SIGN_IN_CHECK_ARGS, claudeSignIn, readSavedClaudeSignIn, runClaudeSignInCheck, type ClaudeAccountRenewal } from "./claude-sign-in-refresh.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function account(expiresAt: number, refreshToken = "refresh") {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-sign-in-")));
  scratch.push(base);
  const config = join(base, "config");
  mkdirSync(config, { recursive: true });
  const file = join(config, ".credentials.json");
  const save = (at: number, refresh = refreshToken, access = "access") => writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: at } }));
  save(expiresAt);
  const renewal: ClaudeAccountRenewal = { command: "/nonexistent/claude", env: { HOME: base, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin:/bin" } };
  return { base, config, file, save, renewal };
}
const HOUR = 3600_000;

function keeperWith(run: (renewal: ClaudeAccountRenewal) => Promise<void>, changed?: (id: string, outcome: string) => void) {
  const keeper = createAccountKeeper({ everyMs: 60_000 });
  if (changed) keeper.onChange(changed);
  const renew = (renewal: ClaudeAccountRenewal) => keepSignIn(claudeSignIn(renewal, run));
  return { keeper, ensure: (id: string, renewal: ClaudeAccountRenewal) => keeper.keep(id, () => renew(renewal)), renew };
}

it("lends a sign-in that is not near expiry without running the CLI", async () => {
  const a = account(Date.now() + 3 * HOUR);
  let runs = 0;
  const { keeper, ensure } = keeperWith(async () => { runs += 1; });
  expect(await ensure("adam", a.renewal)).toBe("fresh");
  expect(runs).toBe(0);
  expect(keeper.signedOut("adam")).toBe(false);
});

it("renews an expired sign-in once for two turns that start together, and both lend the renewed one", async () => {
  const a = account(Date.now() - 60_000);
  let runs = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { ensure } = keeperWith(async () => { runs += 1; await gate; a.save(Date.now() + 8 * HOUR, "rotated", "renewed"); });
  const both = Promise.all([ensure("daniel", a.renewal), ensure("daniel", a.renewal)]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  expect(await both).toEqual(["renewed", "renewed"]);
  expect(runs).toBe(1);
  expect(JSON.parse(readFileSync(a.file, "utf8")).claudeAiOauth.accessToken).toBe("renewed");
  expect(await ensure("daniel", a.renewal)).toBe("fresh");
  expect(runs).toBe(1);
});

it("marks an account signed out when its refresh token is revoked, and clears it once the person signs in again", async () => {
  const a = account(Date.now() - 60_000);
  const changed: string[] = [];
  const { keeper, ensure } = keeperWith(async () => { writeFileSync(a.file, JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "", expiresAt: 0 } })); }, (id, outcome) => changed.push(id + " " + outcome));
  expect(await ensure("daniel", a.renewal)).toBe("signed-out");
  expect(keeper.signedOut("daniel")).toBe(true);
  a.save(Date.now() + 8 * HOUR);
  expect(await ensure("daniel", a.renewal)).toBe("fresh");
  expect(keeper.signedOut("daniel")).toBe(false);
  expect(changed).toEqual(["daniel signed-out", "daniel fresh"]);
});

it("keeps an account signed in when a renewal fails for a passing reason, so the battery does not drop it", async () => {
  const a = account(Date.now() - 60_000);
  let runs = 0;
  const { keeper, ensure } = keeperWith(async () => { runs += 1; });
  expect(await ensure("adam", a.renewal)).toBe("unrenewed");
  expect(keeper.signedOut("adam")).toBe(false);
  expect(runs).toBe(1);
});

it("treats a missing sign-in or an expired one without a refresh token as signed out without running the CLI", async () => {
  const lent = account(Date.now() - 60_000, "");
  const missing = account(Date.now() + HOUR);
  rmSync(missing.file);
  let runs = 0;
  const { ensure } = keeperWith(async () => { runs += 1; });
  expect(await ensure("lent", lent.renewal)).toBe("signed-out");
  expect(await ensure("missing", missing.renewal)).toBe("signed-out");
  expect(runs).toBe(0);
});

it("leaves accounts that sign in with a key or a token in the environment alone", async () => {
  const a = account(Date.now() - 60_000);
  let runs = 0;
  const { ensure } = keeperWith(async () => { runs += 1; });
  expect(await ensure("keyed", { ...a.renewal, env: { ...a.renewal.env, ANTHROPIC_API_KEY: "k" } })).toBe("fresh");
  expect(runs).toBe(0);
});

it("keeps watched accounts fresh in the background, renewing only those inside the renewal window", async () => {
  const near = account(Date.now() + 3 * 60_000);
  const far = account(Date.now() + 5 * HOUR);
  const ran: string[] = [];
  const { keeper, renew } = keeperWith(async (renewal) => { ran.push(renewal.env.CLAUDE_CONFIG_DIR!); near.save(Date.now() + 8 * HOUR); });
  const stopNear = keeper.watch("near", () => renew(near.renewal));
  const stopFar = keeper.watch("far", () => renew(far.renewal));
  await keeper.check();
  expect(ran).toEqual([near.config]);
  await keeper.check();
  expect(ran).toEqual([near.config]);
  stopNear();
  stopFar();
});

it("does nothing where the home does not lend sign-ins", async () => {
  const near = account(Date.now() + 60_000);
  let runs = 0;
  const keeper = createAccountKeeper({ enabled: () => false });
  const renew = (renewal: ClaudeAccountRenewal) => keepSignIn(claudeSignIn(renewal, async () => { runs += 1; }));
  const stop = keeper.watch("near", () => renew(near.renewal));
  await keeper.check();
  expect(await keeper.keep("near", () => renew(near.renewal))).toBe("fresh");
  expect(runs).toBe(0);
  stop();
});

it("asks the account's own CLI for a model the service refuses, from the account folder, so the CLI renews and saves before answering", async () => {
  const a = account(Date.now() - 60_000);
  const cli = join(a.base, "claude");
  const seen = join(a.base, "seen.txt");
  writeFileSync(cli, `#!/bin/sh\nprintf '%s\\n' "$*" "$CLAUDE_CONFIG_DIR" "$PWD" > ${JSON.stringify(seen)}\nexit 1\n`);
  chmodSync(cli, 0o755);
  await runClaudeSignInCheck({ ...a.renewal, command: cli });
  expect(readFileSync(seen, "utf8").trim().split("\n")).toEqual([CLAUDE_SIGN_IN_CHECK_ARGS.join(" "), a.config, a.config]);
  await runClaudeSignInCheck(a.renewal);
  expect(readSavedClaudeSignIn(a.file)).toEqual({ kind: "token", expiresAt: expect.any(Number), refreshable: true });
});
