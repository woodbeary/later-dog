import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("lets a Full-access dog move another dog to Recently deleted and back with no card, keeping its chats and memory, and never the main dog or itself", async () => {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const plans: Record<string, { turns: any[] }> = {};
  const evidence: unknown[] = [];
  const guardedRoutes = new Map<string, string>();
  let restarted: ChildProcess | undefined;
  const providerTurns = (): any[] => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const api = async (method: string, path: string, body?: unknown, status = 200, token?: string) => {
    const response = await fetch(`${url}${path}`, { method,
      headers: { "content-type": "application/json", origin: url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result });
    return result;
  };
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  const bots = async () => (await api("GET", "/api/bots")).bots as any[];
  const messages = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const unanswered = async (threadId: string) => (await messages(threadId)).filter(message => message.card && !message.card.answered && !message.card.dismissed);
  const step = (tool: string, args: unknown, expectError = false) => ({ tool, arguments: args, expectError });
  const run = async (bot: any, threadId: string, text: string, steps: any[], options: { pending?: boolean; resumeReply?: string; guarded?: "ask" | "full" } = {}) => {
    const before = providerTurns().length;
    const reply = `Fixture result ${before}: ${text}`;
    (plans[bot.id] ??= { turns: [] }).turns.push({ steps, reply });
    if (options.resumeReply) plans[bot.id].turns.push({ reply: options.resumeReply });
    writeFileSync(planPath, JSON.stringify(plans));
    const guardedInput = options.guarded ? { threadId, text, sendId: randomUUID(), expectedApprovalMode: options.guarded,
      expectedActiveLeafId: (await api("GET", `/api/threads/${threadId}/messages?limit=1`)).activeLeafId } : undefined;
    const accepted = guardedInput ? await api("POST", `/api/bots/${bot.id}/messages/guarded`, guardedInput, 202)
      : await cli("send", "--bot", bot.id, "--task", threadId, "--text", text);
    const expectedTurns = options.resumeReply ? 3 : 1;
    await expect.poll(() => providerTurns().length, { timeout: 25_000 }).toBe(before + expectedTurns);
    expect((await cli("wait", "--bot", bot.id, "--task", threadId, "--timeout", "25")).status).toBe(options.pending ? "needs-user" : "settled");
    const turns = providerTurns().slice(before);
    const caller = turns.find(turn => turn.botId === bot.id);
    expect(caller.threadId).toBe(threadId);
    expect(caller.evidence.filter((entry: any) => entry.step), JSON.stringify(caller.evidence.filter((entry: any) => entry.step || entry.error)).slice(0, 1500)).toHaveLength(steps.length);
    for (const [index, call] of caller.evidence.filter((entry: any) => entry.step).entries()) {
      expect(Boolean(call.response.error || call.response.result?.isError)).toBe(Boolean(steps[index].expectError));
    }
    expect((await messages(threadId)).filter(message => message.role === "bot" && message.text === reply)).toHaveLength(1);
    if (!options.pending) expect(await unanswered(threadId)).toHaveLength(0);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(providerTurns()).toHaveLength(before + expectedTurns);
    if (guardedInput) {
      const route = `/api/bots/${bot.id}/requests/${guardedInput.sendId}?threadId=${threadId}`;
      guardedRoutes.set(threadId, route);
      const snapshot = await api("GET", route);
      expect(snapshot).toMatchObject({ messageId: accepted.message.id, phase: options.pending ? "waiting" : "settled" });
      expect(snapshot.messages.filter((message: any) => message.turnTerminal).every((message: any) => message.requestMessageId === accepted.message.id)).toBe(true);
      expect((await api("POST", `/api/bots/${bot.id}/messages/guarded`, guardedInput, 202)).message.id).toBe(accepted.message.id);
      expect(providerTurns()).toHaveLength(before + expectedTurns);
    }
    return caller;
  };
  const restart = async () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"].includes(key.toUpperCase()) && value) env[key.toUpperCase()] = value;
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, LATERDOG_HOME: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      LATERDOG_SERVER_PORT: new URL(url).port, LATERDOG_WEBHOOK_PORT: String(Number(new URL(url).port) + 1), PATH: dirname(process.execPath),
      FAKE_CLAUDE_MODE: "happy", FAKE_CLAUDE_DUMP: fixture.fixtureDumpPath,
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      expect(restarted?.exitCode, `see ${logPath}`).toBeNull();
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
  };
  try {
    const main = (await cli("new-bot", "--name", "Mainly", "--section", "Operations")).bot;
    await api("PATCH", `/api/bots/${main.id}`, { chiefOfStaff: true });
    const caller = (await cli("new-bot", "--name", "Clive", "--section", "Operations")).bot;
    const target = (await cli("new-bot", "--name", "Biscuit", "--section", "Research")).bot;
    await run(target, target.activeTaskId, "remember the kettle", []);
    const before = (await messages(target.activeTaskId)).map((message) => message.id);
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const memoryFile = join(dataDir, "workspaces", target.id, "MEMORY.md");
    writeFileSync(memoryFile, "# Memory\n\n- The kettle is blue.\n");
    const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8"));
    for (const bot of saved.filter((entry: any) => entry.id === caller.id)) {
      bot.approvalMode = "full"; bot.autoApprove = false;
      for (const task of bot.tasks ?? []) { task.approvalMode = "full"; task.autoApprove = false; }
    }
    writeFileSync(join(dataDir, "bots.json"), JSON.stringify(saved, null, 2));
    await restart();
    const mainId = (await bots()).find((bot) => bot.chiefOfStaff)?.id ?? main.id;

    await run(caller, caller.activeTaskId, "delete Biscuit", [
      step("delete_bot", { bot_id: target.id }),
      step("delete_bot", { bot_id: caller.id }, true),
      step("delete_bot", { bot_id: mainId }, true),
      step("delete_bot", { bot_id: target.id }, true),
    ]);
    const rested = (await bots()).find((bot) => bot.id === target.id);
    expect(rested).toMatchObject({ hidden: true });
    expect((await bots()).find((bot) => bot.id === caller.id)).toBeDefined();
    expect((await bots()).find((bot) => bot.id === mainId)).toBeDefined();
    expect((await messages(target.activeTaskId)).map((message) => message.id)).toEqual(before);
    expect(readFileSync(memoryFile, "utf8")).toContain("The kettle is blue.");

    await run(caller, caller.activeTaskId, "bring Biscuit back", [step("restore_bot", {}), step("restore_bot", { name_or_id: "biscuit" }), step("restore_bot", { name_or_id: "biscuit" }, true)]);
    const back = (await bots()).find((bot) => bot.id === target.id);
    expect(back?.hidden).toBeFalsy();
    expect((await messages(target.activeTaskId)).map((message) => message.id)).toEqual(before);
    expect(readFileSync(memoryFile, "utf8")).toContain("The kettle is blue.");
    const plan = providerTurns().find((turn) => turn.botId === caller.id && turn.evidence.some((entry: any) => entry.step?.tool === "restore_bot"));
    expect(JSON.stringify(plan.evidence)).toContain("Biscuit");
  } finally {
    if (restarted) await waitForExit(restarted, { signal: "SIGTERM" });
    else await waitForExit(fixture.child, { signal: "SIGTERM" });
  }
}, 180_000);
