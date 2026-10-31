import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog, verificationServerEnvironment } from "../../scripts/control-laterdog.ts";
import { waitForExit } from "../testing/cleanup.ts";
import { pickingUpNotice } from "./restart-pickup.ts";

const CLAUDE = { instanceId: "claude", model: "claude-sonnet-5" };

it.skipIf(process.platform === "win32")("stops the work later.dog picked back up after a crash when Stop names the turn before it, and keeps a newer turn", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-pickup-stop-"));
  const gate = join(scratch, "finish");
  const fixture = await launchVerificationServer({});
  const { dataDir, url, logPath } = fixture.info;
  const evidence: unknown[] = [{ url }];
  let server: ChildProcess | undefined;
  let transcript: () => Promise<unknown> = async () => null;
  const configPath = join(dataDir, "config.json");
  const start = () => {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.instances.claude.environment = { ...config.instances.claude.environment, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate };
    writeFileSync(configPath, JSON.stringify(config));
    const log = openSync(logPath, "a", 0o600);
    server = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      env: verificationServerEnvironment({}, dataDir, Number(new URL(url).port)),
      stdio: ["ignore", log, log],
    });
    closeSync(log);
  };
  const healthy = () => expect.poll(async () => {
    try { return (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) })).ok; } catch { return false; }
  }, { timeout: 30_000 }).toBe(true);
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json() as any;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const control = async (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    start();
    await healthy();

    const { bot } = await control("new-bot", "--name", "Scout");
    const threadId = bot.activeTaskId as string;
    await api("PATCH", `/api/bots/${bot.id}/tasks/${threadId}`, { modelSelection: CLAUDE, updateBotDefault: true });
    const messages = async (): Promise<any[]> => (await api("GET", `/api/threads/${threadId}/messages?limit=200`)).messages;
    transcript = messages;
    const task = async () => (await api("GET", "/api/bots?messages=0")).bots
      .find((entry: any) => entry.id === bot.id)?.tasks?.find((entry: any) => entry.threadId === threadId);
    const busy = async () => (await task())?.busy === true;
    const stop = (turnStartedAt: number) => api("POST", `/api/bots/${bot.id}/interrupt`, { threadId, turnStartedAt });

    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Fix the login bug.");
    await expect.poll(busy, { timeout: 20_000 }).toBe(true);
    const pressed = (await task()).turnStartedAt;
    expect(pressed).toEqual(expect.any(Number));
    await waitForExit(server, { signal: "SIGKILL" });

    start();
    await healthy();
    await expect.poll(async () => (await messages()).some((message) => message.tool?.name === `recovery: ${pickingUpNotice("Scout")}`), { timeout: 20_000, interval: 250 }).toBe(true);
    await expect.poll(busy, { timeout: 20_000 }).toBe(true);
    expect((await task()).turnStartedAt).toBeGreaterThan(pressed);
    expect(await stop(pressed)).toEqual({ ok: true });
    await expect.poll(busy, { timeout: 20_000 }).toBe(false);
    evidence.push({ stoppedPickup: await messages() });

    await control("send", "--bot", bot.id, "--task", threadId, "--text", "Now open the pull request.");
    await expect.poll(busy, { timeout: 20_000 }).toBe(true);
    const newer = (await task()).turnStartedAt;
    expect(newer).toBeGreaterThan(pressed);
    expect(await stop(pressed)).toEqual({ ok: true, kept: "newer" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await busy()).toBe(true);
    expect(await stop(newer)).toEqual({ ok: true });
    await expect.poll(busy, { timeout: 20_000 }).toBe(false);
    evidence.push({ keptNewer: await messages() });
  } finally {
    evidence.push({ transcript: await transcript().catch((error: unknown) => String(error)) });
    const evidencePath = `${logPath}.pickup-stops.json`;
    writeFileSync(evidencePath, JSON.stringify(evidence, null, 2));
    writeFileSync(gate, "done");
    await waitForExit(server, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 120_000);
