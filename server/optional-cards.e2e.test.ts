import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-laterdog.ts";
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../shared/options-card.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("denies optional watcher cards for an owner's Full source while preserving the same dog's Ask task and stale-turn refusal", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "hang" });
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { origin: url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const start = async (threadId: string): Promise<Record<string, string>> => {
    writeFileSync(fixture.fixtureDumpPath, "");
    await api("POST", `/api/bots/${WATCHER_OPTIONS_CARD_BOT_ID}/messages`, { threadId, text: "Hold this isolated turn while its card policy is checked." }, 202);
    let agents: Record<string, string> | undefined;
    await expect.poll(() => {
      try { agents = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")).mcpConfig.mcpServers.agents.env; } catch {}
      return Boolean(agents?.LATERDOG_COMMS_TOKEN);
    }, { timeout: 15_000 }).toBe(true);
    return agents!;
  };
  const post = (agents: Record<string, string>, extra: Record<string, unknown> = {}) => fetch(`${agents.LATERDOG_HARNESS_URL}/api/internal/options-card`, {
    method: "POST",
    headers: { authorization: `Bearer ${agents.LATERDOG_COMMS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ title: "Choose the next step", subtitle: "The result is ready", options: ["Continue", "Wait"], ...extra }),
    signal: AbortSignal.timeout(10_000),
  });
  const cards = async (threadId: string) => (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages.filter((message: any) => message.kind === "options");
  try {
    const made = (await api("POST", "/api/bots", { name: "Watcher fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" } }, 201)).bot;
    const ask = (await api("POST", `/api/bots/${made.id}/tasks`, { title: "Ask source", approvalMode: "ask" }, 201)).task;
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const botsFile = join(dataDir, "bots.json");
    const saved = JSON.parse(readFileSync(botsFile, "utf8").replaceAll(made.id, WATCHER_OPTIONS_CARD_BOT_ID));
    const records = Array.isArray(saved) ? saved : saved.bots;
    const watcher = records.find((bot: any) => bot.id === WATCHER_OPTIONS_CARD_BOT_ID);
    watcher.approvalMode = "full";
    delete watcher.autoApprove;
    delete watcher.approvalGrant;
    for (const task of watcher.tasks ?? []) {
      task.approvalMode = task.threadId === made.threadId ? "full" : "ask";
      delete task.autoApprove;
      delete task.approvalGrant;
    }
    writeFileSync(botsFile, JSON.stringify(saved));
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: verificationServerEnvironment({ FAKE_CLAUDE_MODE: "hang" }, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    await expect.poll(async () => {
      try { return (await fetch(url + "/api/health", { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);

    const full = await start(made.threadId);
    const denied = await post(full, { ownerFullAccess: false });
    expect(denied.status, await denied.clone().text()).toBe(403);
    expect(await denied.json()).toEqual({ error: "Options cards are disabled for this owner's Full access conversation. Decide routine choices yourself and continue." });
    expect(await cards(made.threadId)).toEqual([]);
    await api("POST", `/api/bots/${WATCHER_OPTIONS_CARD_BOT_ID}/interrupt`, { threadId: made.threadId });
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === WATCHER_OPTIONS_CARD_BOT_ID)?.busy).toBe(false);
    const stale = await post(full);
    expect([401, 403, 409, 410]).toContain(stale.status);
    expect(await cards(made.threadId)).toEqual([]);

    const asking = await start(ask.threadId);
    const allowed = await post(asking, { ownerFullAccess: true });
    expect(allowed.status, await allowed.clone().text()).toBe(201);
    expect(await cards(ask.threadId)).toHaveLength(1);
    expect(await cards(made.threadId)).toEqual([]);
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 90_000);
