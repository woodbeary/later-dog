import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createAccountKeeper } from "./account-keeper.ts";
import { codexSignIn, grokSignIn, jwtExpiry, keepSignIn } from "./account-sign-ins.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const HOUR = 3600_000;
const folder = () => { const dir = realpathSync(mkdtempSync(join(tmpdir(), "laterdog-keep-"))); scratch.push(dir); return dir; };
const jwt = (expiresAt: number) => ["x", Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString("base64url"), "y"].join(".");

function codexAccount(expiresAt: number) {
  const home = folder();
  const save = (at: number, refresh = "refresh") => writeFileSync(join(home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: jwt(at), refresh_token: refresh, account_id: "acct" } }));
  save(expiresAt);
  return { env: { CODEX_HOME: home }, save, home };
}

it("reads a Codex access token's expiry without keeping its value anywhere", () => {
  const at = Date.now() + HOUR;
  expect(Math.abs(jwtExpiry(jwt(at))! - at)).toBeLessThan(1000);
  expect(jwtExpiry("not-a-token")).toBeNull();
});

it("renews a Codex login only inside the window and reports a renewed one", async () => {
  const fresh = codexAccount(Date.now() + 5 * HOUR);
  let runs = 0;
  expect(await keepSignIn(codexSignIn(fresh.env, async () => { runs += 1; }))).toBe("fresh");
  const near = codexAccount(Date.now() + 5 * 60_000);
  expect(await keepSignIn(codexSignIn(near.env, async () => { runs += 1; near.save(Date.now() + 10 * 24 * HOUR); }))).toBe("renewed");
  expect(runs).toBe(1);
});

it("reports a Codex login whose renewal left no tokens as signed out, and a failed renewal as unrenewed", async () => {
  const revoked = codexAccount(Date.now() - 60_000);
  expect(await keepSignIn(codexSignIn(revoked.env, async () => { writeFileSync(join(revoked.home, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: {} })); }))).toBe("signed-out");
  const down = codexAccount(Date.now() - 60_000);
  expect(await keepSignIn(codexSignIn(down.env, async () => { throw new Error("offline"); }))).toBe("unrenewed");
});

it("leaves a Codex account without a saved login or with an API key to its own status", async () => {
  const empty = folder();
  expect(await keepSignIn(codexSignIn({ CODEX_HOME: empty }, async () => { throw new Error("not called"); }))).toBe("fresh");
  writeFileSync(join(empty, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "k" }));
  expect(await keepSignIn(codexSignIn({ CODEX_HOME: empty }, async () => { throw new Error("not called"); }))).toBe("fresh");
});

it("renews a Grok login near expiry with the account's own CLI in a private copy", async () => {
  const home = folder();
  const grok = join(home, ".grok");
  mkdirSync(grok);
  const issuer = "https://auth.x.ai";
  writeFileSync(join(grok, "auth.json"), JSON.stringify({ [issuer]: { key: "old", refresh_token: "r", expires_at: Math.floor((Date.now() + 5 * 60_000) / 1000), user_id: "u" } }));
  const cli = join(home, "grok");
  writeFileSync(cli, `#!/bin/sh\nprintf '{"${issuer}":{"key":"new","refresh_token":"r2","expires_at":%s,"user_id":"u"}}' ${Math.floor((Date.now() + 6 * HOUR) / 1000)} > "$GROK_HOME/auth.json"\n`, { mode: 0o755 });
  expect(await keepSignIn(grokSignIn(cli, { HOME: home }))).toBe("renewed");
  expect(JSON.parse(readFileSync(join(grok, "auth.json"), "utf8"))[issuer].key).toBe("new");
  expect(await keepSignIn(grokSignIn(cli, { HOME: home }))).toBe("fresh");
});

it("checks every watched account on its schedule, one renewal per account at a time, and reports changes", async () => {
  const keeper = createAccountKeeper({ everyMs: 60_000 });
  const changes: string[] = [];
  keeper.onChange((id, outcome) => changes.push(`${id} ${outcome}`));
  let runs = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const stop = keeper.watch("grok", async () => { runs += 1; await held; return "signed-out"; });
  const first = keeper.check();
  const second = keeper.check();
  release();
  await Promise.all([first, second]);
  expect(runs).toBe(1);
  expect(keeper.signedOut("grok")).toBe(true);
  expect(changes).toEqual(["grok signed-out"]);
  stop();
  expect(keeper.signedOut("grok")).toBe(false);
});
