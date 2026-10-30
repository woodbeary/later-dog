import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment, type VerificationServer } from "../scripts/control-laterdog.ts";
import { SessionRegistry } from "./sessions.ts";
import { waitForExit } from "./testing/cleanup.ts";

const key = "isolated-trust-capability";
let fixture: VerificationServer;
let child: ChildProcess;
let broker: Server;
let admin: string;
let member: string;
let fullBot: any;
let brokerOrigin = "";
const relayed: unknown[] = [];
const evidence: unknown[] = [];
let blockSession: (() => void) | undefined;
let sessionEntered = false;
const api = async (method: string, path: string, body?: unknown, token = admin) => {
  const response = await fetch(fixture.info.url + path, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
  });
  const result = { status: response.status, body: await response.json() as any };
  evidence.push({ method, path, result });
  return result;
};
const bot = async (name: string) => {
  const created = await api("POST", "/api/bots", { name });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body.bot;
};
const mint = async (botId: string, threadId: string, kind = "connectors") => {
  const response = await fetch(fixture.info.url + "/api/testing/internal-capability", {
    method: "POST", headers: { "content-type": "application/json", "x-laterdog-test-capability": key },
    body: JSON.stringify({ botId, threadId, kind }),
  });
  expect(response.status).toBe(201);
  return (await response.json() as any).token as string;
};
const relay = (token: string, name: string, args: unknown = {}) => api("POST", "/api/internal/connectors/mcp",
  { jsonrpc: "2.0", id: Math.random(), method: "tools/call", params: { name, arguments: args } }, token);
const cards = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).body.messages as any[];
const pending = async (thread: string) => {
  let card: any;
  await expect.poll(async () => {
    card = (await cards(thread)).findLast((row: any) => row.card?.outboundRequest && !row.card.answered);
    return Boolean(card);
  }, { timeout: 5_000 }).toBe(true);
  return card;
};

beforeAll(async () => {
  broker = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/connectors/connected") return res.end(JSON.stringify({ services: { gmail: { connected: true }, slack: { connected: true } } }));
    if (req.url === "/api/tool_router/session/fixture-session") {
      if (blockSession) {
        sessionEntered = true;
        await new Promise<void>(resolve => { blockSession = resolve; });
      }
      return res.end(JSON.stringify({ session_id: "fixture-session", mcp: { type: "http", url: brokerOrigin + "/mcp" },
        config: { user_id: "fixture-user", multi_account: { enable: true, max_accounts_per_toolkit: 5, require_explicit_selection: true } } }));
    }
    if (req.url === "/mcp") {
      relayed.push(body);
      return res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "relay-ok" }] } }));
    }
    return res.end(JSON.stringify({ items: [{ slug: "gmail", connected_account: { id: "fixture-account", status: "ACTIVE" } }] }));
  });
  await new Promise<void>(resolve => broker.listen(0, "127.0.0.1", resolve));
  const address = broker.address() as { port: number };
  brokerOrigin = `http://127.0.0.1:${address.port}`;
  fixture = await launchVerificationServer();
  const created = await fetch(fixture.info.url + "/api/bots", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Existing Full grant" }) });
  expect(created.status).toBe(201);
  fullBot = (await created.json() as any).bot;
  await waitForExit(fixture.child, { signal: "SIGTERM" });
  const botsFile = join(fixture.info.dataDir, "bots.json");
  const bots = JSON.parse(readFileSync(botsFile, "utf8"));
  const saved = bots.find((row: any) => row.id === fullBot.id);
  saved.approvalMode = "full";
  saved.autoApprove = false;
  for (const task of saved.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
  writeFileSync(botsFile, JSON.stringify(bots));
  const configFile = join(fixture.info.dataDir, "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.signIn = { admins: ["admin@fixture.test"], members: ["member@fixture.test"] };
  config.composio = { apiKey: "ak_isolated_fixture", userId: "fixture-user", sessionId: "fixture-session" };
  config.instances.activityFixture = { ...config.instances.claude, displayName: "Exact task activity fixture",
    environment: { FAKE_CLAUDE_MODE: "hang", FAKE_CLAUDE_RELEASE: join(fixture.info.dataDir, "activity-release") } };
  writeFileSync(configFile, JSON.stringify(config));
  const sessions = new SessionRegistry({ file: join(fixture.info.dataDir, "sessions.json"),
    emailScopes: email => email === "admin@fixture.test" ? ["admin", "client"] : ["client"] });
  admin = sessions.issue({ label: "isolated admin", email: "admin@fixture.test", scopes: ["admin", "client"] }).token;
  member = sessions.issue({ label: "isolated member", email: "member@fixture.test", scopes: ["client"] }).token;
  sessions.close();
  const log = openSync(fixture.info.logPath, "a", 0o600);
  child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...verificationServerEnvironment({}, fixture.info.dataDir, Number(new URL(fixture.info.url).port)),
      LATERDOG_TEST_INTERNAL_CAPABILITY_KEY: key, LATERDOG_COMPOSIO_API: brokerOrigin + "/api", LATERDOG_COMPOSIO_TOOLKITS_API: brokerOrigin + "/api" },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { if ((await fetch(fixture.info.url + "/api/health")).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("isolated trust server did not start");
}, 40_000);

afterAll(async () => {
  blockSession?.();
  const evidencePath = fixture.info.logPath + ".trust-controls.json";
  writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence, relayed }, null, 2));
  await waitForExit(child, { signal: "SIGTERM" });
  await fixture.close();
  await new Promise<void>(resolve => broker.close(() => resolve()));
  console.info(JSON.stringify({ logPath: fixture.info.logPath, evidencePath, fixtureRemoved: !existsSync(fixture.info.dataDir) }));
});

it("keeps activity and policy changes admin-only", async () => {
  const b = await bot("Trust authority");
  expect((await api("GET", `/api/bots/${b.id}/activity`)).status).toBe(200);
  expect((await api("GET", `/api/bots/${b.id}/activity`, undefined, member)).status).toBe(403);
  for (const patch of [{ alwaysAllow: ["connector:gmail"] }, { composio: false }, { fallback: [] }]) {
    expect((await api("PATCH", `/api/bots/${b.id}`, patch, member)).status).toBe(403);
  }
  expect((await api("PATCH", `/api/bots/${b.id}`, { fallback: [{ instanceId: "claude", model: " " }] })).status).toBe(400);
});

it("asks in Full, refuses skipped sends, and rechecks connected apps after an approval", async () => {
  const b = fullBot;
  const fleet = await api("GET", "/api/bots");
  expect(fleet.body.bots.find((row: any) => row.id === b.id).approvalMode).toBe("full");
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const denied = relay(token, "GMAIL_SEND_DRAFT", { draft_id: "fixture" });
  let card = await pending(b.threadId);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await denied).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
  const held = relay(token, "SLACK_SEND_MESSAGE");
  card = await pending(b.threadId);
  await api("PATCH", `/api/bots/${b.id}`, { composio: false });
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
});

it("shows each outbound batch recipient and amount with explicit preview truncation before consent", async () => {
  const b = await bot("Batch consent preview");
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const held = relay(token, "COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [
    { tool_slug: "GMAIL_SEND_EMAIL", arguments: { to: "first@fixture.test", body: "x".repeat(450) } },
    { tool_slug: "STRIPE_CREATE_REFUND", arguments: { recipient: "second@fixture.test", amount: 42 } },
  ] });
  const card = await pending(b.threadId);
  expect(card.card.subtitle).toContain("first@fixture.test");
  expect(card.card.subtitle).toContain("second@fixture.test");
  expect(card.card.subtitle).toContain('"amount":42');
  expect(card.card.subtitle).toContain("[arguments truncated]");
  expect(card.card.outboundRequest).toEqual({
    tool: "GMAIL_SEND_EMAIL",
    app: "Gmail",
    calls: [{ app: "Gmail", label: "Send email" }, { app: "Stripe", label: "Create refund" }],
  });
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
});

it.each(["apps", "turn"])("rechecks %s revocation after project-session metadata and before the actual send", async (revocation) => {
  const b = await bot("Session race " + revocation);
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const held = relay(token, "GMAIL_SEND_EMAIL");
  const card = await pending(b.threadId);
  sessionEntered = false;
  blockSession = () => {};
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  await expect.poll(() => sessionEntered, { timeout: 5_000 }).toBe(true);
  if (revocation === "apps") await api("PATCH", `/api/bots/${b.id}`, { composio: false });
  else await mint(b.id, b.threadId);
  blockSession();
  blockSession = undefined;
  const result = await held;
  if (revocation === "apps") expect(result.body.result.isError).toBe(true);
  else expect(result.status).toBe(401);
  expect(relayed).toHaveLength(before);
});

it("asks once per connector, remembers Always allow for it, and keeps a skip until the next message", async () => {
  const b = await bot("Connector memory");
  let token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const first = relay(token, "GMAIL_SEND_EMAIL", { to: "first@fixture.test" });
  const card = await pending(b.threadId);
  expect(card.card).toMatchObject({ title: "Allow Gmail?", allowKey: "connector:gmail", heldCode: "approval.held.outbound" });
  expect((await api("POST", `/api/bots/${b.id}/always-allow`, { threadId: b.threadId, allowKey: "connector:gmail" })).status).toBe(200);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow", scope: "always" });
  expect((await first).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 1);
  expect((await cards(b.threadId)).find((row: any) => row.id === card.id).card).toMatchObject({ answered: "allow", answerScope: "always" });
  const cardsBefore = (await cards(b.threadId)).filter((row: any) => row.card?.outboundRequest).length;
  expect((await relay(token, "GMAIL_SEND_EMAIL", { to: "second@fixture.test" })).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 2);
  expect((await cards(b.threadId)).filter((row: any) => row.card?.outboundRequest)).toHaveLength(cardsBefore);
  const slack = relay(token, "SLACK_SEND_MESSAGE", { channel: "#fixture" });
  const slackCard = await pending(b.threadId);
  expect(slackCard.card).toMatchObject({ title: "Allow Slack?", allowKey: "connector:slack" });
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: slackCard.card.requestId, behavior: "deny" });
  expect((await slack).body.result.content[0].text).toContain("skipped");
  const again = await relay(token, "SLACK_SEND_MESSAGE", { channel: "#fixture" });
  expect(again.body.result.isError).toBe(true);
  expect(again.body.result.content[0].text).toContain("until their next message");
  expect(relayed).toHaveLength(before + 2);
  token = await mint(b.id, b.threadId);
  const nextTurn = relay(token, "SLACK_SEND_MESSAGE", { channel: "#fixture" });
  const nextCard = await pending(b.threadId);
  expect(nextCard.id).not.toBe(slackCard.id);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: nextCard.card.requestId, behavior: "deny" });
  expect((await nextTurn).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before + 2);
  const state = (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === b.id);
  expect(state).not.toHaveProperty("outbound");
  expect(state).not.toHaveProperty("connectorScopes");
});

it("lets one Allow cover that app until the next message, then asks again", async () => {
  const b = await bot("Connector turn");
  let token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const first = relay(token, "GMAIL_SEND_EMAIL", { to: "first@fixture.test" });
  const card = await pending(b.threadId);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
  expect((await first).body.result.isError).not.toBe(true);
  const cardsBefore = (await cards(b.threadId)).filter((row: any) => row.card?.outboundRequest).length;
  expect((await relay(token, "GMAIL_SEND_EMAIL", { to: "second@fixture.test" })).body.result.isError).not.toBe(true);
  expect(relayed).toHaveLength(before + 2);
  expect((await cards(b.threadId)).filter((row: any) => row.card?.outboundRequest)).toHaveLength(cardsBefore);
  token = await mint(b.id, b.threadId);
  const nextTurn = relay(token, "GMAIL_SEND_EMAIL", { to: "third@fixture.test" });
  const nextCard = await pending(b.threadId);
  expect(nextCard.id).not.toBe(card.id);
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: nextCard.card.requestId, behavior: "deny" });
  expect((await nextTurn).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before + 2);
});

it("always asks before running workbench code, even when the connector is always allowed", async () => {
  const b = await bot("Opaque code");
  await api("PATCH", `/api/bots/${b.id}`, { alwaysAllow: ["connector:gmail"] });
  const token = await mint(b.id, b.threadId);
  const before = relayed.length;
  const held = relay(token, "COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: 'for x in range(99): run_tool("GMAIL_" + "SEND_EMAIL", {})' });
  const card = await pending(b.threadId);
  expect(card.card.title).toBe("Send on your behalf?");
  expect(card.card.allowKey).toBeUndefined();
  await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "deny" });
  expect((await held).body.result.isError).toBe(true);
  expect(relayed).toHaveLength(before);
});

it("settles only the source task after approval or Stop, leaving the selected sibling unchanged", async () => {
  for (const stop of [true, false]) {
    const b = await bot("Task activity " + stop);
    await api("PATCH", `/api/bots/${b.id}/tasks/${b.threadId}`, { modelSelection: { instanceId: "activityFixture", model: "claude-sonnet-5" } });
    const sibling = await api("POST", `/api/bots/${b.id}/tasks`, { title: "Selected idle sibling" });
    const siblingId = sibling.body.task.threadId;
    expect((await api("POST", `/api/bots/${b.id}/messages`, { text: "WAIT_FOR_ACTIVITY_FIXTURE", threadId: b.threadId })).status).toBe(202);
    const state = async () => (await api("GET", "/api/bots")).body.bots.find((row: any) => row.id === b.id);
    await expect.poll(async () => (await state()).tasks.find((row: any) => row.threadId === b.threadId).busy).toBe(true);
    const token = await mint(b.id, b.threadId);
    const held = relay(token, "GMAIL_SEND_EMAIL");
    const card = await pending(b.threadId);
    expect((await state()).tasks.find((row: any) => row.threadId === b.threadId).activity).toBe("waiting-on-you");
    expect((await state()).tasks.find((row: any) => row.threadId === siblingId).busy).toBe(false);
    if (stop) await api("POST", `/api/bots/${b.id}/interrupt`, { threadId: b.threadId });
    await api("POST", `/api/threads/${b.threadId}/respond`, { requestId: card.card.requestId, behavior: "allow" });
    const response = await held;
    if (stop) expect(response.status).toBe(401);
    else {
      expect(response.body.result.isError).not.toBe(true);
      writeFileSync(join(fixture.info.dataDir, "activity-release"), "fixture completion");
    }
    await expect.poll(async () => (await state()).activity, { timeout: 8_000 }).toBe("idle");
    expect((await state()).tasks.find((row: any) => row.threadId === siblingId)).toMatchObject({ busy: false, activity: "idle" });
  }
});

it("keeps a referenced account's credential directory, and removes the account from fallback chains when it is deleted", async () => {
  const account = await api("POST", "/api/instances/claude-accounts", { displayName: "Fallback fixture account" });
  expect(account.status, JSON.stringify(account.body)).toBe(201);
  const instanceId = account.body.instanceId;
  const b = await bot("Referenced fallback");
  expect((await api("PATCH", `/api/bots/${b.id}`, { fallback: [{ instanceId, model: "claude-sonnet-5" }] })).status).toBe(200);
  expect((await api("PATCH", `/api/instances/${instanceId}`, { configDir: join(fixture.info.dataDir, "synthetic-account-directory") })).status).toBe(409);
  expect((await api("DELETE", `/api/instances/${instanceId}`)).status).toBe(200);
  expect(((await api("GET", "/api/bots")).body.bots as any[]).find((row) => row.id === b.id).fallback ?? []).toEqual([]);
});
