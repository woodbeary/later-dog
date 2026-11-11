import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

interface WaitingRow {
  threadId: string;
  queueId: string;
  sendId: string;
}

it.skipIf(process.platform === "win32")("after a real restart, cancels a message still waiting by the sender's own id: it is never delivered, the one beside it goes once, and sending it again is refused", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
    });
    const result = await response.json() as any;
    if (method !== "GET") evidence.push({ method, path, body, status: response.status, result });
    expect(response.status, JSON.stringify(result)).toBe(status);
    return result;
  };
  const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).messages as any[];
  const prompts = (thread: string): any[] => {
    try { return readFileSync(join(dataDir, `${thread}.prompts`), "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const journal = () => {
    const db = new DatabaseSync(join(dataDir, "messages.db"), { readOnly: true });
    try { return db.prepare("SELECT id, send_id, status FROM chat_followups ORDER BY rowid").all(); }
    finally { db.close(); }
  };
  const restart = async () => {
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      expect(restarted?.exitCode, `see ${logPath}`).toBeNull();
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
  };
  try {
    const wrapper = join(dataDir, "gated-claude.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { basename, join } from "node:path";',
      'const thread = basename(process.cwd());',
      `const home = ${JSON.stringify(dataDir)};`,
      'process.env.FAKE_CLAUDE_MODE = "slow";',
      'process.env.FAKE_CLAUDE_SLOW_FINISH_GATE = join(home, thread + ".gate");',
      'process.env.FAKE_CLAUDE_PROMPTS = join(home, thread + ".prompts");',
      'process.stdin.on("end", () => process.exit(0));',
      `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../testing/fake-claude-cli.ts", import.meta.url))).href)});`,
    ].join("\n"), { mode: 0o700 });
    await api("PATCH", "/api/instances/claude", { cli: wrapper });
    await api("PATCH", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
    const bot = (await api("POST", "/api/bots", { name: "Waiting through a restart" }, 201)).bot;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Waits for a free slot" }, 201)).task;
    const threads = [bot.threadId, task.threadId];
    const promptsSeen = () => threads.reduce((count, thread) => count + prompts(thread).length, 0);

    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Hold the dog before the restart", threadId: bot.threadId }, 202);
    await expect.poll(promptsSeen, { timeout: 15_000 }).toBe(1);
    const behindTheTurn = { text: "Queued behind the running turn before the restart", threadId: bot.threadId, sendId: "restart_same_chat_send_123456", deliver: "queue" };
    const forASlot = { text: "Queued for a free slot before the restart", threadId: task.threadId, sendId: "restart_other_task_send_123456" };
    const sent = [behindTheTurn, forASlot];
    const receipts = [
      await api("POST", `/api/bots/${bot.id}/messages`, behindTheTurn, 202),
      await api("POST", `/api/bots/${bot.id}/messages`, forASlot, 202),
    ];
    expect(receipts).toEqual([expect.objectContaining({ queued: true, queueId: expect.any(String) }), expect.objectContaining({ queued: true, queueId: expect.any(String) })]);
    expect(journal()).toEqual(expect.arrayContaining(sent.map((send, index) => ({ id: receipts[index].queueId, send_id: send.sendId, status: "pending" }))));
    const waiting = async (): Promise<WaitingRow[]> => {
      const queues = (await api("GET", "/api/bots")).botQueuedMessages as Record<string, Array<{ queueId: string; sendId?: string }>>;
      return Object.entries(queues).flatMap(([threadId, rows]) => rows.flatMap((row) =>
        sent.some((send) => send.sendId === row.sendId) ? [{ threadId, queueId: row.queueId, sendId: row.sendId! }] : []));
    };

    await waitForExit(fixture.child, { signal: "SIGKILL" });
    await restart();
    await expect.poll(promptsSeen, { timeout: 20_000 }).toBeGreaterThan(1);
    const stillWaiting = await waiting();
    expect(stillWaiting.length, JSON.stringify(journal())).toBeGreaterThan(0);
    const cancelled = stillWaiting[stillWaiting.length - 1];
    const cancelledSend = sent.find((send) => send.sendId === cancelled.sendId)!;
    const kept = sent.find((send) => send.sendId !== cancelled.sendId)!;
    expect(cancelled.queueId).not.toBe(cancelled.sendId);
    expect(cancelled.queueId).toBe(receipts[sent.indexOf(cancelledSend)].queueId);

    expect(await api("DELETE", `/api/bots/${bot.id}/queue/${cancelled.sendId}`, { threadId: cancelled.threadId })).toEqual({ ok: true });
    expect(await api("DELETE", `/api/bots/${bot.id}/queue/${cancelled.sendId}`, { threadId: cancelled.threadId }, 404)).toEqual({ error: "no such queued message" });
    expect((await waiting()).map((row) => row.sendId)).not.toContain(cancelled.sendId);
    expect(journal()).toContainEqual({ id: cancelled.queueId, send_id: cancelled.sendId, status: "cancelled" });

    for (const thread of threads) writeFileSync(join(dataDir, `${thread}.gate`), "let every turn finish");
    await expect.poll(async () => (await messages(kept.threadId)).filter((message) => message.sendId === kept.sendId).length, { timeout: 30_000 }).toBe(1);
    for (const thread of threads) {
      expect(await runControlLaterDog(["wait", "--bot", bot.id, "--task", thread, "--url", url])).toMatchObject({ status: "settled" });
    }
    expect((await messages(kept.threadId)).filter((message) => message.sendId === kept.sendId)).toHaveLength(1);
    expect((await messages(cancelled.threadId)).some((message) => message.sendId === cancelled.sendId || message.text === cancelledSend.text)).toBe(false);
    expect(JSON.stringify(threads.map(prompts))).not.toContain(cancelledSend.text);
    expect(JSON.stringify(threads.map(prompts))).toContain(kept.text);
    expect((await api("POST", `/api/bots/${bot.id}/messages`, cancelledSend, 409)).error).toContain("cancelled");
    evidence.push({ cancelled, kept: kept.sendId, journal: journal() });
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    const evidencePath = `${logPath}.queue-send-id-restart.json`;
    writeFileSync(evidencePath, JSON.stringify({ fixture: fixture.info, evidence }, null, 2));
    console.log(JSON.stringify({ logPath, evidencePath }));
    await fixture.close();
  }
}, 120_000);
