import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { FIXTURE_STARTER_BOT_NAME, runControlLaterDog } from "../control-laterdog.ts";
import { UI_TOOLS_DIR } from "./control-laterdog-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "scripts", "control-laterdog.ts");
const forced = process.env.LATERDOG_UI_E2E === "1";
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const enabled = forced || Boolean(binary);
if (!enabled) {
  console.log(`skipping thinking-timer ui e2e: no agent-browser binary resolves (looked in ${UI_TOOLS_DIR}, LATERDOG_AGENT_BROWSER_PATH and PATH); set LATERDOG_UI_E2E=1 to install the pinned release`);
}
const run = enabled ? it : it.skip;
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;

const evidenceDir = process.env.LATERDOG_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.LATERDOG_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "laterdog-ui-evidence-"));
const ownsEvidenceDir = !process.env.LATERDOG_UI_EVIDENCE_DIR;

interface Launched {
  child: ReturnType<typeof spawn>;
  info: { ui: string; url: string; previewUrl: string; botId: string; dataDir: string; logPath: string };
  stderr: () => string;
}

function launch(args: string[]): Promise<Launched> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CLI, "ui", "launch", ...args], {
      cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid && process.platform !== "win32") {
        try { process.kill(-child.pid, signal); return; } catch {}
      }
      child.kill(signal);
    };
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killGroup("SIGINT");
      setTimeout(() => killGroup("SIGKILL"), 10_000).unref();
      fail(new Error(`ui launch printed no handle within ${LAUNCH_TIMEOUT_MS}ms\nstderr:\n${stderr}`));
    }, LAUNCH_TIMEOUT_MS);
    child.stderr!.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
      if (settled) return;
      const start = stdout.startsWith("{") ? 0 : stdout.indexOf("\n{") + 1;
      if (start <= 0 && !stdout.startsWith("{")) return;
      try {
        const info = JSON.parse(stdout.slice(start));
        settled = true;
        clearTimeout(timer);
        done({ child, info, stderr: () => stderr });
      } catch {}
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      fail(new Error(`ui launch exited ${code} before printing a handle\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

const ui = (verb: string, handle: string, ...args: string[]) =>
  runControlLaterDog(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;

const progressDialog = `Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]')).find(dialog =>
  document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent === 'See progress')`;
const progressTimer = async (handle: string): Promise<string | null> =>
  (await ui("eval", handle, "--js", `${progressDialog}?.querySelector('span.tabular-nums')?.textContent ?? null`)).result;

async function openProgress(handle: string): Promise<string> {
  await waitUntil(async () => (await ui("eval", handle, "--js", `Boolean(document.querySelector('button[aria-label="See progress"][aria-haspopup="dialog"]'))`)).result, 15_000, "the progress button to appear");
  await ui("click", handle, "--name", "See progress");
  await waitUntil(async () => (await ui("eval", handle, "--js", `Boolean(${progressDialog}) && Boolean(document.querySelector('button[aria-label="See progress"][aria-expanded="true"]'))`)).result, 10_000, "the named progress dialog to open");
  return await waitUntil(() => progressTimer(handle), 15_000, "the progress timer to appear") as string;
}

async function closeProgress(handle: string): Promise<void> {
  await ui("press", handle, "--keys", "Escape");
  await waitUntil(async () => (await ui("eval", handle, "--js", `!(${progressDialog}) && Boolean(document.querySelector('button[aria-label="See progress"][aria-expanded="false"]'))`)).result, 10_000, "the progress dialog to close");
  expect((await ui("eval", handle, "--js", `document.activeElement?.getAttribute('aria-label')`)).result).toBe("See progress");
}

function elapsedSeconds(text: string): number {
  const minutes = /^(\d+)m (\d{2})s$/.exec(text);
  if (minutes) return Number(minutes[1]) * 60 + Number(minutes[2]);
  const seconds = /^(\d+)s$/.exec(text);
  if (seconds) return Number(seconds[1]);
  return -1;
}

async function waitUntil<T>(probe: () => Promise<T>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

describe("the thinking timer stays anchored across a switch away", () => {
  let launched: Launched | undefined;

  afterEach(async () => {
    const current = launched;
    launched = undefined;
    if (!current) return;
    try {
      if (current.child.exitCode === null && current.child.signalCode === null) {
        const api = fixtureApi(current.info.url);
        const state = await api("GET", "/api/bots").catch(error => ({ error: String(error) }));
        const snapshot = await ui("snapshot", current.info.ui).catch(error => ({ error: String(error) }));
        writeFileSync(`${current.info.logPath}.thinking-timer.json`, JSON.stringify({ info: current.info, state, snapshot }, null, 2), { mode: 0o600 });
        console.log("Thinking timer fixture evidence saved.");
      }
    } finally {
      await waitForExit(current.child, { signal: "SIGINT", graceMs: 30_000 });
      expect(existsSync(current.info.dataDir)).toBe(false);
    }
  });

  afterAll(async () => {
    if (ownsEvidenceDir) await removeTempDir(evidenceDir);
  });

  run("counts from the server's turn-start stamp, not from the re-selection", async () => {
    launched = await launch(["--mode", "hang"]);
    const { info } = launched;
    const api = fixtureApi(info.url);
    const evaluate = async (js: string) => (await ui("eval", info.ui, "--js", js)).result;
    const timerText = () => progressTimer(info.ui);
    const selectDog = (botId: string) => evaluate(`document.querySelector('[data-sidebar-bot-row="${botId}"]')?.click(); true`);
    const isCurrent = (botId: string) => evaluate(`Boolean(document.querySelector('[data-sidebar-bot-row="${botId}"][aria-current="page"]'))`);
    const taskOf = async (threadId: string) =>
      (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === info.botId).tasks.find((task: any) => task.threadId === threadId);

    const roster = (await api("GET", "/api/bots")).bots;
    const busyThread = roster.find((bot: any) => bot.id === info.botId).threadId;
    const otherDog = roster.find((bot: any) => bot.name === FIXTURE_STARTER_BOT_NAME).id;
    await selectDog(info.botId);
    await waitUntil(() => isCurrent(info.botId), 10_000, "Pepper to become current");

    await ui("type", info.ui, "--name", "Message Pepper", "--text", "hello");
    await ui("press", info.ui, "--keys", "Enter");
    const sentAt = Date.now();

    const busy = await waitUntil(async () => {
      const task = await taskOf(busyThread);
      return task && task.busy && typeof task.turnStartedAt === "number" ? task : null;
    }, 60_000, "the task to go busy with a turnStartedAt stamp");
    const stamp = busy.turnStartedAt as number;
    expect(stamp).toBeGreaterThanOrEqual(sentAt - 2_000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2_000);

    const first = await openProgress(info.ui);
    expect(elapsedSeconds(first)).toBeGreaterThanOrEqual(0);
    await new Promise((done) => setTimeout(done, Math.max(0, stamp + 10_000 - Date.now())));
    const beforeSwitch = (await timerText())!;
    expect(elapsedSeconds(beforeSwitch)).toBeGreaterThanOrEqual(Math.floor((Date.now() - stamp) / 1000) - 2);

    await closeProgress(info.ui);
    await selectDog(otherDog);
    await waitUntil(() => isCurrent(otherDog), 10_000, "the other dog to become current");
    await new Promise((done) => setTimeout(done, 3_000));
    await selectDog(info.botId);
    await waitUntil(() => isCurrent(info.botId), 10_000, "Pepper to become current again");

    const resumed = await openProgress(info.ui);
    const away = (Date.now() - stamp) / 1000;
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(Math.floor(away) - 3);
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(10);

    expect(await taskOf(busyThread)).toMatchObject({ busy: true, turnStartedAt: stamp });

    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "thinking-timer-anchored.png"));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);

    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 120_000);

  run("counts a group's turn from the speaking member's claim, resuming after a switch away", async () => {
    launched = await launch(["--mode", "hang"]);
    const { info } = launched;
    const api = fixtureApi(info.url);
    const evaluate = async (js: string) => (await ui("eval", info.ui, "--js", js)).result;
    const timerText = () => progressTimer(info.ui);
    const botsState = () => api("GET", "/api/bots");
    const groupState = async () => (await botsState()).groups.find((row: any) => row.id === groupId);

    const selectRow = (selector: string) => evaluate(`document.querySelector('${selector}')?.click(); true`);
    const isCurrentRow = (selector: string) => evaluate(`Boolean(document.querySelector('${selector}[aria-current="page"]'))`);
    const soloRow = `[data-sidebar-bot-row="${info.botId}"]`;
    const group = (await api("POST", "/api/groups", {
      memberIds: [info.botId],
      name: "Timer group",
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: info.botId } },
    })).group;
    const groupId = group.id;

    const groupRow = `[data-sidebar-group-row="${groupId}"]`;
    await waitUntil(() => evaluate(`Boolean(document.querySelector('${groupRow}'))`), 10_000, "the group's sidebar row to appear");
    await selectRow(groupRow);
    await waitUntil(() => isCurrentRow(groupRow), 10_000, "the group to become current");

    await ui("type", info.ui, "--name", "Message Timer group", "--text", "hello group");
    await ui("press", info.ui, "--keys", "Enter");
    const sentAt = Date.now();

    const busy = await waitUntil(async () => {
      const claimed = await groupState();
      return claimed && claimed.busyBotId === info.botId && typeof claimed.turnStartedAt === "number" ? claimed : null;
    }, 60_000, "the group to claim Pepper with a turnStartedAt stamp");
    const stamp = busy.turnStartedAt as number;
    expect(stamp).toBeGreaterThanOrEqual(sentAt - 2_000);
    expect(stamp).toBeLessThanOrEqual(Date.now() + 2_000);

    const first = await openProgress(info.ui);
    expect(elapsedSeconds(first)).toBeGreaterThanOrEqual(0);
    await new Promise((done) => setTimeout(done, Math.max(0, stamp + 10_000 - Date.now())));
    const beforeSwitch = (await timerText())!;
    expect(elapsedSeconds(beforeSwitch)).toBeGreaterThanOrEqual(Math.floor((Date.now() - stamp) / 1000) - 2);

    await closeProgress(info.ui);
    await selectRow(soloRow);
    await waitUntil(() => isCurrentRow(soloRow), 10_000, "the 1:1 thread to become current");
    await new Promise((done) => setTimeout(done, 3_000));
    await selectRow(groupRow);
    await waitUntil(() => isCurrentRow(groupRow), 10_000, "the group to become current again");

    const resumed = await openProgress(info.ui);
    const away = (Date.now() - stamp) / 1000;
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(Math.floor(away) - 3);
    expect(elapsedSeconds(resumed)).toBeGreaterThanOrEqual(10);

    expect(await groupState()).toMatchObject({ busyBotId: info.botId, turnStartedAt: stamp });

    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "thinking-timer-group.png"));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter((message) => message.type === "error")).toEqual([]);

    await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
    expect(launched.child.exitCode).toBe(0);
    expect(existsSync(info.dataDir)).toBe(false);
  }, LAUNCH_TIMEOUT_MS + 120_000);
});
