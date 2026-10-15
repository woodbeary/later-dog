import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAC_ACCOUNT_ROUTES, claudeStoreFrom, codexStoreFrom, createCloudAiAccounts, createMacKeychain, decodeKeychainText, homeOriginAllowed,
  loginFingerprint, parseAccountRecords, parseMacAccountSource, readSecretFile,
} from "./cloud-ai-accounts.mjs";

const claudeLogin = { accessToken: "fixture-claude-access-1", refreshToken: "fixture-claude-refresh-1", expiresAt: 1_900_000_000_000, scopes: ["user:inference"] };
const codexLogin = { auth_mode: "chatgpt", tokens: { id_token: "fixture-codex-id-1", access_token: "fixture-codex-access-1", refresh_token: "fixture-codex-refresh-1", account_id: "a" } };
const ITEM = { service: "Claude Code-credentials-d6b39fe8", account: "fixture.user" };

test("reads Claude's stored login as plain or hex JSON and refuses a dead one", () => {
  const text = JSON.stringify({ claudeAiOauth: claudeLogin, mcpOAuth: { kept: true } });
  assert.deepEqual(claudeStoreFrom(text).login, claudeLogin);
  assert.deepEqual(claudeStoreFrom(Buffer.from(text).toString("hex")).root.mcpOAuth, { kept: true });
  assert.equal(decodeKeychainText(` ${Buffer.from("{}").toString("hex")}\n`), "{}");
  assert.equal(claudeStoreFrom(JSON.stringify({ claudeAiOauth: { ...claudeLogin, refreshToken: "", accessToken: "", expiresAt: 0 } })).login, null);
  assert.equal(claudeStoreFrom("not json"), null);
  assert.deepEqual(codexStoreFrom(JSON.stringify(codexLogin)).login, codexLogin);
  assert.equal(codexStoreFrom(JSON.stringify({ OPENAI_API_KEY: "fixture" })).login, null);
  assert.equal(loginFingerprint("fixture-claude-refresh-1").length, 16);
});

test("only talks to this Mac's account routes and to a home over HTTPS", () => {
  assert.ok(MAC_ACCOUNT_ROUTES.test("/api/laterdog/mac-accounts"));
  assert.ok(MAC_ACCOUNT_ROUTES.test("/api/laterdog/mac-accounts/claude-0f6c5a52-8d1e-4c3b-9a7e-2b1d0c9e8f7a/hold"));
  for (const route of ["/api/laterdog/mac-accounts/chatgpt/hold", "/api/workspace-backup/export", "/api/laterdog/mac-accounts/../../x"]) assert.equal(MAC_ACCOUNT_ROUTES.test(route), false);
  assert.ok(homeOriginAllowed("https://home.fixture.test"));
  assert.ok(homeOriginAllowed("http://127.0.0.1:8123"));
  for (const origin of ["http://home.fixture.test", "https://home.fixture.test/path", "ftp://x", 7]) assert.equal(homeOriginAllowed(origin), false);
});

test("accepts only account sources it can move and only secret files it expects", () => {
  assert.equal(parseMacAccountSource({ instanceId: "claude", kind: "claude", displayName: "Claude", file: "/Users/f/.claude/.credentials.json", keychain: { service: "Claude Code-credentials", account: "f" } }).keychain.service, "Claude Code-credentials");
  assert.equal(parseMacAccountSource({ instanceId: "claude", kind: "claude", displayName: "Claude", file: "/etc/passwd" }), null);
  assert.equal(parseMacAccountSource({ instanceId: "codex", kind: "claude", displayName: "X", file: "/a/auth.json" }), null);
  assert.equal(parseMacAccountSource({ instanceId: "claude", kind: "claude", displayName: "C", file: "/a/.credentials.json", keychain: { service: "Other", account: "f" } }).keychain, undefined);
  assert.deepEqual(parseMacAccountSource({ instanceId: "chatgpt", kind: "chatgpt-plan", displayName: "ChatGPT plan" }), { instanceId: "chatgpt", kind: "chatgpt-plan", displayName: "ChatGPT plan" });
  assert.deepEqual(parseAccountRecords("{bad"), { origin: null, deviceId: null, accounts: {} });
  assert.deepEqual(parseAccountRecords({ origin: "https://h", deviceId: "a".repeat(32), accounts: { codex: { kind: "codex", name: "ChatGPT", source: "file", at: 5 }, evil: { kind: "codex", name: "x", source: "file" } } }).accounts, { codex: { kind: "codex", name: "ChatGPT", source: "file", origin: "https://h", at: 5 } });
});

test("reads the Keychain only through the system security tool, never through a shell, and has no way to write a login", async () => {
  const calls = [];
  const execFile = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null, args.includes("-w") ? "7b7d0a" : "attributes"); };
  const keychain = createMacKeychain({ execFile });
  assert.equal(await keychain.has(ITEM), true);
  assert.equal(await keychain.read(ITEM), "7b7d0a");
  assert.deepEqual(calls.map(call => [call.file, call.args, call.options.shell]), [
    ["/usr/bin/security", ["find-generic-password", "-a", "fixture.user", "-s", ITEM.service], false],
    ["/usr/bin/security", ["find-generic-password", "-a", "fixture.user", "-w", "-s", ITEM.service], false],
  ]);
  assert.equal(await keychain.read({ service: "Claude Code-credentials\"; rm -rf /", account: "x" }), null);
  assert.equal(keychain.write, undefined);
  assert.ok(calls.every(call => !call.args.some(arg => /add-generic-password|-X/.test(arg))));
});

test("a failed Keychain read gives nothing back, not an error with the output", async () => {
  const keychain = createMacKeychain({ execFile: (_file, _args, _options, callback) => callback(Object.assign(new Error("exit 36"), { stdout: "secret-looking" }), "") });
  assert.equal(await keychain.read(ITEM), null);
  assert.equal(await keychain.has(ITEM), false);
});

test("never follows a link when reading a secret file", async () => {
  const folder = mkdtempSync(join(tmpdir(), "laterdog-ai-accounts-"));
  try {
    writeFileSync(join(folder, "auth.json"), "{\"a\":1}");
    assert.equal(await readSecretFile(join(folder, "auth.json")), "{\"a\":1}");
    writeFileSync(join(folder, "elsewhere.json"), "{}");
    symlinkSync(join(folder, "elsewhere.json"), join(folder, ".credentials.json"));
    assert.equal(await readSecretFile(join(folder, ".credentials.json")), null);
    assert.equal(await readSecretFile(join(folder, "elsewhere.json")), null);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("keeps an account paused and keeps retrying while the home has not confirmed it, and does nothing once it has", async () => {
  const timers = [], delays = [], calls = [];
  let answer = 503, saved = null;
  const localRequest = async (route, init) => {
    calls.push(`${init.method} ${route}`);
    if (route === "/api/laterdog/mac-accounts") return Response.json({ accounts: [{ instanceId: "codex", kind: "codex", displayName: "ChatGPT", held: false, file: "/fixture/.codex/auth.json" }] });
    return Response.json({ held: true });
  };
  const accounts = createCloudAiAccounts({
    localRequest, readFile: async () => JSON.stringify(codexLogin), read: () => saved, write: contents => { saved = contents; },
    fetchImpl: async url => (String(url).endsWith("/api/auth/pair") ? Response.json({ token: "laterdog_sess_fixture" }) : String(url).includes("/api/auth/logout") ? new Response("{}") : answer === 200 ? Response.json({ signedIn: true }) : new Response("{}", { status: answer })),
    retryDelaysMs: [10, 20],
    setTimer: (callback, delay) => { timers.push(callback); delays.push(delay); return { unref() {} }; }, clearTimer: () => {},
  });
  const request = { homeOrigin: "https://home.fixture.test", session: async () => ({ origin: "https://home.fixture.test", code: "FIXT-URE0-CODE" }) };
  assert.deepEqual(await accounts.handAccountsToCloud(request), { moved: { claude: 0, chatgpt: 0 }, stayed: [], waiting: ["ChatGPT"] });
  for (let round = 0; round < 3; round++) { timers.shift()(); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.deepEqual(delays, [10, 20, 20, 20]);
  assert.ok(!calls.some(call => call.startsWith("DELETE")), "an unanswered hand-over never un-pauses the account");
  answer = 200;
  timers.shift()();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(timers.length, 0);
  assert.ok(JSON.parse(saved).accounts.codex);
  assert.equal(await accounts.handAccountsToCloud(request), null);
});

test("un-pauses an account only when the home refuses it", async () => {
  const calls = [];
  const localRequest = async (route, init) => {
    calls.push(`${init.method} ${route}`);
    if (route === "/api/laterdog/mac-accounts") return Response.json({ accounts: [{ instanceId: "codex", kind: "codex", displayName: "ChatGPT", held: false, file: "/fixture/.codex/auth.json" }] });
    return Response.json({ held: init.method === "PUT" });
  };
  const accounts = createCloudAiAccounts({
    localRequest, readFile: async () => JSON.stringify(codexLogin), read: () => null, write: () => {},
    fetchImpl: async url => (String(url).endsWith("/api/auth/pair") ? Response.json({ token: "laterdog_sess_fixture" }) : String(url).includes("/api/auth/logout") ? new Response("{}") : Response.json({ code: "other_device" }, { status: 409 })),
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  const summary = await accounts.handAccountsToCloud({ homeOrigin: "https://home.fixture.test", session: async () => ({ origin: "https://home.fixture.test", code: "FIXT-URE0-CODE" }) });
  assert.deepEqual(summary, { moved: { claude: 0, chatgpt: 0 }, stayed: [{ name: "ChatGPT", why: "refused" }], waiting: [] });
  assert.deepEqual(calls.slice(-2), ["PUT /api/laterdog/mac-accounts/codex/hold", "DELETE /api/laterdog/mac-accounts/codex/hold"]);
});

test("will not move accounts recorded for another home to this one", async () => {
  const localRequest = async (route, init) => route === "/api/laterdog/mac-accounts"
    ? Response.json({ accounts: [{ instanceId: "codex", kind: "codex", displayName: "ChatGPT", held: true, file: "/fixture/.codex/auth.json" }] })
    : Response.json({ held: true, method: init.method });
  let reached = false;
  const accounts = createCloudAiAccounts({
    localRequest, readFile: async () => JSON.stringify(codexLogin), write: () => {},
    read: () => JSON.stringify({ origin: "https://old.fixture.test", deviceId: "a".repeat(32), accounts: { codex: { kind: "codex", name: "ChatGPT", source: "file", at: 1 } } }),
    fetchImpl: async () => { reached = true; return new Response("{}", { status: 500 }); },
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  const summary = await accounts.handAccountsToCloud({ homeOrigin: "https://home.fixture.test", session: async () => ({ origin: "https://home.fixture.test", code: "x" }) });
  assert.deepEqual(summary, { moved: { claude: 0, chatgpt: 0 }, stayed: [{ name: "ChatGPT", why: "elsewhere" }], waiting: [] });
  assert.equal(reached, false);
});
