import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { request } from "../../scripts/mcp-server.ts";
import { waitForExit } from "../testing/cleanup.ts";

const jsonLines = (path: string): any[] => existsSync(path)
  ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
const scope = { threadId: "codex-thread-1", turnId: "turn-1" };
const used = (id: number, extra = {}) => ({ method: "item/completed", params: { ...scope, ...extra, item: {
  id: `tool-${id}`, type: ["commandExecution", "fileChange", "mcpToolCall", "webSearch"][id % 4],
  status: "completed", aggregatedOutput: `command ${id}`, exitCode: 0,
  changes: [{ path: `file-${id}`, diff: `change ${id}` }], result: { text: `mcp ${id}` }, action: { query: `search ${id}` },
} } });
const tools = (count: number) => Array.from({ length: count }, (_, id) => used(id + 1));
const tokens = (count: number) => ({ method: "thread/tokenUsage/updated", params: { ...scope,
  tokenUsage: { total: { inputTokens: count, outputTokens: 0 }, last: { inputTokens: count }, modelContextWindow: 272000 },
} });

async function fixture(events: unknown[], test: (f: any) => Promise<void>) {
  const parentEnv = { FAKE_CLAUDE_ROOM_MS: "120000" };
  const session = await launchVerificationServer(parentEnv, undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
  const { dataDir, url, logPath } = session.info;
  const gate = join(dataDir, "finish-codex");
  const callsPath = join(dataDir, "codex-calls.jsonl");
  const api = (path: string, body?: unknown, method = "POST") => request(path,
    body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  const cli = (...args: string[]) => runControlLaterDog(args, { env: { LATERDOG_URL: url } }) as Promise<any>;
  let server: ReturnType<typeof spawn> | undefined;
  try {
    await waitForExit(session.child, { signal: "SIGTERM" });
    const configPath = join(dataDir, "config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.codex.environment = { FAKE_CODEX_MODE: "review-events", FAKE_CODEX_REVIEW_EVENTS: JSON.stringify([...events, { method: "item/completed", params: { ...scope, item: { id: "batch-done", type: "agentMessage", text: "Provider tool batch received" } } }]),
      FAKE_CODEX_FINISH_GATE: gate, FAKE_CODEX_CALLS_LOG: callsPath };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment(parentEnv, dataDir, Number(new URL(url).port)), stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health")).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const chief = (await cli("new-bot", "--name", "Budget coordinator", "--section", "Leadership")).bot;
    const lead = (await cli("new-bot", "--name", "Budget helper", "--section", "Engineering")).bot;
    await api(`/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true }, "PATCH");
    await api(`/api/bots/${lead.id}/tasks/${lead.activeTaskId}`, { modelSelection: { instanceId: "codex", model: "gpt-fake-default" } }, "PATCH");
    writeFileSync(join(dataDir, "room-plan.json"), JSON.stringify({
      [chief.id]: { steps: [{ arguments: { bot_ids: [lead.id], message: "Do the bounded work" } }], reply: "Assigned", resumeReply: "Checked the result" },
    }));
    const calls = () => jsonLines(callsPath);
    const notices = () => calls().filter(call => call.method === "turn/steer");
    const messages = (bot = lead) => api(`/api/threads/${bot.activeTaskId}/messages?limit=200`).then(result => result.messages);
    const start = async () => {
      await cli("send", "--bot", chief.id, "--task", chief.activeTaskId, "--text", "Have Engineering do the bounded work");
      await expect.poll(() => calls().filter(call => call.method === "turn/start").length).toBe(1);
    };
    const ready = (count = 1) => expect.poll(async () => (await messages()).filter((row: any) => row.text === "Provider tool batch received").length).toBe(count);
    await test({ api, cli, chief, lead, gate, calls, notices, messages, start, ready });
  } finally {
    writeFileSync(gate, "finish");
    await waitForExit(server, { signal: "SIGTERM" });
    writeFileSync(`${logPath}.codex-helper-budget.json`, JSON.stringify({ url, events, calls: jsonLines(callsPath) }, null, 2));
    await session.close();
  }
}

it("steers a coordinated Codex helper at 80 and 90 unique completed tools, ignoring duplicate and foreign events", () => fixture([
  ...tools(79), ...tools(79),
  ...Array.from({ length: 20 }, (_, id) => used(1000 + id, { turnId: "old-turn" })),
  ...Array.from({ length: 20 }, (_, id) => used(2000 + id, { threadId: "foreign-thread" })),
  { method: "turn/completed", params: { threadId: "codex-thread-1", turn: { id: "old-turn", status: "completed" } } },
  ...tools(95).slice(79),
], async f => {
  await f.start();
  await expect.poll(() => f.notices().length).toBe(2);
  expect(f.notices().map((call: any) => /made (\d+) tool calls/.exec(call.params.input[0].text)?.[1])).toEqual(["80", "90"]);
  for (const call of f.notices()) expect(call.params).toEqual({ threadId: "codex-thread-1", expectedTurnId: "turn-1",
    input: [{ type: "text", text: expect.stringContaining("partly done: what is finished, what is left and where things are") }] });
  expect((await f.messages()).filter((row: any) => /partly done/.test(row.text ?? ""))).toEqual([]);
  expect((await f.messages()).filter((row: any) => row.card)).toEqual([]);
  writeFileSync(f.gate, "finish");
  expect((await f.cli("wait", "--bot", f.chief.id, "--task", f.chief.activeTaskId, "--timeout", "40")).status).toBe("settled");
  expect(f.notices()).toHaveLength(2);
}), 90_000);

it("steers at the 160000-token context boundary and keeps the ten-tool reminder interval", () => fixture([
  tokens(159_999), used(1), tokens(160_000), ...tools(12).slice(1),
], async f => {
  await f.start();
  await expect.poll(() => f.notices().length).toBe(2);
  expect(f.notices().map((call: any) => /made (\d+) tool calls/.exec(call.params.input[0].text)?.[1])).toEqual(["2", "12"]);
  expect(f.notices()[0].params.input[0].text).toContain("160K tokens of context");
}), 90_000);

it.each([false, true])("leaves owner Codex turns alone when main=%s", main => fixture([...tools(95), tokens(200_000)], async f => {
  if (main) expect((await f.api("/api/main-dog", { botId: f.lead.id }, "PATCH")).mainDogId).toBe(f.lead.id);
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "Work directly for the owner");
  await f.ready();
  expect(f.notices()).toEqual([]);
  writeFileSync(f.gate, "finish");
  expect((await f.cli("wait", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--timeout", "40")).status).toBe("settled");
  expect(f.notices()).toEqual([]);
}), 90_000);

it("keeps a helper's notice out of an owner replacement turn after cancellation", () => fixture(tools(95), async f => {
  await f.start();
  await f.ready();
  expect(f.notices()).toHaveLength(2);
  const originalPid = f.notices()[0].pid;
  await f.cli("interrupt", "--bot", f.lead.id, "--task", f.lead.activeTaskId);
  expect((await f.cli("wait", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--timeout", "40")).status).toBe("settled");
  await f.cli("send", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--text", "The owner starts a new task here");
  await f.ready(2);
  const starts = f.calls().filter((call: any) => call.method === "turn/start");
  expect(starts).toHaveLength(2);
  expect(starts[1].pid).not.toBe(originalPid);
  expect(f.notices()).toHaveLength(2);
  expect(f.notices().every((call: any) => call.pid === originalPid)).toBe(true);
  writeFileSync(f.gate, "finish");
  expect((await f.cli("wait", "--bot", f.lead.id, "--task", f.lead.activeTaskId, "--timeout", "40")).status).toBe("settled");
  expect(f.notices()).toHaveLength(2);
}), 90_000);
