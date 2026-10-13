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
if (!enabled) console.log("skipping composer drafts UI: set LATERDOG_UI_E2E=1 to install the pinned browser");
let child: ChildProcess | undefined;
afterAll(() => waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }));

(enabled ? it : it.skip)("keeps each chat's draft across dogs and threads, and sending or creating a dog clears only its own composer", async () => {
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
  const bots = async () => (await fetch(`${fixture.url}/api/bots?messages=0`).then(response => response.json())).bots as Array<{ id: string; name: string; threadId: string }>;
  const composer = () => evaluate(`(() => { const field = document.querySelector('textarea[aria-label^="Message "]'); return field && [field.getAttribute('aria-label'), field.value]; })()`);
  const press = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const openDog = (id: string) => press(`[data-sidebar-bot-row="${id}"]`);
  const openThread = (id: string) => press(`[data-sidebar-thread-row="${id}"]`);

  const initial = await bots();
  const pepper = initial.find(bot => bot.id === fixture!.botId)!;
  const starter = initial.find(bot => bot.name === "Fixture Starter")!;
  expect(starter).toBeDefined();
  await ui("type", "--name", "Message Pepper", "--text", "Half a thought for Pepper");
  await openDog(starter.id);
  await expect.poll(composer).toEqual(["Message Fixture Starter", ""]);
  await ui("type", "--name", "Message Fixture Starter", "--text", "Something else for the starter");
  await openDog(pepper.id);
  await expect.poll(composer).toEqual(["Message Pepper", "Half a thought for Pepper"]);

  await evaluate(`document.querySelector('[data-sidebar-bot-row="${pepper.id}"]').parentElement.querySelector('button[aria-label="New thread"]').click(); true`);
  const current = () => evaluate("document.querySelector('[data-sidebar-thread-row][aria-current=page]')?.dataset.sidebarThreadRow ?? null");
  await expect.poll(current, { timeout: 10_000 }).not.toBe(null);
  const fresh = await current() as string;
  expect(fresh).not.toBe(pepper.threadId);
  await expect.poll(composer).toEqual(["Message Pepper", ""]);
  await ui("type", "--name", "Message Pepper", "--text", "A note in the new thread");
  await openThread(pepper.threadId);
  await expect.poll(composer).toEqual(["Message Pepper", "Half a thought for Pepper"]);

  await ui("press", "--keys", "Enter");
  await expect.poll(composer).toEqual(["Message Pepper", ""]);
  await ui("wait-settle", "--timeout", "60");
  expect(await evaluate("document.querySelector('[role=log]')?.innerText ?? ''")).toContain("Half a thought for Pepper");
  await openDog(starter.id);
  await expect.poll(composer).toEqual(["Message Fixture Starter", "Something else for the starter"]);
  await openThread(fresh);
  await expect.poll(composer).toEqual(["Message Pepper", "A note in the new thread"]);
  await openThread(pepper.threadId);
  await expect.poll(composer).toEqual(["Message Pepper", ""]);

  const before = await bots();
  await ui("press", "--keys", "Control+n");
  await expect.poll(() => evaluate("[...document.querySelectorAll('[role=dialog] button')].find(button => button.textContent.trim() === 'Create dog')?.disabled")).toBe(false);
  await ui("click", "--name", "Create dog");
  await expect.poll(async () => (await bots()).length, { timeout: 15_000 }).toBe(before.length + 1);
  const created = (await bots()).find(bot => !before.some(old => old.id === bot.id))!;
  await expect.poll(composer).toEqual([`Message ${created.name}`, ""]);
  expect(await evaluate("Boolean(document.querySelector('[role=dialog]'))")).toBe(false);
  await openDog(starter.id);
  await expect.poll(composer).toEqual(["Message Fixture Starter", "Something else for the starter"]);
  await openThread(fresh);
  await expect.poll(composer).toEqual(["Message Pepper", "A note in the new thread"]);
  await ui("screenshot", "--out", `${fixture!.logPath}.composer-drafts.png`);
}, 720_000);
