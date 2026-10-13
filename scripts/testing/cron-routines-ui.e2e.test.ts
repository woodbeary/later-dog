import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";
import { resolveAgentBrowserBinary } from "../../server/browser-engine.ts";
import { waitForExit } from "../../server/testing/cleanup.ts";
import type { Routine } from "../../src/lib/routines.ts";
import { runControlLaterDog } from "../control-laterdog.ts";
import { UI_TOOLS_DIR } from "./control-laterdog-ui.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const enabled = process.env.LATERDOG_UI_E2E === "1" || Boolean(resolveAgentBrowserBinary({ dataDir: UI_TOOLS_DIR, env: process.env }));
let child: ChildProcess | undefined;
afterAll(() => waitForExit(child, { signal: "SIGINT", graceMs: 30_000 }));

(enabled ? it : it.skip)("edits monthly and custom cron routines from the dog's settings, validates cron, and keeps arbitrary expressions", async () => {
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
  const fill = (selector: string, value: string) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event('input', { bubbles: true })); return field.value; })()`);
  const select = (label: string, value: string) => evaluate(`(() => { const field = document.querySelector('select[aria-label=${JSON.stringify(label)}]') ?? [...document.querySelectorAll('label')].find(label => label.firstElementChild?.textContent === ${JSON.stringify(label)})?.control; field.value = ${JSON.stringify(value)}; field.dispatchEvent(new Event('change', { bubbles: true })); return field.value; })()`);
  const routines = async (): Promise<Routine[]> => (await fetch(`${fixture.url}/api/routines`).then(response => response.json())).routines;
  const repeatOptions = () => evaluate("[...document.querySelector('select[aria-label=Repeat]').options].map(option => option.value)");
  const openOverlap = () => evaluate(`(() => {
    const field = document.querySelector('select[aria-label="If the previous run is still working"]');
    const details = field.closest('details');
    if (!details.open) details.querySelector('summary').click();
    field.scrollIntoView({ block: 'center' });
    return field.getBoundingClientRect().height > 0;
  })()`);

  const editor = "document.querySelector('[role=dialog][aria-label=\"Edit calendar event\"]')";
  const saveRoutine = () => evaluate(`[...${editor}.querySelectorAll('button')].find(button => button.textContent === 'Save').click(); true`);
  const openRoutine = async (id: string) => {
    await expect.poll(() => evaluate(`Boolean(document.querySelector('[data-routine="${id}"]')) && !${editor}`), { timeout: 10_000 }).toBe(true);
    await evaluate(`document.querySelector('[data-routine="${id}"]').click(); true`);
    await expect.poll(() => evaluate(`Boolean(${editor}?.querySelector('select[aria-label=Repeat]'))`), { timeout: 10_000 }).toBe(true);
  };
  const create = async (body: Record<string, unknown>) => {
    const response = await fetch(`${fixture.url}/api/routines`, { method: "POST", headers: { "content-type": "application/json", origin: fixture.url }, body: JSON.stringify({ botId: fixture.botId, enabled: false, runOn: "dog", ...body }) });
    expect(response.status).toBe(201);
    return (await response.json()).routine as Routine;
  };
  const monthly = await create({ name: "Monthly close", prompt: "Summarize this fixture only.", overlap: "queue", schedule: { type: "cron", expression: "0 9 L * *", timeZone: "UTC" } });
  const customSchedule = { type: "cron", expression: "15 9-17/2 * * 1-5", timeZone: "America/New_York" };
  const custom = await create({ name: "Business-hours report", prompt: "Use only the fixture.", schedule: customSchedule });

  const state = await ui("snapshot", "--interactive");
  const profile = Object.entries(state.refs as Record<string, { role: string; name: string }>).find(([, entry]) => entry.role === "button" && /^Open .+'s profile$/.test(entry.name));
  expect(profile).toBeDefined();
  await ui("click", "--ref", `@${profile![0]}`);
  await openRoutine(monthly.id);
  expect(await evaluate(`${editor}.querySelector('input').value`)).toBe("Monthly close");
  expect(await evaluate(`[...${editor}.querySelectorAll('button')].some(button => button.textContent === 'Call')`)).toBe(false);
  expect(await repeatOptions()).toEqual(expect.arrayContaining(["monthly", "yearly", "cron"]));
  expect(await evaluate("document.querySelector('select[aria-label=Repeat]').value")).toBe("monthly");
  expect(await openOverlap()).toBe(true);
  expect(await evaluate('document.querySelector(\'select[aria-label="If the previous run is still working"]\').value')).toBe("queue");
  await expect.poll(() => evaluate('document.querySelectorAll(\'[aria-label="Next scheduled runs"] time\').length')).toBe(3);
  await evaluate('document.querySelector(\'[aria-label="Next scheduled runs"]\').scrollIntoView({ block: "center" })');
  await ui("screenshot", "--out", `${fixture!.logPath}.cron-monthly.png`);
  await select("Repeat", "cron");
  expect(await evaluate('document.querySelector(\'input[placeholder="0 9 1 * *"]\').value')).toBe("0 9 L * *");
  await fill('input[placeholder="0 9 1 * *"]', "0 9 31 2 *");
  await expect.poll(() => evaluate("document.querySelector('#routine-cron-error')?.textContent")).toContain("no future runs");
  expect(await evaluate(`[...${editor}.querySelectorAll('button')].find(button => button.textContent === 'Save').disabled`)).toBe(true);
  await select("Repeat", "monthly");
  await expect.poll(() => evaluate('document.querySelectorAll(\'[aria-label="Next scheduled runs"] time\').length')).toBe(3);
  await saveRoutine();
  await expect.poll(() => evaluate(`!${editor}`), { timeout: 10_000 }).toBe(true);
  expect((await routines()).find(routine => routine.id === monthly.id)).toMatchObject({ name: "Monthly close", overlap: "queue", prompt: "Summarize this fixture only.", schedule: { type: "cron", expression: "0 9 L * *", timeZone: "UTC" } });

  await openRoutine(monthly.id);
  expect(await openOverlap()).toBe(true);
  await select("If the previous run is still working", "skip");
  await select("Repeat", "yearly");
  await select("Month", "2"); await select("Day of month", "29");
  await saveRoutine();
  await expect.poll(async () => (await routines()).find(routine => routine.id === monthly.id)?.schedule).toEqual({ type: "cron", expression: "0 9 29 2 *", timeZone: "UTC" });
  expect((await routines()).find(routine => routine.id === monthly.id)?.overlap).toBeUndefined();

  await openRoutine(custom.id);
  expect(await evaluate("document.querySelector('select[aria-label=Repeat]').value")).toBe("cron");
  expect(await evaluate('document.querySelector(\'input[list="routine-time-zones"]\').value')).toBe("America/New_York");
  await fill('input[placeholder="What should happen?"]', "Renamed report");
  await saveRoutine();
  await expect.poll(async () => (await routines()).find(routine => routine.id === custom.id)?.name).toBe("Renamed report");
  expect((await routines()).find(routine => routine.id === custom.id)?.schedule).toEqual(customSchedule);
  const browserConsole = await ui("console");
  expect((browserConsole.messages as Array<{ type: string }>).filter(message => message.type === "error")).toEqual([]);
  console.log(`Cron UI evidence: ${fixture!.logPath}.cron-monthly.png`);
}, 720_000);
