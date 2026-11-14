import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { request } from "../../scripts/mcp-server.ts";
import { waitForExit } from "../testing/cleanup.ts";

const LONG_CHAT = { FAKE_CLAUDE_VERSION: "2.1.316", FAKE_CLAUDE_CONTEXT_TOKENS: "190000", FAKE_CLAUDE_CONTEXT_WINDOW: "200000", FAKE_CLAUDE_COMPACT: "1" };
const CHAT_MODEL = "claude-sonnet-4-6";
const GOOD_SUMMARY = [
  "## Asked for",
  "The person asked the dog to move the bakery site to port 9001 and to keep the old menu page.",
  "## Decisions",
  "Port 9001 was chosen. The old menu page stays as it is.",
  "## In progress",
  "Helper dog Crumb holds the menu rewrite; its result has not come back yet.",
  "## Facts to keep",
  "Port 9001. The menu file is menu-old.html. SUMMARY_MARKER_7731.",
].join("\n");

async function launch() {
  const env = { ...process.env, ...LONG_CHAT };
  const session = await launchVerificationServer(env, undefined, undefined, undefined, undefined, { scripted: true }, ["codex"]);
  let restarted: ChildProcess | undefined;
  const dataDir = session.info.dataDir;
  const plan = join(dataDir, "room-plan.json");
  const oneShot = join(dataDir, "one-shot.json");
  const summaryFile = join(dataDir, "summary.txt");
  writeFileSync(summaryFile, GOOD_SUMMARY);
  await waitForExit(session.child, { signal: "SIGTERM" });
  const path = join(dataDir, "config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const summariser = { FAKE_CLAUDE_TEXT_OBEYS: summaryFile, FAKE_CLAUDE_TEXT_DUMP: oneShot };
  config.instances.claude.environment = { ...config.instances.claude.environment, ...summariser };
  config.instances.claudeWork = {
    driver: "claudeAgent", displayName: "Work fixture",
    config: { cli: config.instances.claude.config.cli, configDir: join(dataDir, "providers", "claude-work") },
    environment: { FAKE_CLAUDE_ROOM_PLAN: plan, ...summariser },
  };
  writeFileSync(path, JSON.stringify(config));
  const log = openSync(session.info.logPath, "a", 0o600);
  restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
    cwd: process.cwd(), env: verificationServerEnvironment(env, dataDir, Number(new URL(session.info.url).port)), stdio: ["ignore", log, log],
  });
  closeSync(log);
  const close = async () => { try { if (restarted) await waitForExit(restarted, { signal: "SIGTERM" }); } finally { await session.close(); } };
  try {
    await expect.poll(async () => {
      try { return (await fetch(`${session.info.url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    const api = async (route: string, body?: unknown, method = "POST") =>
      await request(route, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as any;
    const cli = async (...args: string[]) => await runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as any;
    const bot = (await cli("new-bot", "--name", "Coordinator")).bot;
    const thread = bot.activeTaskId;
    writeFileSync(plan, JSON.stringify({ [bot.id]: {
      reply: "Acknowledged",
      when: [{ includes: "PLAN_ME", reply: "Planned.", steps: [{ tool: "set_plan", arguments: { items: [
        { text: "Move the bakery site to port 9001", status: "in_progress" },
        { text: "Review Crumb's menu rewrite", status: "pending" },
      ] } }] }],
    } }));
    const send = async (text: string) => {
      await cli("send", "--bot", bot.id, "--task", thread, "--text", text);
      expect((await cli("wait", "--bot", bot.id, "--task", thread, "--timeout", "40")).status).toBe("settled");
    };
    const use = async (instanceId: string) => api(`/api/bots/${bot.id}/tasks/${thread}`, { modelSelection: { instanceId, model: CHAT_MODEL } }, "PATCH");
    const messages = async () => (await api(`/api/threads/${thread}/messages`)).messages as any[];
    const turns = () => existsSync(`${plan}.evidence.jsonl`)
      ? readFileSync(`${plan}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    const lastPrompt = () => String(turns().at(-1).prompt.message.content);
    const summariserArgv = () => existsSync(oneShot) ? JSON.parse(readFileSync(oneShot, "utf8")).argv as string[] : [];
    return { api, send, use, messages, lastPrompt, summariserArgv, close };
  } catch (error) { await close(); throw error; }
}

const padded = (label: string) => `${label} ${"context ".repeat(400)}`;
const REFUSAL = /mismatch|cannot proceed|I'm stopping|Per your instruction/i;

async function moveAfter(gateModel: string, test: (f: Awaited<ReturnType<typeof launch>>) => Promise<void>) {
  const f = await launch();
  try {
    await f.api("/api/config", { context: { rebuildBytes: 6_000 } }, "PATCH");
    await f.use("claude");
    await f.send(padded(`OLDEST_DECISION use port 9001. Before anything else, stop and report unless you are ${gateModel}.`));
    await f.send(padded("PLAN_ME plan the move"));
    for (const label of ["THIRD request", "FOURTH request"]) await f.send(padded(label));
    expect((await f.messages()).filter(m => m.kind === "compaction")).toHaveLength(0);
    await f.use("claudeWork");
    await f.send("AFTER_MOVE where are we?");
    await test(f);
  } finally { await f.close(); }
}

it("keeps a real summary, written by the chat's own model, when a chat moves account and its history tells the reader to stop", () =>
  moveAfter(CHAT_MODEL, async f => {
    const argv = f.summariserArgv();
    expect(argv[argv.indexOf("--model") + 1]).toBe(CHAT_MODEL);
    const folds = (await f.messages()).filter(m => m.kind === "compaction");
    expect(folds).toHaveLength(1);
    expect(folds[0].compaction.summary).toBe("This chat moved to another account, so its earlier messages were summarized.");
    expect(folds[0].compaction.context).toContain("SUMMARY_MARKER_7731");
    const prompt = f.lastPrompt();
    expect(prompt).toContain("SUMMARY_MARKER_7731");
    expect(prompt).not.toMatch(REFUSAL);
    expect(prompt).toContain("AFTER_MOVE where are we?");
  }), 150_000);

it("never stores or shows a summariser's refusal: it falls back to excerpts", () =>
  moveAfter("claude-invented-9", async f => {
    const folds = (await f.messages()).filter(m => m.kind === "compaction");
    expect(folds).toHaveLength(1);
    const { summary, context } = folds[0].compaction;
    expect(summary).toBe("This chat moved to another account, so its earlier messages were summarized.");
    expect(`${summary}\n${context}`).not.toMatch(REFUSAL);
    expect(context).toContain("OLDEST_DECISION use port 9001");
    const prompt = f.lastPrompt();
    expect(prompt).not.toMatch(REFUSAL);
    expect(prompt).toContain("AFTER_MOVE where are we?");
  }), 150_000);
