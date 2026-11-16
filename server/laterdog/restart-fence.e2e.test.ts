import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";

const CLAUDE = { instanceId: "claude", model: "claude-sonnet-5" };

it.skipIf(process.platform === "win32")("never marks the person's request as stopped when a restart ends the team task it started", async () => {
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  let server: ChildProcess | undefined;
  let transcript: () => Promise<string[]> = async () => [];
  const plan = join(dataDir, "room-plan.json");
  const chiefReady = join(dataDir, "chief-ready");
  const chiefRelease = join(dataDir, "chief-release");
  const scoutRelease = join(dataDir, "scout-release");
  const configPath = join(dataDir, "config.json");
  const start = () => {
    const out = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), stdio: ["ignore", out, out],
    });
    closeSync(out);
    return expect.poll(async () => {
      try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
    }, { timeout: 30_000 }).toBe(true);
  };
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  const nodes = (): any[] => existsSync(join(dataDir, "room-handoffs.json")) ? JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8")) : [];
  const running = (): any[] => existsSync(join(dataDir, "turns-running.json")) ? JSON.parse(readFileSync(join(dataDir, "turns-running.json"), "utf8")) : [];
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = { ...config.instances.claude.environment, FAKE_CLAUDE_ROOM_PLAN: plan, FAKE_CLAUDE_TOOL_CALLS: "[]" };
    writeFileSync(configPath, JSON.stringify(config));
    await start();

    const { bot: chief } = await control("new-bot", "--name", "Fence Chief", "--section", "Leadership");
    const { bot: scout } = await control("new-bot", "--name", "Fence Scout", "--section", "Engineering");
    const threadId = chief.activeTaskId as string;
    await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true, managedSections: ["Engineering"], acknowledgePeerScope: true });
    for (const bot of [chief, scout]) await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.activeTaskId}`, { modelSelection: CLAUDE, updateBotDefault: true });
    writeFileSync(plan, JSON.stringify({
      [chief.id]: { when: [{ includes: "MEADOW_ASK", steps: [{ arguments: { bot_ids: [scout.id], request_key: "meadow", message: "SCOUT_WORK count the meadow" } }], readyFile: chiefReady, gateFile: chiefRelease, reply: "Asked Scout" }] },
      [scout.id]: { when: [{ includes: "SCOUT_WORK", gateFile: scoutRelease, reply: "SCOUT_DONE" }] },
    }));
    const rows = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
    transcript = async () => (await rows()).map(row => `${row.role}/${row.kind}: ${(row.text ?? row.tool?.name ?? "").slice(0, 120)}${row.requestCancelled ? " [cancelled]" : ""}`);
    const asked = async () => (await rows()).find(row => row.role === "user" && row.text.startsWith("MEADOW_ASK"));

    await control("send", "--bot", chief.id, "--task", threadId, "--text", "MEADOW_ASK have Scout count the meadow");
    await expect.poll(() => existsSync(chiefReady), { timeout: 30_000 }).toBe(true);
    await expect.poll(() => nodes().find(n => n.botId === scout.id)?.status, { timeout: 30_000 }).toBe("running");
    await expect.poll(() => running().some(turn => turn.threadId === threadId), { timeout: 10_000 }).toBe(true);
    expect((await asked())?.requestPending).toBe(true);
    await waitForExit(server, { signal: "SIGKILL" });

    await start();
    await expect.poll(() => readFileSync(logPath, "utf8").includes(`restart pickup: ${threadId}`), { timeout: 30_000, interval: 250 }).toBe(true);
    await expect.poll(() => nodes().every(n => n.endedBy === "restart"), { timeout: 10_000 }).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect((await asked())?.requestCancelled).not.toBe(true);
  } catch (error) {
    console.info(JSON.stringify({ nodes: nodes().map(n => ({ parent: Boolean(n.parentId), status: n.status, endedBy: n.endedBy })), rows: await transcript().catch(() => []) }, null, 1));
    throw error;
  } finally {
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 150_000);
