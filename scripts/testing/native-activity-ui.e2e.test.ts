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

  run("shows five of seven native puppies, nested results and durable receipts without mixing child text into the parent", async () => {
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
    const rowSelector = `[data-native-work="${active.id}"]`;
    await expect.poll(() => evaluate(`document.querySelector(${JSON.stringify(rowSelector)})?.querySelectorAll('button[title]').length`), { timeout: 20_000 }).toBe(5);
    await expect.poll(async () => (await ui("snapshot", info.ui)).snapshot, { timeout: 20_000 }).toContain("View 2 more puppies");
    expect(await evaluate(`document.querySelector('button[aria-label="See progress"]')?.textContent`)).toContain("Searching");
    expect(await evaluate(`document.querySelectorAll('[data-native-work]').length`)).toBe(1);
    expect(await evaluate(`document.querySelector(${JSON.stringify(rowSelector)})?.textContent`)).toContain("Issue recorded");
    const messages = await api("GET", `/api/threads/${threadId}/messages?limit=100`);
    expect(JSON.stringify(messages.messages)).not.toContain("CHILD_ONLY_");
    expect(await evaluate(`document.querySelector('[role="log"]')?.textContent`)).not.toContain("CHILD_ONLY_");
    mkdirSync(evidenceDir, { recursive: true });
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "native-activity-active.png"));
    await ui("click", info.ui, "--name", "View Researcher · Working");
    await expect.poll(() => evaluate(`document.querySelector('[role="dialog"] h3')?.textContent`), { timeout: 10_000 }).toBe("Researcher");
    await expect.poll(() => evaluate(`document.querySelector('[role="dialog"]')?.textContent`), { timeout: 10_000 }).toContain("CHILD_ONLY_0");
    expect(await evaluate(`document.querySelector('[role="dialog"]')?.textContent`)).toContain("Researcher is comparing the fixture evidence.");
    expect(await evaluate(`document.querySelector('[role="dialog"] a[href="https://code.claude.com/docs/en/sub-agents"]')?.textContent`)).toBe("Claude Code subagents");
    expect(await evaluate(`document.activeElement?.getAttribute('aria-label')`)).toBe("Close work details");
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "native-activity-research.png"));
    await ui("press", info.ui, "--keys", "Shift+Tab");
    expect(await evaluate(`document.querySelector('[role="dialog"]')?.contains(document.activeElement)`)).toBe(true);
    await evaluate(`Array.from(document.querySelectorAll('nav[aria-label="Agents and tasks"] button')).find(button => button.textContent.includes('Nested inspector'))?.click(); true`);
    await expect.poll(() => evaluate(`document.querySelector('[role="dialog"] h3')?.textContent`)).toBe("Nested inspector");
    expect(await evaluate(`document.querySelector('[role="dialog"]')?.textContent`)).toContain("CHILD_ONLY_6");
    expect(await evaluate(`document.querySelector('[role="dialog"]')?.textContent`)).toContain("Nested fixture notes were read successfully.");
    const detail = await api("GET", `/api/threads/${threadId}/runs/${active.id}`) as NativeRunDetail;
    const nested = detail.run.actors.find(actor => actor.label === "Nested inspector")!;
    const researcher = detail.run.actors.find(actor => actor.label === "Researcher")!;
    expect(nested.parentId).toBe(researcher.id);
    expect(detail.activities.some(activity => activity.actorId === nested.id && activity.kind === "tool" && activity.state === "done")).toBe(true);
    expect(detail.run.actors.find(actor => actor.label === "Checker")?.state).toBe("failed");
    await evaluate(`document.querySelector('[role="dialog"] details > summary')?.click(); true`);
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "native-activity-nested.png"));
    await ui("press", info.ui, "--keys", "Escape");
    expect(await evaluate(`document.activeElement?.getAttribute('aria-label')`)).toBe("View Researcher · Working");
    await ui("click", info.ui, "--name", "View 2 more puppies");
    expect(await evaluate(`document.querySelector('[role="dialog"] h3')?.textContent`)).toBe("Reviewer");
    await ui("press", info.ui, "--keys", "Escape");
    writeFileSync(gate, "complete");
    await expect.poll(async () => (await runs()).runs[0]?.observation, { timeout: 30_000 }).toBe("complete");
    await ui("wait-settle", info.ui, "--timeout", "60");
    await expect.poll(() => evaluate(`document.querySelector(${JSON.stringify(rowSelector)})?.textContent`), { timeout: 10_000 }).toContain("View work");
    expect(await evaluate(`document.querySelector('button[aria-label="See progress"]')`)).toBeNull();
    expect(await evaluate(`document.querySelector(${JSON.stringify(rowSelector)})?.closest('[data-mid]')`)).toBeNull();
    expect(await evaluate(`document.querySelector('[role="log"]')?.textContent`)).toContain("Parent: Native activity fixture complete.");
    expect(await evaluate(`document.querySelector('[role="log"]')?.textContent`)).not.toContain("CHILD_ONLY_");
    await ui("screenshot", info.ui, "--out", join(evidenceDir, "native-activity-receipt.png"));
    await evaluate("setTimeout(() => location.reload(), 10); true");
    await expect.poll(() => evaluate(`document.querySelector(${JSON.stringify(rowSelector)})?.textContent`), { timeout: 30_000 }).toContain("View work");
    await evaluate(`document.querySelector(${JSON.stringify(rowSelector)})?.querySelector('button')?.click(); true`);
    await evaluate(`Array.from(document.querySelectorAll('nav[aria-label="Agents and tasks"] button')).find(button => button.textContent.includes('Checker'))?.click(); true`);
    await expect.poll(() => evaluate(`document.querySelector('[role="dialog"] h3')?.textContent`), { timeout: 10_000 }).toBe("Checker");
    expect(await evaluate(`document.querySelector('[role="dialog"]')?.textContent`)).toContain("Checker found a deliberate fixture failure.");
    expect(await evaluate(`document.querySelector('[role="dialog"]')?.textContent`)).toContain("Claude Code 2.1.301");
    expect(await evaluate(`document.querySelector('[role="dialog"]')?.textContent`)).toContain("completed content blocks");
    expect(await evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).some(button => button.textContent.includes('Stop helper'))`)).toBe(false);
    const saved = await api("GET", `/api/threads/${threadId}/runs/${active.id}`) as NativeRunDetail;
    expect(saved.run.actors.filter(actor => actor.kind === "subagent" && actor.state === "done")).toHaveLength(6);
    expect(saved.activities.some(activity => activity.actorId === researcher.id && activity.links?.some(link => link.url === "https://code.claude.com/docs/en/sub-agents"))).toBe(true);
    writeFileSync(join(evidenceDir, "native-activity-run.json"), JSON.stringify(saved, null, 2));
    const logs = await ui("console", info.ui);
    expect((logs.messages as Array<{ type: string; text: string }>).filter(message => message.type === "error")).toEqual([]);
  }, LAUNCH_TIMEOUT_MS + 180_000);
});
