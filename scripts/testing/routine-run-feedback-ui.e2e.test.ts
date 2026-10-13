import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { runControlLaterDog } from "../control-laterdog.ts";
import { UI_TOOLS_DIR } from "./control-laterdog-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.LATERDOG_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
let child: ChildProcess | undefined;
afterAll(() => waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }));

(enabled ? it : it.skip)("Run now in a routine's details shows pending, its exact result, and retryable request errors", async () => {
  let output = "";
  let stderr = "";
  child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-laterdog.ts"), "ui", "launch"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  let fixture: { ui: string; url: string; botId: string; logPath: string };
  await expect.poll(() => {
    if (child!.exitCode !== null) throw new Error(stderr);
    try { fixture = JSON.parse(output); return Boolean(fixture.ui); } catch { return false; }
  }, { timeout: 600_000 }).toBe(true);
  const ui = (verb: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", fixture.ui, ...args]) as Promise<Record<string, any>>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  const click = (name: string) => ui("click", "--name", name);
  const present = (name: string) => evaluate(`[...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === ${JSON.stringify(name)} || (!button.hasAttribute('aria-label') && button.textContent.trim() === ${JSON.stringify(name)}))`);
  const api = (path: string, init: RequestInit = {}) => fetch(`${fixture.url}${path}`, { ...init, headers: { "content-type": "application/json", origin: fixture.url } });

  const created = await api("/api/routines", { method: "POST", body: JSON.stringify({ name: "Feedback fixture", prompt: "Reply with the fixture response.", botId: fixture!.botId, enabled: false, schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } }) });
  expect(created.status).toBe(201);
  const { routine } = await created.json();
  const runs = async () => ((await (await api("/api/routines")).json()).runs as Array<{ id: string; routineId: string; status: string }>).filter(run => run.routineId === routine.id);
  expect((await api(`/api/routines/${routine.id}/run`, { method: "POST" })).ok).toBe(true);
  await expect.poll(async () => (await runs()).map(run => run.status), { timeout: 30_000 }).toEqual(["completed"]);

  await expect.poll(() => present("Open run for Feedback fixture"), { timeout: 30_000 }).toBe(true);
  await click("Open run for Feedback fixture");
  await expect.poll(() => present("Run logs")).toBe(true);
  await click("Run logs");
  await expect.poll(() => present("Open Feedback fixture run: Completed"), { timeout: 10_000 }).toBe(true);
  await click("Open Feedback fixture run: Completed");
  const drawer = `document.querySelector('[aria-label="Routine details"]')`;
  const details = () => evaluate(`${drawer}?.innerText ?? ""`);
  const recentRuns = () => evaluate(`${drawer}.querySelectorAll('button[aria-label^="Open Feedback fixture run"]').length`);
  await expect.poll(details, { timeout: 10_000 }).toContain("hello from fake claude");

  await evaluate(`(() => { window.fixtureFetch = window.fetch; window.runPosts = 0; window.fetch = async (...args) => { if (String(args[0]).endsWith('/${routine.id}/run')) { window.runPosts++; await new Promise(resolve => window.releaseRun = resolve); } return window.fixtureFetch(...args); }; const button = [...${drawer}.querySelectorAll('button')].find(b => b.textContent.trim() === 'Run now'); button.click(); button.click(); return true; })()`);
  await expect.poll(details).toContain("Starting…");
  expect(await details()).not.toContain("Completed");
  await expect.poll(() => evaluate("window.runPosts")).toBe(1);
  await evaluate("window.releaseRun(); true");
  await expect.poll(details, { timeout: 30_000 }).toContain("Completed");
  expect(await details()).toContain("Open thread");
  expect(await details()).toContain("hello from fake claude");
  expect(await runs()).toHaveLength(2);
  await expect.poll(recentRuns).toBe(2);
  expect(await evaluate(`${drawer}.querySelector('button[aria-label^="Open Feedback fixture run"]').getAttribute('aria-current')`)).toBe("true");

  expect((await api(`/api/routines/${routine.id}`, { method: "PATCH", body: JSON.stringify({ prompt: "A different competing run." }) })).ok).toBe(true);
  const competing = await api(`/api/routines/${routine.id}/run`, { method: "POST" });
  expect(competing.ok).toBe(true);
  const { run: competingRun } = await competing.json();
  await expect.poll(async () => (await runs()).find(run => run.id === competingRun.id)?.status, { timeout: 30_000 }).toBe("completed");
  await expect.poll(recentRuns, { timeout: 10_000 }).toBe(3);
  expect(await details()).toContain("Reply with the fixture response.");
  expect(await details()).not.toContain("A different competing run.");

  await evaluate(`window.fetch = (...args) => String(args[0]).endsWith('/${routine.id}/run') ? Promise.resolve(new Response(JSON.stringify({ error: 'Fixture run rejected' }), { status: 409, headers: { 'Content-Type': 'application/json' } })) : window.fixtureFetch(...args); true`);
  await click("Run now");
  await expect.poll(details).toContain("Fixture run rejected");
  expect(await details()).not.toContain("Completed");
  expect(await runs()).toHaveLength(3);
  await evaluate("window.fetch = window.fixtureFetch; true");
  await click("Run now");
  await expect.poll(details, { timeout: 30_000 }).toContain("Completed");
  expect(await details()).toContain("A different competing run.");
  expect(await details()).not.toContain("Fixture run rejected");
  expect(await runs()).toHaveLength(4);
  await ui("screenshot", "--out", `${fixture!.logPath}.routine-run-feedback.png`);
}, 720_000);
