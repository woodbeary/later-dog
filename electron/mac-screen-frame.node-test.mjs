import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createComputerSharing, validSharedOperation } from "./computer-sharing.mjs";
import { SCREEN_FRAME, screenFrameFrom } from "./shared-computer-access.mjs";

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64").toString("base64");

async function lendOnce(t, { work, hostControl, encodeFrame }) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "laterdog-mac-frame-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = path.join(dir, "driver-calls");
  const script = path.join(dir, "driver.mjs");
  await writeFile(script, `import readline from 'node:readline'; import fs from 'node:fs';
readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(!m.id)return;
if(m.method==='tools/call') fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(m.params)+'\\n');
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[]}:{content:[{type:'text',text:'state'},{type:'image',mimeType:'image/png',data:${JSON.stringify(PIXEL)}}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`);
  const sessionId = randomUUID();
  const environmentId = randomUUID();
  const env = { id: "fixture-workspace", name: "Fixture", origin: "https://workspace.test" };
  const json = value => ({ ok: true, status: 200, body: (async function* () { yield Buffer.from(JSON.stringify(value)); })() });
  const state = { connected: null, headers: null };
  let deliver;
  const delivered = new Promise(resolve => { deliver = resolve; });
  const queue = [work];
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === "/api/auth/session") return json({ kind: "session", id: sessionId });
    if (route === "/.well-known/laterdog/environment") return json({ environmentId, capabilities: { sharedComputers: true } });
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/shared-computers/connect") { state.connected = body; state.headers = init.headers; return json({}); }
    if (route.endsWith("/poll")) {
      const operation = queue.shift();
      if (!operation) throw new Error("fixture workspace has no more work");
      return json({ job: { id: randomUUID(), by: "Rex", operation: { computer_id: state.connected.id, ...operation } } });
    }
    if (route.endsWith("/lease")) return json({ active: true });
    if (route.endsWith("/result")) { deliver(body.result); return json({}); }
    if (route.endsWith("/disconnect")) return json({});
    throw new Error(`fixture workspace has no route ${route}`);
  };
  const shown = [];
  const activityFile = path.join(dir, "activity.jsonl");
  const sharing = createComputerSharing({
    file: path.join(dir, "profile", "computer-sharing.json"), fetch: fetchImpl, activityFile,
    environments: () => [env], enabled: async () => true,
    cuaConnection: async () => ({ mcpCommand: process.execPath, mcpArgs: [script] }),
    presence: { begin: showing => { shown.push(["begin", showing.operation.action]); }, end: () => { shown.push(["end"]); } },
    hostControl, encodeFrame,
  });
  t.after(() => sharing.close());
  const info = await sharing.identity(env);
  await sharing.save(env, { folders: [], terminal: false, computer: true }, info);
  const result = await delivered;
  await delay(30);
  return {
    result, shown, state,
    calls: async () => (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line)),
    activity: async () => (await readFile(activityFile, "utf8").catch(() => "")).split("\n").filter(Boolean),
  };
}

const gateFor = log => async () => { log.push("acquire"); return { renew: async () => {}, release: async () => { log.push("release"); } }; };

test("the Mac tells the server it can send live screen frames", async t => {
  const { state } = await lendOnce(t, { work: { action: SCREEN_FRAME }, hostControl: gateFor([]) });
  const header = Object.entries(state.headers ?? {}).find(([name]) => name.toLowerCase() === "x-laterdog-computer-actions")?.[1];
  assert.ok(String(header).split(",").includes(SCREEN_FRAME));
});

test("a screen frame job is a valid operation with nothing but the computer id", () => {
  const id = randomUUID();
  assert.equal(validSharedOperation({ computer_id: id, action: SCREEN_FRAME }, id), true);
});

test("a screen frame is captured by the driver, shrunk, and sent back as a picture", async t => {
  const gate = [];
  const encoded = [];
  const encodeFrame = async (data) => { encoded.push(data); return { data: "c21hbGw=", mime: "image/jpeg" }; };
  const { result, calls } = await lendOnce(t, { work: { action: SCREEN_FRAME }, hostControl: gateFor(gate), encodeFrame });
  assert.deepEqual(result, { png: "c21hbGw=", format: "jpeg" });
  assert.deepEqual(encoded, [PIXEL]);
  assert.deepEqual((await calls()).map(call => call.name), ["get_desktop_state"]);
  assert.deepEqual(gate, ["acquire", "release"]);
});

test("a screen frame never shows the dog on the Mac or lands in the Mac's activity list", async t => {
  const { shown, activity } = await lendOnce(t, { work: { action: SCREEN_FRAME }, hostControl: gateFor([]), encodeFrame: async () => ({ data: "eA==", mime: "image/jpeg" }) });
  assert.deepEqual(shown, []);
  assert.deepEqual(await activity(), []);
});

test("while the person holds the Mac, a screen frame is skipped before the driver is reached", async t => {
  const hostControl = async () => { throw new Error("This computer is in use locally or held by a person. Wait, then observe it again before acting."); };
  const { result, calls } = await lendOnce(t, { work: { action: SCREEN_FRAME }, hostControl });
  assert.equal(result.isError, true);
  assert.deepEqual(await calls(), []);
});

test("a frame comes from the first picture in the driver's answer", () => {
  assert.deepEqual(screenFrameFrom({ content: [{ type: "text", text: "x" }, { type: "image", mimeType: "image/png", data: "QQ==" }] }), { data: "QQ==", mime: "image/png" });
  assert.throws(() => screenFrameFrom({ content: [{ type: "text", text: "x" }] }), /no picture/);
});
