import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { agentBrowserIntegration, prepareBrowserSessionState } from "../../server/browser-engine.ts";
import { BrowserRuntime } from "../../server/browser-runtime.ts";
import { CLOUD_COMPUTER_TOOLS } from "../../server/cloud-computer-tools.ts";
import { FIXTURE_ACCOUNT, FIXTURE_ANSWERS, startFixtureSite } from "./fixture-site.ts";
import { imageTokens, jpegSize, SCREENSHOT_SCRIPT, screenActionResultText, screenCommand, textTokens, type ScreenAction } from "./screen-commands.ts";

type Mode = "structured" | "screen";
type TaskName = "find" | "form" | "table";

export interface Step {
  turn: number;
  tool: string;
  argBytes: number;
  textBytes: number;
  imageBytes: number;
  imageTokens: number;
  tokens: number;
  seconds: number;
}

export interface TaskRun {
  task: TaskName;
  mode: Mode;
  steps: Step[];
  toolCalls: number;
  modelTurns: number;
  tokens: number;
  imageTokens: number;
  imageShare: number;
  rereadTokens: number;
  toolSeconds: number;
  answer: string;
  correct: boolean;
}

const progress = (line: string) => process.stderr.write(`${line}\n`);

const TASKS: TaskName[] = ["find", "form", "table"];
const FORM = { name: "Ada Fixture", email: "ada@example.test", phone: "555-0100", topic: "Billing", message: "My kettle arrived without a lid." };

function finish(task: TaskName, mode: Mode, steps: Step[], answer: string, correct: boolean): TaskRun {
  const tokens = steps.reduce((sum, step) => sum + step.tokens, 0);
  const image = steps.reduce((sum, step) => sum + step.imageTokens, 0);
  const turns = Math.max(0, ...steps.map((step) => step.turn)) + 1;
  let context = 0;
  let reread = 0;
  for (let turn = 1; turn <= turns; turn++) {
    reread += context;
    context += steps.filter((step) => step.turn === turn).reduce((sum, step) => sum + step.tokens, 0);
  }
  return {
    task, mode, steps, answer, correct,
    toolCalls: steps.length,
    modelTurns: turns,
    tokens,
    imageTokens: image,
    imageShare: tokens ? image / tokens : 0,
    rereadTokens: reread,
    toolSeconds: steps.reduce((sum, step) => sum + step.seconds, 0),
  };
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content ?? [];
  return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
};

export function refFor(snapshot: string, role: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`- ${role} "${escaped}" \\[(?:[^\\]]*?, )?ref=(e\\d+)`).exec(snapshot);
  if (!match) throw new Error(`no ${role} "${name}" in the snapshot`);
  return `@${match[1]}`;
}

class StructuredCaller {
  steps: Step[] = [];
  turn = 0;
  private runtime: BrowserRuntime;
  private session: string;
  private spec: ReturnType<typeof agentBrowserIntegration>;
  constructor(runtime: BrowserRuntime, session: string, spec: ReturnType<typeof agentBrowserIntegration>) {
    this.runtime = runtime;
    this.session = session;
    this.spec = spec;
  }

  next(): void { this.turn++; }

  async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const started = performance.now();
    const result = await this.runtime.agentRpc(this.session, this.spec, "tools/call", { name: tool, arguments: args });
    const seconds = (performance.now() - started) / 1000;
    const content = (result as { content?: Array<{ type?: string; text?: string; data?: string }> })?.content ?? [];
    const textBytes = Buffer.byteLength(JSON.stringify(content.filter((part) => part.type !== "image")));
    const imageBytes = content.filter((part) => part.type === "image").reduce((sum, part) => sum + (part.data?.length ?? 0), 0);
    const argBytes = Buffer.byteLength(JSON.stringify(args));
    if ((result as { isError?: boolean })?.isError) throw new Error(`${tool} failed: ${textOf(result).slice(0, 300)}`);
    this.steps.push({ turn: this.turn, tool, argBytes, textBytes, imageBytes, imageTokens: 0, tokens: textTokens(argBytes + textBytes), seconds });
    progress(`structured ${tool} ${textBytes}B ${seconds.toFixed(2)}s`);
    return textOf(result);
  }
}

async function structuredTasks(origin: string, binary: string, home: string): Promise<TaskRun[]> {
  const env = { HOME: home, PATH: process.env.PATH ?? "", ...(process.env.AGENT_BROWSER_EXECUTABLE_PATH ? { AGENT_BROWSER_EXECUTABLE_PATH: process.env.AGENT_BROWSER_EXECUTABLE_PATH } : {}) };
  const runs: TaskRun[] = [];
  for (const task of TASKS) {
    const session = `measure-${task}`;
    await prepareBrowserSessionState(binary, session, { env, persistent: false });
    const spec = agentBrowserIntegration({ binaryPath: binary, session, encryptionKey: "0".repeat(64), persistent: false, env });
    const runtime = new BrowserRuntime();
    const caller = new StructuredCaller(runtime, session, spec);
    let answer = "";
    let correct = false;
    if (task === "find") {
      caller.next(); const opened = await caller.call("agent_browser_open", { url: `${origin}/shop` });
      caller.next(); const shop = await caller.call("agent_browser_read", {});
      const price = /Blue Kettle\*{0,2} · (\$[\d.]+)/.exec(shop)?.[1] ?? "";
      caller.next(); await caller.call("agent_browser_click", { selector: refFor(opened, "link", "Shipping policy") });
      caller.next(); const policy = await caller.call("agent_browser_read", {});
      const threshold = /free on orders over (\$\d+)/.exec(policy)?.[1] ?? "";
      answer = `${price}; free over ${threshold}`;
      correct = price === FIXTURE_ANSWERS.find.price && threshold === FIXTURE_ANSWERS.find.threshold;
    } else if (task === "form") {
      caller.next(); const form = await caller.call("agent_browser_open", { url: `${origin}/contact` });
      caller.next();
      await caller.call("agent_browser_fill", { selector: refFor(form, "textbox", "Full name"), text: FORM.name });
      await caller.call("agent_browser_fill", { selector: refFor(form, "textbox", "Email"), text: FORM.email });
      await caller.call("agent_browser_fill", { selector: refFor(form, "textbox", "Phone"), text: FORM.phone });
      await caller.call("agent_browser_select", { selector: refFor(form, "combobox", "Topic"), values: [FORM.topic] });
      await caller.call("agent_browser_fill", { selector: refFor(form, "textbox", "Message"), text: FORM.message });
      caller.next(); await caller.call("agent_browser_click", { selector: refFor(form, "button", "Send message") });
      caller.next(); const done = await caller.call("agent_browser_read", {});
      answer = /reference is \*{0,2}([A-Z]+-\d+)/.exec(done)?.[1] ?? "";
      correct = answer === FIXTURE_ANSWERS.form.reference;
    } else {
      caller.next(); const wall = await caller.call("agent_browser_open", { url: `${origin}/orders` });
      caller.next();
      await caller.call("agent_browser_fill", { selector: refFor(wall, "textbox", "Username"), text: FIXTURE_ACCOUNT.username });
      await caller.call("agent_browser_fill", { selector: refFor(wall, "textbox", "Password"), text: FIXTURE_ACCOUNT.password });
      caller.next(); await caller.call("agent_browser_click", { selector: refFor(wall, "button", "Sign in") });
      caller.next(); const table = await caller.call("agent_browser_read", {});
      answer = table.split("\n").find((line) => line.includes(`#${FIXTURE_ANSWERS.table.order}`)) ?? "";
      correct = answer.includes(FIXTURE_ANSWERS.table.total) && answer.includes(FIXTURE_ANSWERS.table.status);
    }
    await runtime.agentRpc(session, spec, "tools/call", { name: "agent_browser_close", arguments: {} }).catch(() => undefined);
    runs.push(finish(task, "structured", caller.steps, answer, correct));
  }
  return runs;
}

function run(command: string, display: string): Promise<{ ok: boolean; exitCode: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((settle) => {
    const child = spawn("bash", ["-c", command], { env: { ...process.env, DISPLAY: display }, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    let done = false;
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      child.stdout.destroy();
      child.stderr.destroy();
      settle({ ok: code === 0, exitCode: code, stdout: Buffer.concat(out), stderr });
    };
    child.on("close", finish);
    child.on("exit", (code) => { setTimeout(() => finish(code), 100); });
  });
}

class Cdp {
  private id = 0;
  private waiting = new Map<number, (value: any) => void>();
  private socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id === "number") this.waiting.get(message.id)?.(message);
    });
  }

  static async connect(port: number): Promise<Cdp> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = targets.find((target) => target.type === "page");
        if (page) {
          const socket = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise((ready, fail) => { socket.addEventListener("open", ready); socket.addEventListener("error", fail); });
          return new Cdp(socket);
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("the measuring browser did not open its debugging port");
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.id;
    return new Promise((done) => { this.waiting.set(id, done); this.socket.send(JSON.stringify({ id, method, params })); });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const reply = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return reply.result?.result?.value as T;
  }

  async settle(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await this.evaluate<string>("document.readyState").catch(() => "") === "complete") return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  close(): void { this.socket.close(); }
}

type Box = { x: number; y: number; visible: boolean };

class ScreenCaller {
  steps: Step[] = [];
  turn = 0;
  screenshots: Buffer[] = [];
  private cdp: Cdp;
  private display: string;
  constructor(cdp: Cdp, display: string) {
    this.cdp = cdp;
    this.display = display;
  }

  async openUrl(url: string): Promise<void> {
    progress(`screen open_url ${url}`);
    this.turn++;
    const started = performance.now();
    await this.cdp.send("Page.navigate", { url });
    const seconds = (performance.now() - started) / 1000;
    const text = JSON.stringify([{ type: "text", text: "Browser launch requested. Page loading is not confirmed; inspect the screen before continuing." }]);
    const argBytes = Buffer.byteLength(JSON.stringify({ url }));
    this.steps.push({ turn: this.turn, tool: "open_url", argBytes, textBytes: Buffer.byteLength(text), imageBytes: 0, imageTokens: 0, tokens: textTokens(argBytes + Buffer.byteLength(text)), seconds });
    await this.cdp.settle();
  }

  async screenshot(): Promise<void> {
    progress("screen screenshot");
    this.turn++;
    await this.cdp.settle();
    const started = performance.now();
    const result = await run(SCREENSHOT_SCRIPT, this.display);
    const seconds = (performance.now() - started) / 1000;
    if (!result.ok) throw new Error(`screenshot failed: ${result.stderr}`);
    const size = jpegSize(result.stdout);
    if (!size) throw new Error("the screenshot is not a JPEG");
    this.screenshots.push(result.stdout);
    const data = result.stdout.toString("base64");
    const tokens = imageTokens(size.width, size.height);
    this.steps.push({ turn: this.turn, tool: "screenshot", argBytes: 2, textBytes: 0, imageBytes: data.length, imageTokens: tokens, tokens: tokens + 1, seconds });
  }

  async act(action: ScreenAction): Promise<void> {
    progress(`screen ${action.tool}`);
    this.turn++;
    const started = performance.now();
    const result = await run(screenCommand(action), this.display);
    const seconds = (performance.now() - started) / 1000;
    const { tool, ...args } = action;
    const text = JSON.stringify([{ type: "text", text: screenActionResultText({ ok: result.ok, exitCode: result.exitCode, stdout: result.stdout.toString("utf8"), stderr: result.stderr }) }]);
    const argBytes = Buffer.byteLength(JSON.stringify(args));
    this.steps.push({ turn: this.turn, tool, argBytes, textBytes: Buffer.byteLength(text), imageBytes: 0, imageTokens: 0, tokens: textTokens(argBytes + Buffer.byteLength(text)), seconds });
    await new Promise((r) => setTimeout(r, 150));
  }

  async box(find: string): Promise<Box> {
    const box = await this.cdp.evaluate<Box | null>(`(() => { const el = (${find}); if (!el) return null; const r = el.getBoundingClientRect();
      const left = window.screenX + (window.outerWidth - window.innerWidth) / 2, top = window.screenY + window.outerHeight - window.innerHeight;
      return { x: Math.round(left + r.left + Math.min(r.width / 2, 40)), y: Math.round(top + r.top + r.height / 2), visible: r.top >= 0 && r.bottom <= window.innerHeight }; })()`);
    if (!box) throw new Error(`nothing on the page matches ${find}`);
    return box;
  }

  async scrollUntilVisible(find: string): Promise<Box> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const box = await this.box(find);
      if (box.visible) return box;
      await this.act({ tool: "scroll", x: 640, y: 450, direction: "down", amount: 10 });
      await this.screenshot();
    }
    throw new Error(`could not scroll ${find} into view`);
  }
}

const byText = (selector: string, text: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((el) => el.textContent.trim() === ${JSON.stringify(text)})`;

async function screenTasks(origin: string, display: string, chromium: string): Promise<{ runs: TaskRun[]; finalFrames: Record<TaskName, Buffer> }> {
  const profile = mkdtempSync(join(tmpdir(), "laterdog-measure-chromium-"));
  const port = 9300 + Math.floor(Math.random() * 30);
  const child: ChildProcess = spawn(chromium, [
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic",
    "--disable-dev-shm-usage", "--hide-crash-restore-bubble", "--window-position=0,0", "--window-size=1280,800", "--disable-features=Translate", "about:blank",
  ], { env: { ...process.env, DISPLAY: display }, stdio: "ignore" });
  const runs: TaskRun[] = [];
  const finalFrames = {} as Record<TaskName, Buffer>;
  try {
    progress(`screen: browser on ${display}, debugging port ${port}`);
    const cdp = await Cdp.connect(port);
    progress("screen: connected");
    await cdp.send("Page.enable");
    await new Promise((r) => setTimeout(r, 1500));
    for (const task of TASKS) {
      await cdp.send("Network.clearBrowserCookies");
      const caller = new ScreenCaller(cdp, display);
      let answer = "";
      let correct = false;
      if (task === "find") {
        await caller.openUrl(`${origin}/shop`);
        await caller.screenshot();
        await caller.scrollUntilVisible(byText("strong", "Blue Kettle"));
        const link = await caller.scrollUntilVisible(byText("a", "Shipping policy"));
        await caller.act({ tool: "click", x: link.x, y: link.y });
        await caller.screenshot();
        answer = await cdp.evaluate<string>("document.body.innerText.match(/free on orders over \\$\\d+/)?.[0] ?? ''");
        correct = answer.endsWith(FIXTURE_ANSWERS.find.threshold) && (await cdp.evaluate<string>("location.pathname")) === "/shipping";
      } else if (task === "form") {
        await caller.openUrl(`${origin}/contact`);
        await caller.screenshot();
        const name = await caller.box("document.getElementById('name')");
        await caller.act({ tool: "click", x: name.x, y: name.y });
        await caller.act({ tool: "type_text", text: FORM.name });
        await caller.act({ tool: "key_press", key: "Tab" });
        await caller.act({ tool: "type_text", text: FORM.email });
        await caller.act({ tool: "key_press", key: "Tab" });
        await caller.act({ tool: "type_text", text: FORM.phone });
        await caller.act({ tool: "key_press", key: "Tab" });
        await caller.act({ tool: "key_press", key: "b" });
        await caller.act({ tool: "key_press", key: "Tab" });
        await caller.act({ tool: "type_text", text: FORM.message });
        await caller.act({ tool: "key_press", key: "Tab" });
        await caller.act({ tool: "key_press", key: "Return" });
        await caller.screenshot();
        answer = await cdp.evaluate<string>("document.body.innerText.match(/[A-Z]+-\\d{4}/)?.[0] ?? document.title");
        correct = answer === FIXTURE_ANSWERS.form.reference;
      } else {
        await caller.openUrl(`${origin}/orders`);
        await caller.screenshot();
        const user = await caller.box("document.getElementById('username')");
        await caller.act({ tool: "click", x: user.x, y: user.y });
        await caller.act({ tool: "type_text", text: FIXTURE_ACCOUNT.username });
        await caller.act({ tool: "key_press", key: "Tab" });
        await caller.act({ tool: "type_text", text: FIXTURE_ACCOUNT.password });
        await caller.act({ tool: "key_press", key: "Return" });
        await caller.screenshot();
        const row = await caller.box(byText("td", "#1042"));
        if (!row.visible) await caller.scrollUntilVisible(byText("td", "#1042"));
        answer = await cdp.evaluate<string>("[...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('#1042'))?.innerText ?? ''");
        correct = answer.includes(FIXTURE_ANSWERS.table.total) && answer.includes(FIXTURE_ANSWERS.table.status);
      }
      runs.push(finish(task, "screen", caller.steps, answer.replace(/\s+/g, " ").trim(), correct));
      finalFrames[task] = caller.screenshots.at(-1)!;
    }
    cdp.close();
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    rmSync(profile, { recursive: true, force: true });
  }
  return { runs, finalFrames };
}

async function screenshotVariants(display: string): Promise<Array<{ label: string; bytes: number; base64: number; tokens: number; seconds: number }>> {
  const variants = [
    { label: "today: 1280x800 JPEG q75", command: SCREENSHOT_SCRIPT },
    { label: "1024x640 JPEG q60", command: `d=$(mktemp -d) && scrot --pointer --quality 60 --thumb 80 "$d/s.jpg" >/dev/null && cat -- "$d/s-thumb.jpg"; rm -rf "$d"` },
    { label: "794x496 JPEG q50", command: `d=$(mktemp -d) && scrot --pointer --quality 50 --thumb 62 "$d/s.jpg" >/dev/null && cat -- "$d/s-thumb.jpg"; rm -rf "$d"` },
  ];
  const out = [];
  for (const variant of variants) {
    const started = performance.now();
    const result = await run(variant.command, display);
    const seconds = (performance.now() - started) / 1000;
    const size = result.ok ? jpegSize(result.stdout) : null;
    out.push({ label: size ? variant.label.replace(/^[^:]*?(\d+x\d+)/, (all) => all) : `${variant.label} (failed: ${result.stderr.trim().slice(0, 80)})`,
      bytes: result.stdout.length, base64: Math.ceil(result.stdout.length / 3) * 4, tokens: size ? imageTokens(size.width, size.height) : 0, seconds });
  }
  return out;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;
const fixed = (value: number, digits = 2) => value.toFixed(digits);

export function summaryTable(runs: TaskRun[]): string {
  const lines = [
    "| Task | Path | Tool calls | Model turns (min) | Tokens added | Image share | Tokens re-read over the task | Tool seconds (sum) | Seconds per call (mean) | Done right |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const run of runs) {
    lines.push(`| ${run.task} | ${run.mode} | ${run.toolCalls} | ${run.modelTurns} | ${run.tokens} | ${pct(run.imageShare)} | ${run.rereadTokens} | ${fixed(run.toolSeconds)} | ${fixed(run.toolSeconds / Math.max(1, run.toolCalls))} | ${run.correct ? "yes" : "no"} |`);
  }
  return lines.join("\n");
}

export function stepTable(run: TaskRun): string {
  const lines = [`#### ${run.task}, ${run.mode}`, "", "| Turn | Tool | Bytes in result | Image bytes (base64) | Tokens | Seconds |", "| ---: | --- | ---: | ---: | ---: | ---: |"];
  for (const step of run.steps) lines.push(`| ${step.turn} | ${step.tool} | ${step.textBytes} | ${step.imageBytes} | ${step.tokens} | ${fixed(step.seconds, 3)} |`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    out: { type: "string" },
    engine: { type: "string" },
    chromium: { type: "string", default: "/usr/bin/chromium" },
    display: { type: "string", default: process.env.DISPLAY ?? ":0" },
    only: { type: "string" },
  } });
  if (!values.engine) throw new Error("--engine <path to the pinned agent-browser binary> is required");
  const out = resolve(values.out ?? `browser-steps-${Date.now()}`);
  mkdirSync(out, { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "laterdog-measure-home-"));
  const site = await startFixtureSite();
  const runs: TaskRun[] = [];
  let variants: Awaited<ReturnType<typeof screenshotVariants>> = [];
  try {
    if (values.only !== "screen") runs.push(...await structuredTasks(site.origin, resolve(values.engine), home));
    if (values.only !== "structured") {
      const screen = await screenTasks(site.origin, values.display, values.chromium);
      runs.push(...screen.runs);
      for (const [task, frame] of Object.entries(screen.finalFrames)) writeFileSync(join(out, `screen-${task}-final.jpg`), frame);
      variants = await screenshotVariants(values.display);
    }
  } finally {
    await site.close();
    rmSync(home, { recursive: true, force: true });
  }
  const toolLists = {
    screenToolsBytes: Buffer.byteLength(JSON.stringify(CLOUD_COMPUTER_TOOLS)),
  };
  const ordered = TASKS.flatMap((task) => runs.filter((run) => run.task === task));
  writeFileSync(join(out, "results.json"), `${JSON.stringify({ runs: ordered, variants, toolLists }, null, 2)}\n`);
  const summary = [
    "## Per task", "", summaryTable(ordered), "",
    "## Screenshot sizes", "", "| Variant | JPEG bytes | Base64 in the tool result | Image tokens | Seconds |", "| --- | ---: | ---: | ---: | ---: |",
    ...variants.map((variant) => `| ${variant.label} | ${variant.bytes} | ${variant.base64} | ${variant.tokens} | ${fixed(variant.seconds, 3)} |`), "",
    `Screen tool definitions: ${toolLists.screenToolsBytes} bytes.`, "",
    "## Per step", "", ...ordered.flatMap((run) => [stepTable(run), ""]),
  ].join("\n");
  writeFileSync(join(out, "summary.md"), summary);
  console.log(summary);
  console.log(`\nwrote ${out}`);
  process.exit(ordered.every((run) => run.correct) ? 0 : 1);
}

if (import.meta.main) await main();
