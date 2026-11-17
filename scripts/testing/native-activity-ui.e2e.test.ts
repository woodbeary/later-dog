import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { NativeRunDetail, NativeRunList } from "../../shared/native-runs.ts";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { runControlLaterDog } from "../control-laterdog.ts";
import { UI_TOOLS_DIR } from "./control-laterdog-ui.ts";
import { fixtureApi } from "./preview-fixture.ts";
import { sideJobsWords } from "../../shared/step-words.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env });
const forced = process.env.LATERDOG_UI_E2E === "1";
const run = forced || binary ? it : it.skip;
const LAUNCH_TIMEOUT_MS = forced ? 600_000 : 180_000;
const scratch = mkdtempSync(join(tmpdir(), "laterdog-native-ui-"));
const evidenceDir = process.env.LATERDOG_UI_EVIDENCE_DIR ? resolve(ROOT, process.env.LATERDOG_UI_EVIDENCE_DIR) : mkdtempSync(join(tmpdir(), "laterdog-native-ui-evidence-"));
const gate = join(scratch, "complete-native-turn");

interface Launched {
  child: ReturnType<typeof spawn>;
  info: { ui: string; url: string; previewUrl: string; botId: string; dataDir: string; logPath: string };
}

function launch(): Promise<Launched> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-laterdog.ts"), "ui", "launch", "--mode", "native-activity"], {
      cwd: ROOT, env: { ...process.env, ...(binary ? { LATERDOG_AGENT_BROWSER_PATH: binary } : {}), FAKE_CLAUDE_VERSION: "2.1.301", FAKE_CLAUDE_NATIVE_GATE: gate }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
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
      fail(new Error(`native UI launch exceeded ${LAUNCH_TIMEOUT_MS}ms\n${stderr}`));
    }, LAUNCH_TIMEOUT_MS);
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.stdout!.on("data", chunk => {
      stdout += String(chunk);
      if (settled) return;
      const start = stdout.startsWith("{") ? 0 : stdout.indexOf("\n{") + 1;
      if (start <= 0 && !stdout.startsWith("{")) return;
      try {
        const info = JSON.parse(stdout.slice(start));
        settled = true;
        clearTimeout(timer);
        done({ child, info });
      } catch {}
    });
    child.once("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fail(new Error(`native UI launch exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const ui = (verb: string, handle: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", handle, ...args]) as Promise<Record<string, any>>;

describe("native activity in the isolated real renderer", () => {
  let launched: Launched | undefined;

  afterAll(async () => {
    try {
      if (launched) {
        mkdirSync(evidenceDir, { recursive: true });
        const snapshot = await ui("snapshot", launched.info.ui).catch(error => ({ error: String(error) }));
        writeFileSync(join(evidenceDir, "native-activity-final.json"), JSON.stringify(snapshot, null, 2));
        await waitForExit(launched.child, { signal: "SIGINT", graceMs: 30_000 });
        expect(existsSync(launched.info.dataDir)).toBe(false);
      }
    } finally { await removeTempDir(scratch); }
  });

  run("shows a native turn through the working line and the panel, keeps child text out of the parent, and keeps the folded turn after a reload", async () => {
    launched = await launch();
    const { info } = launched;
    const api = fixtureApi(info.url);
    const evaluate = async (js: string) => (await ui("eval", info.ui, "--js", js)).result;
    const bot = (await api("GET", "/api/bots")).bots.find((row: { id: string }) => row.id === info.botId);
    const threadId = bot.threadId as string;
    const runs = () => api("GET", `/api/threads/${threadId}/runs`) as Promise<NativeRunList>;
    await ui("type", info.ui, "--name", "Message Pepper", "--text", "Inspect all native helpers in this isolated fixture.");
    await ui("press", info.ui, "--keys", "Enter");
    await expect.poll(async () => (await runs()).runs[0]?.actors.filter(actor => actor.kind === "subagent").length, { timeout: 60_000 }).toBe(7);
    const active = (await runs()).runs[0]!;
    expect(active.providerVersion).toBe("2.1.301");
    expect(active.observation).toBe("live");
    const sideJobs = active.actors.filter(actor => actor.kind !== "parent" && actor.background && actor.state === "running").length;
    const lineText = () => evaluate(`document.querySelector('[data-work-line]')?.textContent ?? null`);
    const panelText = () => evaluate(`document.querySelector('[data-work-panel]')?.textContent ?? null`);
    await expect.poll(lineText, { timeout: 20_000 }).toBeTruthy();
    expect(sideJobs).toBe(0);
    expect(await lineText()).not.toContain(sideJobsWords(2).replace("2 ", ""));
    expect(await evaluate(`document.querySelectorAll('[data-native-work]').length`)).toBe(0);
    expect(await evaluate(`document.querySelector('button[aria-label="See progress"]')`)).toBeNull();
    expect(await lineText()).not.toContain("CHILD_ONLY_");
    const messages = await api("GET", `/api/threads/${threadId}/messages?limit=100`);
    expect(JSON.stringify(messages.messages)).not.toContain("CHILD_ONLY_");
    expect(await evaluate(`document.querySelector('[role="log"]')?.textContent`)).not.toContain("CHILD_ONLY_");
    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "native-activity-active.png"));
    await evaluate(`document.querySelector('[data-work-line] button').click(); true`);
    await expect.poll(() => evaluate(`document.querySelector('[data-work-panel]')?.getAttribute('data-page') ?? null`), { timeout: 10_000 }).toBe("work");
    await expect.poll(panelText, { timeout: 10_000 }).toContain("What Pepper is doing");
    await expect.poll(() => evaluate(`document.querySelectorAll('[data-work-panel] [data-step-id]').length`), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await panelText()).not.toContain("CHILD_ONLY_");
    expect(await evaluate(`document.activeElement?.getAttribute('aria-label')`)).not.toBe("Close");
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "native-activity-panel.png"));
    expect(await panelText()).toContain("Didn't work");
    await ui("press", info.ui, "--keys", "Escape");
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[data-work-panel]'))`), { timeout: 10_000 }).toBe(false);
    const detail = await api("GET", `/api/threads/${threadId}/runs/${active.id}`) as NativeRunDetail;
    const nested = detail.run.actors.find(actor => actor.label === "Nested inspector")!;
    const researcher = detail.run.actors.find(actor => actor.label === "Researcher")!;
    expect(nested.parentId).toBe(researcher.id);
    expect(detail.activities.some(activity => activity.actorId === nested.id && activity.kind === "tool" && activity.state === "done")).toBe(true);
    expect(detail.run.actors.find(actor => actor.label === "Checker")?.state).toBe("failed");
    writeFileSync(gate, "complete");
    await expect.poll(async () => (await runs()).runs[0]?.observation, { timeout: 30_000 }).toBe("complete");
    await ui("wait-settle", info.ui, "--timeout", "60");
    await expect.poll(() => evaluate(`document.querySelector('[data-fold-line]')?.textContent ?? null`), { timeout: 10_000 }).toBeTruthy();
    expect(await evaluate(`document.querySelector('[data-work-line]')`)).toBeNull();
    expect(await evaluate(`document.querySelectorAll('[data-native-work]').length`)).toBe(0);
    expect(await evaluate(`document.querySelector('[role="log"]')?.textContent`)).toContain("Parent: Native activity fixture complete.");
    expect(await evaluate(`document.querySelector('[role="log"]')?.textContent`)).not.toContain("CHILD_ONLY_");
    expect(await evaluate(`document.querySelector('[data-fold-line]')?.textContent`)).toContain("Got help");
    expect(await evaluate(`(() => { const fold = document.querySelector('[data-fold-line]'); const answer = Array.from(document.querySelectorAll('[role="log"] [data-mid]')).find(row => row.textContent.includes('Parent: Native activity fixture complete.')); return Boolean(fold && answer && answer.contains(fold) && answer.textContent.indexOf(fold.textContent) < answer.textContent.indexOf('Parent: Native activity fixture complete.')); })()`)).toBe(true);
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "native-activity-receipt.png"));
    await evaluate("setTimeout(() => location.reload(), 10); true");
    await expect.poll(() => evaluate(`document.querySelector('[data-fold-line]')?.textContent ?? null`), { timeout: 30_000 }).toBeTruthy();
    await expect.poll(() => evaluate(`document.querySelector('[role="log"]')?.textContent`), { timeout: 30_000 }).toContain("Parent: Native activity fixture complete.");
    await evaluate(`document.querySelector('[data-fold-line]').click(); true`);
    await expect.poll(panelText, { timeout: 10_000 }).toContain("What Pepper did");
    await expect.poll(() => evaluate(`document.querySelectorAll('[data-work-panel] [data-step-id]').length`), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(await panelText()).not.toContain("CHILD_ONLY_");
    const saved = await api("GET", `/api/threads/${threadId}/runs/${active.id}`) as NativeRunDetail;
    expect(saved.run.actors.filter(actor => actor.kind === "subagent" && actor.state === "done")).toHaveLength(6);
    expect(saved.activities.some(activity => activity.actorId === researcher.id && activity.links?.some(link => link.url === "https://code.claude.com/docs/en/sub-agents"))).toBe(true);
    writeFileSync(join(evidenceDir, "native-activity-run.json"), JSON.stringify(saved, null, 2));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter(message => message.type === "error")).toEqual([]);
  }, LAUNCH_TIMEOUT_MS + 180_000);
});
