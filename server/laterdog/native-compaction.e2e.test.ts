import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { request } from "../../scripts/mcp-server.ts";
import { waitForExit } from "../testing/cleanup.ts";

const LONG_CHAT = { FAKE_CLAUDE_VERSION: "2.1.316", FAKE_CLAUDE_CONTEXT_TOKENS: "190000", FAKE_CLAUDE_CONTEXT_WINDOW: "200000", FAKE_CLAUDE_COMPACT: "1" };
const jsonl = (path: string) => existsSync(path)
  ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];

async function fixture(test: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, fakeEnv: NodeJS.ProcessEnv = LONG_CHAT) {
  const f = await setup(fakeEnv);
  try { await test(f); } finally { await f.close(); }
}

async function setup(fakeEnv: NodeJS.ProcessEnv) {
  const env = { ...process.env, ...fakeEnv };
  const session = await launchVerificationServer(env, undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
  let ready = false;
  try {
    let restarted: ChildProcess | undefined;
    const dataDir = session.info.dataDir;
    const api = async (path: string, body?: unknown, method = "POST") =>
      await request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as any;
    const cli = async (...args: string[]) => await runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as any;
    const restart = async (beforeLaunch?: () => void) => {
      await waitForExit(restarted ?? session.child, { signal: "SIGTERM" });
      beforeLaunch?.();
      const log = openSync(session.info.logPath, "a", 0o600);
      restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
        cwd: process.cwd(), env: verificationServerEnvironment(env, dataDir, Number(new URL(session.info.url).port)), stdio: ["ignore", log, log],
      });
      closeSync(log);
      await expect.poll(async () => {
        try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
      }, { timeout: 20_000 }).toBe(true);
    };
    const plan = join(dataDir, "room-plan.json");
    const codexPrompts = join(dataDir, "codex-prompts.jsonl");
    await restart(() => {
      const path = join(dataDir, "config.json");
      const config = JSON.parse(readFileSync(path, "utf8"));
      config.instances.claudeWork = {
        driver: "claudeAgent", displayName: "Work fixture",
        config: { cli: config.instances.claude.config.cli, configDir: join(dataDir, "providers", "claude-work") },
        environment: { FAKE_CLAUDE_ROOM_PLAN: plan },
      };
      config.instances.codex.environment = {
        FAKE_CODEX_MODE: "resume", FAKE_CODEX_PROMPTS: codexPrompts, FAKE_CODEX_COMPACT: "1", FAKE_CODEX_CONTEXT_TOKENS: "250000",
      };
      writeFileSync(path, JSON.stringify(config));
    });
    const bot = (await cli("new-bot", "--name", "Long chat")).bot;
    const thread = bot.activeTaskId;
    writeFileSync(plan, JSON.stringify({ [bot.id]: { reply: "Acknowledged" } }));
    const messages = async () => (await api(`/api/threads/${thread}/messages`)).messages as any[];
    const task = () => JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"))
      .find((b: any) => b.id === bot.id).tasks.find((t: any) => t.threadId === thread);
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "40")).status).toBe("settled");
    };
    const use = async (instanceId: string, model?: string) => {
      const chosen = model ?? (await cli("models")).instances.find((item: any) => item.instanceId === instanceId).models.options[0].id;
      await api(`/api/bots/${bot.id}/tasks/${thread}`, { modelSelection: { instanceId, model: chosen } }, "PATCH");
    };
    const folds = async () => (await messages()).filter(m => m.kind === "compaction");
    const nativeRows = async () => (await messages()).filter(m => m.kind === "activity" && m.tool?.compaction);
    ready = true;
    return {
      session, api, cli, bot, thread, messages, task, send, use, folds, nativeRows, restart,
      turns: () => jsonl(`${plan}.evidence.jsonl`),
      codexPrompts: () => jsonl(codexPrompts).map((entry: any) => String(entry.text)),
      launchArgs: () => JSON.parse(readFileSync(session.fixtureDumpPath, "utf8")).argv as string[],
      close: async () => {
        try { if (restarted) await waitForExit(restarted, { signal: "SIGTERM" }); } finally { await session.close(); }
      },
    };
  } finally { if (!ready) await session.close(); }
}

const padded = (label: string) => `${label} ${"context ".repeat(40)}`;

it("lets Claude Code compact a long chat itself, keeps the session across a restart and records the compaction", () => fixture(async f => {
  await f.use("claude", "claude-sonnet-4-6");
  for (const label of ["FIRST request", "SECOND request", "THIRD request", "FOURTH request"]) await f.send(label);
  expect(f.task().usage.context).toMatchObject({ tokens: 190_000, window: 200_000 });
  expect(await f.folds()).toHaveLength(0);
  const argv = f.launchArgs();
  expect(argv[argv.indexOf("--autocompact") + 1]).toBe("auto");
  const session = f.task().resumeCursors.claude;
  expect(session).toBeTruthy();
  const prompts = f.turns().map((turn: any) => String(turn.prompt.message.content));
  expect(prompts.slice(1).some(prompt => prompt.includes("FIRST request"))).toBe(false);
  expect(prompts.join("\n")).not.toContain("Earlier conversation summary");
  const rows = await f.nativeRows();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.at(-1).tool).toMatchObject({ name: "context compaction (auto)", ok: true, compaction: true });

  await f.restart();
  await f.send("AFTER_RESTART carry on");
  expect(await f.folds()).toHaveLength(0);
  expect(f.task().resumeCursors.claude).toBe(session);
  const relaunch = f.launchArgs();
  expect(relaunch[relaunch.indexOf("--resume") + 1]).toBe(session);
  expect(String(f.turns().at(-1).prompt.message.content)).not.toContain("FIRST request");
  const texts = (await f.messages()).filter(m => m.kind === "text" && m.role === "user").map(m => m.text);
  expect(texts).toEqual(["FIRST request", "SECOND request", "THIRD request", "FOURTH request", "AFTER_RESTART carry on"]);
}), 120_000);

it("keeps the old fold at 80% of the window when the server setting turns harness compaction off", () => fixture(async f => {
  await f.api("/api/config", { context: { harnessCompaction: false } }, "PATCH");
  await f.use("claude", "claude-sonnet-4-6");
  for (const label of ["FIRST request", "SECOND request", "THIRD request", "FOURTH request"]) await f.send(label);
  expect(await f.folds()).toHaveLength(1);
  expect((await f.folds())[0].compaction.by).toBe("harness");
}), 120_000);

it("summarises the older part once when an account switch has to rebuild a chat that no longer fits", () => fixture(async f => {
  await f.api("/api/config", { context: { rebuildBytes: 1_024 } }, "PATCH");
  await f.use("claude", "claude-sonnet-4-6");
  for (const label of ["OLDEST_DECISION use port 9001", "SECOND request", "THIRD request", "FOURTH request"]) await f.send(padded(label));
  expect(await f.folds()).toHaveLength(0);
  const first = f.task().resumeCursors.claude;
  await f.use("claudeWork", "claude-sonnet-4-6");
  await f.send("SWITCHED which port?");
  const folds = await f.folds();
  expect(folds).toHaveLength(1);
  expect(folds[0].compaction.summary).toContain("OLDEST_DECISION");
  const turn = f.turns().at(-1);
  expect(String(turn.prompt.message.content)).toContain("Earlier conversation summary");
  expect(String(turn.prompt.message.content)).toContain("SWITCHED which port?");
  expect(f.task().resumeCursors.claudeWork).toBeTruthy();
  expect(f.task().resumeCursors.claudeWork).not.toBe(first);
  const rebuilt = f.task().resumeCursors.claudeWork;
  await f.send("NEXT on the same account");
  expect(await f.folds()).toHaveLength(1);
  expect(f.task().resumeCursors.claudeWork).toBe(rebuilt);
  expect(String(f.turns().at(-1).prompt.message.content)).not.toContain("Earlier conversation summary");
  expect(String(f.turns().at(-1).prompt.message.content)).not.toContain("SWITCHED which port?");
}), 120_000);

it("does not summarise when an account switch can replay the whole chat", () => fixture(async f => {
  await f.use("claude", "claude-sonnet-4-6");
  for (const label of ["FIRST short", "SECOND short"]) await f.send(label);
  await f.use("claudeWork", "claude-sonnet-4-6");
  await f.send("SWITCHED short");
  expect(await f.folds()).toHaveLength(0);
  const prompt = String(f.turns().at(-1).prompt.message.content);
  expect(prompt).toContain("FIRST short");
  expect(prompt).not.toContain("Earlier conversation summary");
}), 120_000);

it("moves a long chat from Claude to Codex with one summary, then lets Codex compact and keeps its thread", () => fixture(async f => {
  await f.api("/api/config", { context: { rebuildBytes: 1_024 } }, "PATCH");
  await f.use("claude", "claude-sonnet-4-6");
  for (const label of ["OLDEST_DECISION use port 9001", "SECOND request", "THIRD request", "FOURTH request"]) await f.send(padded(label));
  await f.use("codex");
  await f.send("ON_CODEX which port?");
  expect(await f.folds()).toHaveLength(1);
  expect(f.codexPrompts().at(-1)).toContain("Earlier conversation summary");
  const thread = f.task().resumeCursors.codex;
  expect(thread).toBeTruthy();
  const rowsBefore = (await f.nativeRows()).length;
  await f.send("CODEX_SECOND carry on");
  await f.send("CODEX_THIRD carry on");
  expect(f.task().usage.context).toMatchObject({ tokens: 250_000, window: 272_000 });
  expect(await f.folds()).toHaveLength(1);
  expect(f.task().resumeCursors.codex).toBe(thread);
  expect(f.codexPrompts().at(-1)).not.toContain("Earlier conversation summary");
  expect(f.codexPrompts().at(-1)).not.toContain("OLDEST_DECISION");
  const rows = await f.nativeRows();
  expect(rows.length).toBeGreaterThan(rowsBefore);
  expect(rows.at(-1).tool).toMatchObject({ ok: true, compaction: true });
  expect(rows.at(-1).tool.name).toMatch(/^context compaction/);
}), 150_000);

