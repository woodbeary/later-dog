import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAC_ACCOUNT_ROUTES, claudeStoreFrom, codexStoreFrom, createCloudAiAccounts, createMacKeychain, decodeKeychainText, homeOriginAllowed,
  loginFingerprint, parseAccountRecords, parseMacAccountSource, readSecretFile, writeSecretFile,
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
  assert.deepEqual(parseAccountRecords("{bad"), { origin: null, accounts: {} });
  assert.deepEqual(parseAccountRecords({ origin: "https://h", accounts: { codex: { kind: "codex", name: "ChatGPT", source: "file", at: 5 }, evil: { kind: "codex", name: "x", source: "file" } } }).accounts, { codex: { kind: "codex", name: "ChatGPT", source: "file", at: 5 } });
});

test("reads the Keychain only through the system security tool, never through a shell, and keeps the login off the command line", async () => {
  const calls = [], spawned = [];
  const execFile = (file, args, options, callback) => { calls.push({ file, args, options }); callback(null, args.includes("-w") ? "7b7d0a" : "attributes"); };
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdin = { end: input => { spawned.push({ file, args, options, input }); setImmediate(() => child.emit("exit", 0)); } };
    child.kill = () => {};
    return child;
  };
  const keychain = createMacKeychain({ execFile, spawn });
  assert.equal(await keychain.has(ITEM), true);
  assert.equal(await keychain.read(ITEM), "7b7d0a");
  assert.deepEqual(calls.map(call => [call.file, call.args, call.options.shell]), [
    ["/usr/bin/security", ["find-generic-password", "-a", "fixture.user", "-s", ITEM.service], false],
    ["/usr/bin/security", ["find-generic-password", "-a", "fixture.user", "-w", "-s", ITEM.service], false],
  ]);
  await keychain.write(ITEM, JSON.stringify({ claudeAiOauth: claudeLogin }));
  assert.deepEqual(spawned[0].args, ["-i"]);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].input, `add-generic-password -U -a "fixture.user" -s "${ITEM.service}" -X "${Buffer.from(JSON.stringify({ claudeAiOauth: claudeLogin })).toString("hex")}"\n`);
  assert.equal(await keychain.read({ service: "Claude Code-credentials\"; rm -rf /", account: "x" }), null);
  await assert.rejects(keychain.write({ service: "Other", account: "x" }, "{}"));
});

test("a failed Keychain read gives nothing back, not an error with the output", async () => {
  const keychain = createMacKeychain({ execFile: (_file, _args, _options, callback) => callback(Object.assign(new Error("exit 36"), { stdout: "secret-looking" }), "") });
  assert.equal(await keychain.read(ITEM), null);
  assert.equal(await keychain.has(ITEM), false);
});

test("writes a secret file privately and atomically, and never follows a link when reading", async () => {
  const folder = mkdtempSync(join(tmpdir(), "laterdog-ai-accounts-"));
  try {
    const file = join(folder, "codex", "auth.json");
    await writeSecretFile(file, "{\"a\":1}");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(folder, "codex")).mode & 0o777, 0o700);
    assert.equal(await readSecretFile(file), "{\"a\":1}");
    writeFileSync(join(folder, "elsewhere.json"), "{}");
    symlinkSync(join(folder, "elsewhere.json"), join(folder, ".credentials.json"));
    assert.equal(await readSecretFile(join(folder, ".credentials.json")), null);
    assert.equal(await readSecretFile(join(folder, "elsewhere.json")), null);
    await assert.rejects(writeSecretFile(join(folder, "notes.txt"), "x"));
    await writeSecretFile(join(folder, ".credentials.json"), "{\"b\":2}");
    assert.equal(readFileSync(join(folder, "elsewhere.json"), "utf8"), "{}", "replacing a link replaces the link, not what it points at");
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("does nothing more once every account has moved, and waits for the person after the last retry", async () => {
  const timers = [];
  let listings = 0;
  const localRequest = async route => {
    if (route === "/api/laterdog/mac-accounts") { listings++; return Response.json({ accounts: [{ instanceId: "codex", kind: "codex", displayName: "ChatGPT", held: false, file: "/fixture/.codex/auth.json" }] }); }
    return Response.json({ held: true });
  };
  const accounts = createCloudAiAccounts({
    localRequest, readFile: async () => JSON.stringify(codexLogin), read: () => null, write: () => {},
    fetchImpl: async () => new Response("{}", { status: 503 }), retryDelaysMs: [10],
    setTimer: callback => { timers.push(callback); return { unref() {} }; }, clearTimer: () => {},
  });
  const destination = { origin: "https://home.fixture.test", grant: async () => ({ origin: "https://home.fixture.test", code: "FIXT-URE0-CODE" }) };
  assert.deepEqual(await accounts.ensure(destination), { moved: { claude: 0, chatgpt: 0 }, stayed: [], waiting: ["ChatGPT"] });
  assert.equal(timers.length, 1);
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  await accounts.ensure(destination);
  assert.equal(timers.length, 0);
  assert.equal(await accounts.ensure(destination), null);
  assert.equal(listings, 2);
});
