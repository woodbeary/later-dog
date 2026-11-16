import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CLOUD_COMPUTER_TOOLS, computerToolsFor, runCloudComputerTool, type CloudComputerResult, type RemoteExec } from "../../server/cloud-computer-tools.ts";
import type { AppConfig } from "../../server/config.ts";
import { PAGE_TOOLS } from "../../server/laterdog/page-tools.ts";
import { FIXTURE_ACCOUNT, FIXTURE_ANSWERS, startFixtureSite } from "./fixture-site.ts";
import { byText, Cdp, finish, FORM, stepTable, summaryTable, type Mode, type Step, type TaskName, type TaskRun } from "./measure.ts";
import { localExec, refIn } from "./no-vision.ts";
import { imageTokens, jpegSize, textTokens } from "./screen-commands.ts";

const ON = { features: { browser: true } } as AppConfig;
const OFF = {} as AppConfig;
const progress = (line: string) => process.stderr.write(`${line}\n`);

class Caller {
  steps: Step[] = [];
  turn = 0;
  last: CloudComputerResult | null = null;
  private exec: RemoteExec;
  private cfg: AppConfig;
  constructor(exec: RemoteExec, cfg: AppConfig) {
    this.exec = exec;
    this.cfg = cfg;
  }

  async call(tool: string, args: Record<string, unknown> = {}, sameTurn = false): Promise<string> {
    if (!sameTurn) this.turn++;
    progress(`${tool} ${JSON.stringify(args).slice(0, 80)}`);
    const started = performance.now();
    const result = await runCloudComputerTool(this.cfg, "fixture", tool, args, new AbortController().signal, undefined, undefined, this.exec);
    const seconds = (performance.now() - started) / 1000;
    this.last = result;
    const images = result.content.filter((part) => part.type === "image") as Array<{ data: string }>;
    const texts = result.content.filter((part) => part.type === "text");
    const imageBytes = images.reduce((sum, part) => sum + part.data.length, 0);
    const imageTokenCount = images.reduce((sum, part) => {
      const size = jpegSize(Buffer.from(part.data, "base64"));
      return sum + (size ? imageTokens(size.width, size.height) : 0);
    }, 0);
    const textBytes = Buffer.byteLength(JSON.stringify(texts));
    const argBytes = Buffer.byteLength(JSON.stringify(args));
    this.steps.push({ turn: this.turn, tool, argBytes, textBytes, imageBytes, imageTokens: imageTokenCount, tokens: textTokens(argBytes + textBytes) + imageTokenCount, seconds });
    const text = texts.map((part) => (part as { text: string }).text).join("\n");
    if (result.isError) throw new Error(`${tool} failed: ${text.slice(0, 400)}`);
    return text;
  }

  record(step: Step): void {
    this.turn++;
    this.steps.push({ ...step, turn: this.turn });
  }
}

async function pageTasks(origin: string, exec: RemoteExec, cdp: Cdp, withRun: boolean): Promise<TaskRun[]> {
  const mode: Mode = withRun ? "page + run" : "page";
  const runs: TaskRun[] = [];
  {
    const c = new Caller(exec, ON);
    const shop = await c.call("page_open", { url: `${origin}/shop` });
    const price = /Blue Kettle · (\$[\d.]+)/.exec(shop)?.[1] ?? "";
    const policy = await c.call("page_click", { ref: refIn(shop, "link", "Shipping policy") });
    const threshold = /free on orders over (\$\d+)/.exec(policy)?.[1] ?? "";
    runs.push(finish("find", mode, c.steps, `${price}; free over ${threshold}`, price === FIXTURE_ANSWERS.find.price && threshold === FIXTURE_ANSWERS.find.threshold));
  }
  {
    const c = new Caller(exec, ON);
    const form = await c.call("page_open", { url: `${origin}/contact` });
    const fields: Array<[string, string, string]> = [["textbox", "Full name", FORM.name], ["textbox", "Email", FORM.email], ["textbox", "Phone", FORM.phone], ["textbox", "Message", FORM.message]];
    let done: string;
    if (withRun) {
      done = await c.call("run_actions", { steps: [
        ...fields.map(([kind, label, text]) => ({ action: "page_fill", ref: refIn(form, kind, label), text })),
        { action: "page_select", ref: refIn(form, "select", "Topic"), option: FORM.topic },
        { action: "page_click", ref: refIn(form, "button", "Send message") },
      ] });
    } else {
      c.turn++;
      for (const [kind, label, text] of fields) await c.call("page_fill", { ref: refIn(form, kind, label), text }, true);
      await c.call("page_select", { ref: refIn(form, "select", "Topic"), option: FORM.topic }, true);
      done = await c.call("page_click", { ref: refIn(form, "button", "Send message") });
    }
    const answer = /reference is (\S+?)\./.exec(done)?.[1] ?? "";
    runs.push(finish("form", mode, c.steps, answer, answer === FIXTURE_ANSWERS.form.reference));
  }
  {
    await cdp.send("Network.clearBrowserCookies");
    const c = new Caller(exec, ON);
    const wall = await c.call("page_open", { url: `${origin}/orders` });
    const steps = [
      { action: "page_fill", ref: refIn(wall, "textbox", "Username"), text: FIXTURE_ACCOUNT.username },
      { action: "page_fill", ref: refIn(wall, "password", "Password"), text: FIXTURE_ACCOUNT.password },
    ];
    let table: string;
    if (withRun) table = await c.call("run_actions", { steps: [...steps, { action: "page_click", ref: refIn(wall, "button", "Sign in") }] });
    else {
      c.turn++;
      for (const step of steps) await c.call("page_fill", { ref: step.ref, text: step.text }, true);
      table = await c.call("page_click", { ref: refIn(wall, "button", "Sign in") });
    }
    const row = table.split("\n").find((line) => line.includes(`#${FIXTURE_ANSWERS.table.order}`)) ?? "";
    runs.push(finish("table", mode, c.steps, row.trim(), row.includes(FIXTURE_ANSWERS.table.total) && row.includes(FIXTURE_ANSWERS.table.status)));
  }
  return runs;
}

type Point = { x: number; y: number; visible: boolean };

async function screenTasks(origin: string, exec: RemoteExec, cdp: Cdp, scale: number, withRun: boolean): Promise<TaskRun[]> {
  const mode: Mode = withRun ? "screen capped + run" : "screen capped";
  const runs: TaskRun[] = [];
  const at = async (find: string): Promise<Point> => {
    const box = await cdp.evaluate<Point | null>(`(() => { const el = (${find}); if (!el) return null; const r = el.getBoundingClientRect();
      const left = window.screenX + (window.outerWidth - window.innerWidth) / 2, top = window.screenY + window.outerHeight - window.innerHeight;
      return { x: left + r.left + Math.min(r.width / 2, 40), y: top + r.top + r.height / 2, visible: r.top >= 0 && r.bottom <= window.innerHeight }; })()`);
    if (!box) throw new Error(`nothing on the page matches ${find}`);
    return { x: Math.round(box.x * scale), y: Math.round(box.y * scale), visible: box.visible };
  };
  const open = async (c: Caller, url: string) => {
    const started = performance.now();
    await cdp.send("Page.navigate", { url });
    const text = JSON.stringify([{ type: "text", text: "Browser launch requested. Page loading is not confirmed; inspect the screen before continuing." }]);
    const argBytes = Buffer.byteLength(JSON.stringify({ url }));
    c.record({ turn: 0, tool: "open_url", argBytes, textBytes: Buffer.byteLength(text), imageBytes: 0, imageTokens: 0, tokens: textTokens(argBytes + Buffer.byteLength(text)), seconds: (performance.now() - started) / 1000 });
    await cdp.settle();
  };
  const settle = async () => { await new Promise((r) => setTimeout(r, 300)); await cdp.settle(); };
  const middle = { x: Math.round(640 * scale), y: Math.round(450 * scale) };
  for (const task of ["find", "form", "table"] as TaskName[]) {
    await cdp.send("Network.clearBrowserCookies");
    const c = new Caller(exec, OFF);
    let answer = "";
    let correct = false;
    if (task === "find") {
      await open(c, `${origin}/shop`);
      await c.call("screenshot");
      for (let attempt = 0; attempt < 8 && !(await at(byText("a", "Shipping policy"))).visible; attempt++) {
        const scroll = { action: "scroll", ...middle, direction: "down", amount: 10 };
        if (withRun) await c.call("run_actions", { steps: [scroll] });
        else { await c.call("scroll", { x: middle.x, y: middle.y, direction: "down", amount: 10 }); await settle(); await c.call("screenshot"); }
      }
      const link = await at(byText("a", "Shipping policy"));
      if (withRun) await c.call("run_actions", { steps: [{ action: "click", x: link.x, y: link.y }, { action: "wait", ms: 800 }] });
      else { await c.call("click", { x: link.x, y: link.y }); await settle(); await c.call("screenshot"); }
      answer = await cdp.evaluate<string>("document.body.innerText.match(/free on orders over \\$\\d+/)?.[0] ?? ''");
      correct = answer.endsWith(FIXTURE_ANSWERS.find.threshold) && (await cdp.evaluate<string>("location.pathname")) === "/shipping";
    } else if (task === "form") {
      await open(c, `${origin}/contact`);
      await c.call("screenshot");
      const name = await at("document.getElementById('name')");
      const steps = [
        { action: "click", x: name.x, y: name.y }, { action: "type", text: FORM.name }, { action: "key", key: "Tab" },
        { action: "type", text: FORM.email }, { action: "key", key: "Tab" }, { action: "type", text: FORM.phone }, { action: "key", key: "Tab" },
        { action: "key", key: "b" }, { action: "key", key: "Tab" }, { action: "type", text: FORM.message }, { action: "key", key: "Tab" },
        { action: "key", key: "Return" },
      ];
      if (withRun) await c.call("run_actions", { steps: [...steps, { action: "wait", ms: 800 }] });
      else {
        for (const step of steps) await c.call(step.action === "type" ? "type_text" : step.action === "key" ? "key_press" : "click", step.action === "type" ? { text: step.text } : step.action === "key" ? { key: step.key } : { x: step.x, y: step.y });
        await settle();
        await c.call("screenshot");
      }
      answer = await cdp.evaluate<string>("document.body.innerText.match(/[A-Z]+-\\d{4}/)?.[0] ?? document.title");
      correct = answer === FIXTURE_ANSWERS.form.reference;
    } else {
      await open(c, `${origin}/orders`);
      await c.call("screenshot");
      const user = await at("document.getElementById('username')");
      const steps = [
        { action: "click", x: user.x, y: user.y }, { action: "type", text: FIXTURE_ACCOUNT.username }, { action: "key", key: "Tab" },
        { action: "type", text: FIXTURE_ACCOUNT.password }, { action: "key", key: "Return" },
      ];
      if (withRun) await c.call("run_actions", { steps: [...steps, { action: "wait", ms: 800 }] });
      else {
        for (const step of steps) await c.call(step.action === "type" ? "type_text" : step.action === "key" ? "key_press" : "click", step.action === "type" ? { text: step.text } : step.action === "key" ? { key: step.key } : { x: step.x, y: step.y });
        await settle();
        await c.call("screenshot");
      }
      answer = await cdp.evaluate<string>("[...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('#1042'))?.innerText ?? ''");
      correct = answer.includes(FIXTURE_ANSWERS.table.total) && answer.includes(FIXTURE_ANSWERS.table.status);
    }
    runs.push(finish(task, mode, c.steps, answer.replace(/\s+/g, " ").trim(), correct));
  }
  return runs;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    out: { type: "string" },
    chromium: { type: "string", default: "/usr/bin/chromium" },
    display: { type: "string", default: process.env.DISPLAY ?? ":0" },
  } });
  const out = resolve(values.out ?? `browser-steps-after-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const site = await startFixtureSite();
  const profile = mkdtempSync(join(tmpdir(), "laterdog-measure-after-"));
  const port = 9340 + Math.floor(Math.random() * 30);
  const browser: ChildProcess = spawn(values.chromium, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic",
    "--disable-dev-shm-usage", "--hide-crash-restore-bubble", "--window-position=0,0", "--window-size=1280,800", "--disable-features=Translate", "about:blank",
  ], { env: { ...process.env, DISPLAY: values.display }, stdio: "ignore" });
  const runs: TaskRun[] = [];
  try {
    const cdp = await Cdp.connect(port);
    await cdp.send("Page.enable");
    await new Promise((r) => setTimeout(r, 1500));
    const exec = localExec({ DISPLAY: values.display, LATERDOG_PAGE_CDP_PORT: String(port) });
    const sized = await runCloudComputerTool(OFF, "fixture", "get_screen_size", {}, new AbortController().signal, undefined, undefined, exec);
    const size = JSON.parse((sized.content[0] as { text: string }).text) as { stdout?: string };
    const [imageWidth] = String(size.stdout ?? "").trim().split(/\s+/).map(Number);
    const realWidth = Number((await exec("xdotool getdisplaygeometry", new AbortController().signal)).stdout.trim().split(/\s+/)[0]);
    const scale = imageWidth && realWidth ? imageWidth / realWidth : 1;
    progress(`screenshot coordinates: ${imageWidth} of ${realWidth} real pixels`);
    runs.push(...await pageTasks(site.origin, exec, cdp, false));
    runs.push(...await pageTasks(site.origin, exec, cdp, true));
    runs.push(...await screenTasks(site.origin, exec, cdp, scale, false));
    runs.push(...await screenTasks(site.origin, exec, cdp, scale, true));
    cdp.close();
  } finally {
    browser.kill("SIGTERM");
    await site.close();
    await new Promise((r) => setTimeout(r, 500));
    rmSync(profile, { recursive: true, force: true });
  }
  const toolLists = {
    screenToolsOff: Buffer.byteLength(JSON.stringify(computerToolsFor(OFF))),
    screenToolsOn: Buffer.byteLength(JSON.stringify(computerToolsFor(ON))),
    pageToolsOnly: Buffer.byteLength(JSON.stringify(PAGE_TOOLS)),
    runActionsOnly: Buffer.byteLength(JSON.stringify(CLOUD_COMPUTER_TOOLS.find((tool) => tool.name === "run_actions"))),
  };
  const ordered = (["find", "form", "table"] as TaskName[]).flatMap((task) => runs.filter((run) => run.task === task));
  writeFileSync(join(out, "results.json"), `${JSON.stringify({ runs: ordered, toolLists }, null, 2)}\n`);
  const summary = [
    "## Per task", "", summaryTable(ordered), "",
    `Tool definitions: screen tools with the browser switch off ${toolLists.screenToolsOff} bytes, on ${toolLists.screenToolsOn} bytes; the eight page tools ${toolLists.pageToolsOnly} bytes; run_actions ${toolLists.runActionsOnly} bytes.`, "",
    "## Per step", "", ...ordered.flatMap((run) => [stepTable(run), ""]),
  ].join("\n");
  writeFileSync(join(out, "summary.md"), summary);
  console.log(summary);
  console.log(`\nwrote ${out}`);
  process.exit(ordered.every((run) => run.correct) ? 0 : 1);
}

if (import.meta.main) await main();
