import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAccountKeeper, createSignInRoutes, due, grokRenewalCommand, jwtExpiry, keeperRenewing, keptAccounts, readCodexSignIn, readGrokSignIn, type KeptAccount, type SavedSignIn } from "./account-keeper.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const folder = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-keeper-"))); scratch.push(dir); return dir; };
const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString("base64url")}.y`;
const HOUR = 60 * 60_000;

function fake(saved: SavedSignIn | null, renew?: (account: { saved: SavedSignIn | null }) => void, extra: Partial<KeptAccount> = {}) {
  const box = { saved, calls: 0 };
  const account: KeptAccount = {
    instanceId: "a", kind: "codex", handedOver: false, read: () => box.saved,
    ...(renew ? { renew: async () => { box.calls += 1; renew(box); } } : {}),
    ...extra,
  };
  return { box, account };
}

it("renews an account ahead of expiry on the schedule, not only when a turn runs", async () => {
  let now = 1_000_000_000_000;
  const { box, account } = fake({ expiresAt: now + HOUR, refreshable: true }, b => { b.saved = { expiresAt: now + 10 * HOUR, refreshable: true }; }, { renewsEarly: true });
  const keeper = createAccountKeeper({ accounts: () => [account], now: () => now });
  await keeper.check();
  expect(box.calls).toBe(1);
  expect(keeper.status()[0]).toMatchObject({ state: "renewed", failures: 0, renewedAt: now });
  now += 10 * 60_000;
  await keeper.check();
  expect(box.calls).toBe(1);
});

it("leaves a sign-in with plenty of time alone", async () => {
  const now = 1_000_000_000_000;
  const { box, account } = fake({ expiresAt: now + 5 * HOUR, refreshable: true }, () => {});
  const keeper = createAccountKeeper({ accounts: () => [account], now: () => now });
  await keeper.check();
  expect(box.calls).toBe(0);
  expect(keeper.status()[0]?.state).toBe("fresh");
});

it("counts an account signed out only on the second failed renewal of an expired sign-in", async () => {
  let now = 1_000_000_000_000;
  const { box, account } = fake({ expiresAt: now - 1, refreshable: true }, () => {}, { kind: "grok" });
  const changes: string[] = [];
  const keeper = createAccountKeeper({ accounts: () => [account], now: () => now, retryMs: 1000 });
  keeper.onChange(id => changes.push(`${id}:${keeper.status()[0]?.state}`));
  await keeper.check();
  expect(keeper.status()[0]).toMatchObject({ state: "failing", failures: 1 });
  expect(keeper.signedOut("a")).toBe(false);
  await keeper.check();
  expect(box.calls).toBe(1);
  now += 1001;
  await keeper.check();
  expect(box.calls).toBe(2);
  expect(keeper.status()[0]).toMatchObject({ state: "signed-out", failures: 2 });
  expect(keeper.signedOut("a")).toBe(true);
  expect(changes).toEqual(["a:failing", "a:signed-out"]);
});

it("does not count an early renewal the engine declined as a failure", async () => {
  const now = 1_000_000_000_000;
  const { box, account } = fake({ expiresAt: now + HOUR, refreshable: true }, () => {}, { kind: "grok" });
  const keeper = createAccountKeeper({ accounts: () => [account], now: () => now });
  await keeper.check();
  expect(box.calls).toBe(1);
  expect(keeper.status()[0]).toMatchObject({ state: "fresh", failures: 0 });
});

it("runs one renewal at a time for an account when the schedule and an engine ask together", async () => {
  const now = 1_000_000_000_000;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const box = { saved: { expiresAt: now + HOUR, refreshable: true } as SavedSignIn };
  const account: KeptAccount = { instanceId: "a", kind: "codex", handedOver: false, renewsEarly: true, read: () => box.saved,
    renew: async () => { calls += 1; await gate; box.saved = { expiresAt: now + 9 * HOUR, refreshable: true }; } };
  const keeper = createAccountKeeper({ accounts: () => [account], now: () => now });
  const both = Promise.all([keeper.check(), keeper.renew("a"), keeper.renew("a")]);
  release();
  await both;
  expect(calls).toBe(1);
  expect(keeper.status()[0]?.state).toBe("renewed");
});

it("explains a handed-over account that keeps failing and never signs out a Claude account by itself", async () => {
  const now = 1_000_000_000_000;
  const { account } = fake({ expiresAt: now - 1, refreshable: true }, undefined, { kind: "claude", handedOver: true });
  const keeper = createAccountKeeper({ accounts: () => [account], now: () => now });
  await keeper.check();
  expect(keeper.status()[0]?.state).toBe("signed-out");
  expect(keeper.status()[0]?.reason).toMatch(/came from a Mac/);
  expect(keeper.signedOut("a")).toBe(false);
});

it("reads Codex and Grok sign-ins without exposing them and renews by age", () => {
  const now = Date.now();
  const home = folder();
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date(now - 8 * 24 * HOUR).toISOString(), tokens: { access_token: jwt(now + 48 * HOUR), refresh_token: "r", account_id: "acct" } }));
  const codex = readCodexSignIn(home)!;
  expect(codex.refreshable).toBe(true);
  expect(Math.abs(codex.expiresAt! - (now + 48 * HOUR))).toBeLessThan(1000);
  expect(due(codex, now)).toBe(true);
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "k" }));
  expect(readCodexSignIn(home)).toBeNull();
  const grok = join(home, "grok.json");
  writeFileSync(grok, JSON.stringify({ "https://auth.x.ai": { key: "k", expires_at: Math.floor(now / 1000) + 60, refresh_token: "r" } }));
  expect(readGrokSignIn(grok)).toMatchObject({ refreshable: true });
  expect(jwtExpiry("not-a-jwt")).toBeNull();
});

it("finds every engine account it keeps and skips held, managed, API and disabled ones", () => {
  const data = folder();
  mkdirSync(join(data, "providers", "claude-x"), { recursive: true });
  writeFileSync(join(data, "providers", "claude-x", "handoff.json"), "{}");
  const accounts = keptAccounts({
    "claude-x": { driver: "claudeAgent", config: { configDir: join(data, "providers", "claude-x") } },
    claude: { driver: "claudeAgent" },
    codex: { driver: "codex", environment: { CODEX_HOME: join(data, "c") } },
    plan: { driver: "codex", config: { authMode: "chatgpt-plan" } },
    grok: { driver: "grokAgent", environment: { GROK_HOME: join(data, "g") } },
    api: { driver: "claudeAgent", access: "api" },
    off: { driver: "codex", enabled: false },
    managed: { driver: "codex", config: { managed: { url: "x" } } },
  }, id => id === "claude", data, { HOME: data });
  expect(accounts.map(a => [a.instanceId, a.kind, a.handedOver])).toEqual([["claude-x", "claude", true], ["codex", "codex", false], ["grok", "grok", false]]);
});

it("renews a Codex sign-in through the engine's own account read with a forced refresh", async () => {
  const data = folder();
  const home = join(data, "codex");
  mkdirSync(home);
  const now = Date.now();
  writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", last_refresh: new Date(now - HOUR).toISOString(), tokens: { access_token: jwt(now + 30 * 60_000), refresh_token: "r", account_id: "acct" } }));
  const cli = join(data, "codex-cli");
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path");
const file = path.join(process.env.CODEX_HOME, "auth.json");
let buf = ""; process.stdin.on("data", c => { buf += c; let i; while ((i = buf.indexOf("\\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
  if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");
  if (m.id === 2) { if (m.params.refreshToken) { const a = JSON.parse(fs.readFileSync(file, "utf8")); const exp = Math.floor(Date.now() / 1000) + 864000;
    a.tokens.access_token = "x." + Buffer.from(JSON.stringify({ exp })).toString("base64url") + ".y"; a.last_refresh = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(a)); fs.appendFileSync(path.join(process.env.CODEX_HOME, "calls"), "r"); }
    process.stdout.write(JSON.stringify({ id: 2, result: { account: { type: "chatgpt", email: "a@b.co" } } }) + "\\n"); } } });
`);
  chmodSync(cli, 0o755);
  const accounts = keptAccounts({ codex: { driver: "codex", config: { cli }, environment: { CODEX_HOME: home } } }, () => false, data, { ...process.env, HOME: data });
  const keeper = createAccountKeeper({ accounts: () => accounts });
  await Promise.all([keeper.check(), keeper.renew("codex")]);
  expect(readFileSync(join(home, "calls"), "utf8")).toBe("r");
  expect(keeper.status()[0]).toMatchObject({ instanceId: "codex", state: "renewed", failures: 0 });
  expect(readCodexSignIn(home)!.expiresAt! - Date.now()).toBeGreaterThan(9 * 24 * HOUR);
}, 20_000);

it("renews a Grok sign-in that is about to expire through the engine's own refresh in a private copy", async () => {
  const data = folder();
  const grokHome = join(data, "grok");
  mkdirSync(grokHome, { mode: 0o700 });
  const now = Date.now();
  const file = join(grokHome, "auth.json");
  writeFileSync(file, JSON.stringify({ "https://auth.x.ai": { key: "old", expires_at: Math.floor((now + 30 * 60_000) / 1000), refresh_token: "r", user_id: "u" } }), { mode: 0o600 });
  const bin = join(data, "bin");
  mkdirSync(bin);
  const cli = join(bin, "grok");
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require("node:fs"); const path = require("node:path");
const file = path.join(process.env.GROK_HOME, "auth.json"); const a = JSON.parse(fs.readFileSync(file, "utf8"));
const e = a["https://auth.x.ai"]; e.key = "new"; e.expires_at = Math.floor(Date.now() / 1000) + 6 * 3600; fs.writeFileSync(file, JSON.stringify(a));
`);
  chmodSync(cli, 0o755);
  const accounts = keptAccounts({ grok: { driver: "grokAgent", config: { cli }, environment: { GROK_HOME: grokHome } } }, () => false, data, { ...process.env, HOME: data });
  const keeper = createAccountKeeper({ accounts: () => accounts });
  await keeper.check();
  expect(keeper.status()[0]).toMatchObject({ instanceId: "grok", state: "renewed" });
  const saved = JSON.parse(readFileSync(file, "utf8"))["https://auth.x.ai"];
  expect(saved.key).toBe("new");
  expect(saved.user_id).toBe("u");
}, 20_000);

it("only reads sign-ins while renewals are switched off", async () => {
  const now = 1_000_000_000_000;
  let on = false;
  const { box, account } = fake({ expiresAt: now + HOUR, refreshable: true }, b => { b.saved = { expiresAt: now + 9 * HOUR, refreshable: true }; }, { renewsEarly: true });
  const keeper = createAccountKeeper({ accounts: () => [account], now: () => now, renewing: () => on });
  await keeper.check();
  expect(box.calls).toBe(0);
  expect(keeper.status()[0]).toMatchObject({ state: "fresh", expiresAt: now + HOUR });
  on = true;
  await keeper.check();
  expect(box.calls).toBe(1);
  expect(keeper.status()[0]?.state).toBe("renewed");
});

it("switches renewals with the owner's route and stays read-only for others", async () => {
  const data = folder();
  const file = join(data, "providers", "account-keeper.json");
  const keeper = createAccountKeeper({ accounts: () => [], renewing: () => keeperRenewing(file) });
  const route = createSignInRoutes({ keeper, file, allowed: auth => (auth as { owner?: boolean }).owner === true });
  const call = async (method: string, owner: boolean, body?: unknown) => {
    const out: { status?: number; body?: unknown } = {};
    const res = { setHeader() {} } as never;
    await route({ req: { headers: { "content-type": "application/json" } } as never, res, url: new URL("http://x/api/laterdog/sign-ins"), path: "/api/laterdog/sign-ins", method,
      auth: { owner } as never, json: ((_: unknown, status: number, value: unknown) => { out.status = status; out.body = value; }) as never, readBody: (async () => body) as never });
    return out;
  };
  expect((await call("GET", false)).status).toBe(403);
  expect(await call("GET", true)).toEqual({ status: 200, body: { renewing: false, accounts: [] } });
  expect((await call("PUT", true, { renew: "yes" })).status).toBe(400);
  expect(await call("PUT", true, { renew: true })).toEqual({ status: 200, body: { renewing: true, accounts: [] } });
  expect(keeperRenewing(file)).toBe(true);
  const renew = async (id: string) => {
    const out: { status?: number } = {};
    await route({ req: { headers: {} } as never, res: { setHeader() {} } as never, url: new URL(`http://x/api/laterdog/sign-ins/${id}/renew`), path: `/api/laterdog/sign-ins/${id}/renew`, method: "POST",
      auth: { owner: true } as never, json: ((_: unknown, status: number) => { out.status = status; }) as never, readBody: (async () => null) as never });
    return out.status;
  };
  expect(await renew("nobody")).toBe(404);
});

it("renews Grok with the account's own command, without its profile flags", () => {
  expect(grokRenewalCommand("grok")).toBe('"grok"');
  expect(grokRenewalCommand("/opt/grok --agent-profile work")).toBe('"/opt/grok"');
  expect(grokRenewalCommand('"/opt/x y/grok" --agent-profile=work')).toBe('"/opt/x y/grok"');
  expect(grokRenewalCommand("node /data/grok.js")).toBe('"node" "/data/grok.js"');
});
