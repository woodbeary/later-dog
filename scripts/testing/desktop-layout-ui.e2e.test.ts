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
if (!enabled) console.log("skipping desktop layout UI: set LATERDOG_UI_E2E=1 to install the pinned browser");
let child: ChildProcess | undefined;
afterAll(() => waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }));

(enabled ? it : it.skip)("keeps the name pill still, fits the model menu in the window, and lets Escape close only the period menu", async () => {
  let output = "";
  let stderr = "";
  child = spawn(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts/control-laterdog.ts"), "ui", "launch"], { cwd: ROOT, env: { ...process.env, FAKE_CLAUDE_MODE: "api-error" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  let fixture: { ui: string; logPath: string };
  await expect.poll(() => {
    if (child!.exitCode !== null) return `exited: ${stderr}`;
    try { fixture = JSON.parse(output.slice(output.indexOf("{"))); return fixture.ui ? "ready" : "waiting"; } catch { return "waiting"; }
  }, { timeout: 600_000 }).toBe("ready");
  const ui = (verb: string, ...args: string[]) => runControlLaterDog(["ui", verb, "--ui", fixture.ui, ...args]) as Promise<Record<string, any>>;
  const evaluate = async (js: string) => (await ui("eval", "--js", js)).result;
  const settled = { timeout: 15_000 };
  const pillLeft = () => evaluate("Math.round(document.querySelector('[data-chathead-pill]').getBoundingClientRect().left)");
  const stateLine = () => evaluate("document.querySelector('[data-chathead-row] [role=status]')?.textContent ?? ''");
  const settings = () => evaluate("[...document.querySelectorAll('[role=dialog][aria-modal=true]')].some(dialog => dialog.textContent.includes('Usage & Billing'))");
  const periodMenu = () => evaluate("Boolean(document.querySelector('[role=menu] [role=menuitemradio]'))");
  const clickText = (text: string) => evaluate(`(() => { const found = [...document.querySelectorAll('button,[role=menuitem],[role=tab]')].find(node => node.textContent.trim().startsWith(${JSON.stringify(text)})); found?.click(); return Boolean(found); })()`);

  expect(await stateLine()).toBe("");
  const without = await pillLeft();
  await ui("type", "--name", "Message Pepper", "--text", "Please work out what Acme owes for October");
  await ui("press", "--keys", "Enter");
  await expect.poll(stateLine, { timeout: 60_000 }).not.toBe("");
  expect(await pillLeft()).toBe(without);

  await evaluate("document.querySelector('[data-chat-ai]').click(); true");
  await expect.poll(() => evaluate("Boolean(document.querySelector('[data-model-picker-content]'))"), settled).toBe(true);
  const menu = await evaluate("(() => { const box = document.querySelector('[data-model-picker-content]').getBoundingClientRect(); return [Math.round(box.top), Math.round(box.bottom), innerHeight]; })()") as number[];
  expect(menu[0]).toBeGreaterThanOrEqual(0);
  expect(menu[1]).toBeLessThanOrEqual(menu[2]!);
  await ui("press", "--keys", "Escape");

  await ui("click", "--name", "You");
  await expect.poll(() => clickText("Settings"), settled).toBe(true);
  await expect.poll(() => clickText("Usage"), settled).toBe(true);
  await expect.poll(settings, settled).toBe(true);
  await expect.poll(() => evaluate("(() => { const trigger = document.querySelector('[aria-label^=\"Period: \"]'); trigger?.click(); return Boolean(trigger); })()"), settled).toBe(true);
  await expect.poll(periodMenu, settled).toBe(true);
  expect(await evaluate("document.activeElement?.getAttribute('aria-checked')")).toBe("true");
  await ui("press", "--keys", "Escape");
  await expect.poll(periodMenu, settled).toBe(false);
  expect(await settings()).toBe(true);
  expect(await evaluate("document.activeElement?.getAttribute('aria-label') ?? ''")).toMatch(/^Period: /);
  await ui("press", "--keys", "Escape");
  await expect.poll(settings, settled).toBe(false);
  await ui("screenshot", "--out", `${fixture!.logPath}.desktop-layout.png`);
}, 720_000);
