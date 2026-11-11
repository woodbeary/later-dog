import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HELD_UNTIL_UP } from "../deploy/laterdog/home/src/desk.ts";
import { launchVerificationServer } from "./control-laterdog.ts";
import { PAGE_PROBE, WELCOME_VERSION, composerOf, distribution, open, settled, type Distribution, type Dog, type Page } from "./desktop-perf.ts";
import { startFixtureEdge, type FixtureEdge } from "./testing/fixture-edge.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NOT_SENT_LINE = "Your home never took this message, so it was not sent. It is kept below to send again.";
const SENTENCE = "Can you also check whether the release notes mention the bigger chat text and the new usage sheet, and fix them if not?";
const SECOND_DRAFT = "Remind me to look at the pricing line on Friday";
const PROSE = "The release checklist is done apart from the two items that need you. The signed build finished and passed its smoke tests on both window sizes, the update guide names the new group and the rollback target, and the pull request is merged. The long dog names fit their rows, the usage sheet opens from the menu, and the bigger chat text holds on the small window. Nothing else changed in this pass, so the next step is yours once you have looked at the screenshots and confirmed the pricing line before Friday.";
const FIRST_PIECE = 12;
const QUICK = { everyMs: 30, chars: FIRST_PIECE };
const SELECTED = 6;

type Theme = "light" | "dark";
type WakePage = Page & { screenshot(options: { path: string; type: "jpeg"; quality: number }): Promise<unknown>; reload(): Promise<unknown> };
type Browser = { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<WakePage>; close(): Promise<void> }>; close(): Promise<void> };

interface Setup {
  out: string;
  shots: string | null;
  playwright: string;
  browser: string;
  label: string;
  runs: number;
  awakeRuns: number;
  wakeMs: number;
  dropMs: number;
}

interface Run {
  index: number;
  theme: Theme;
  shots: string | null;
}

interface Dogs {
  awake: Dog;
  wake: Dog;
  busy: Dog;
  dropped: Dog;
  reconnect: Dog;
  reload: Dog;
  typing: Dog;
  drafts: Dog;
  notes: Dog;
  stale: Dog;
  streamers: [Dog, Dog, Dog];
}

interface EngineWatch {
  started(needle: string, timeoutMs?: number): Promise<number>;
  stop(): void;
}

interface World {
  setup: Setup;
  edge: FixtureEdge;
  home: ReturnType<typeof fixtureApi>;
  browser: Browser;
  dogs: Dogs;
  engine: EngineWatch;
  streamFile: string;
}

interface Look {
  bubbles: number;
  waitingBubbles: number;
  sendingBubbles: number;
  tray: string[];
  trayButtons: string[];
  notSent: string[];
  lines: string[];
  statuses: string[];
  composer: string;
  answers: number;
  raw: string[];
}

interface Split {
  kind: string;
  uiMs: number;
  networkMs: number;
  wakeMs: number;
  queueMs: number;
  engineMs: number;
  totalMs: number;
  queuedRowMs: number | null;
  homeReadyToAcceptedMs: number | null;
  shownAs: string;
}

interface Check {
  name: string;
  ok: boolean;
  defect?: true;
  saw?: unknown;
}

interface CaseResult {
  case: string;
  run: number;
  theme: Theme;
  checks: Check[];
  splits: Split[];
  looks: Record<string, Look>;
  numbers: Record<string, number | Distribution>;
}

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : process.argv[index + 1];
  if (value === undefined) throw new Error(`desktop-wake needs --${name}`);
  return value;
}

function setupFromArgs(): Setup {
  return {
    out: resolve(option("out", ".laterdog-scratch/desktop-wake/result.json")),
    shots: process.argv.includes("--shots") ? resolve(option("shots")) : null,
    playwright: resolve(option("playwright", process.env.PLAYWRIGHT_HOME)),
    browser: option("browser", process.env.PERF_BROWSER ?? "/usr/bin/chromium"),
    label: option("label", "run"),
    runs: Math.max(1, Number(option("runs", "2"))),
    awakeRuns: Math.max(1, Number(option("awake-runs", "10"))),
    wakeMs: Number(option("wake-ms", "5000")),
    dropMs: Number(option("drop-ms", "4000")),
  };
}

const WAKE_PROBE = `(() => {
  const wake = { enterAt: null };
  window.__wake = wake;
  wake.wall = () => performance.timeOrigin + performance.now();
  wake.log = () => (document.querySelector('[role="log"]') || { textContent: "" }).textContent || "";
  wake.tray = () => [...document.querySelectorAll('[aria-label="Queued messages"] li')];
  wake.newest = () => (wake.log().match(/Answer \\d+\\./g) || []).reduce((most, answer) => Math.max(most, Number(answer.slice(7, -1))), 0);
  wake.failed = () => [...document.querySelectorAll("span")].filter((span) => (span.textContent || "").startsWith("Not sent:"));
  addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) wake.enterAt = performance.timeOrigin + event.timeStamp; }, true);
})();`;

type InPage = {
  __perf: { until(test: () => boolean, timeoutMs: number): Promise<number>; begin(): void; end(): { keys: number[]; longTasks: number; longTaskMs: number; worstFrameMs: number; slowFrames: number } };
  __wake: { enterAt: number | null; wall(): number; log(): string; tray(): Element[]; newest(): number; failed(): Element[] };
};

type Sight = "not sent" | "waiting bubble" | "no tray" | "in tray" | "sent bubble";

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const token = () => randomUUID().slice(0, 8);
const round = (value: number) => Math.round(value);
const numbered = (index: number) => String(index).padStart(4, "0");
const answerOf = (index: number) => `Answer ${numbered(index)}.`;
const endOf = (index: number) => `End of answer ${numbered(index)}.`;

function stream(world: World, plan: { everyMs: number; chars: number }): void {
  writeFileSync(world.streamFile, JSON.stringify(plan));
}

function watchEngine(file: string): EngineWatch {
  const starts: Array<{ at: number; prompt: string }> = [];
  let offset = 0;
  let partial = Buffer.alloc(0);
  const read = () => {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      return;
    }
    if (size <= offset) return;
    const bytes = Buffer.alloc(size - offset);
    const handle = openSync(file, "r");
    try {
      readSync(handle, bytes, 0, bytes.length, offset);
    } finally {
      closeSync(handle);
    }
    offset = size;
    const at = Date.now();
    const whole = Buffer.concat([partial, bytes]);
    const end = whole.lastIndexOf(10);
    partial = whole.subarray(end + 1);
    for (const prompt of whole.subarray(0, end + 1).toString("utf8").split("\n")) if (prompt) starts.push({ at, prompt });
  };
  const timer = setInterval(read, 2);
  return {
    async started(needle, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const start = starts.find((each) => each.prompt.includes(needle));
        if (start) return start.at;
        if (Date.now() > deadline) throw new Error(`the engine never got "${needle}" within ${timeoutMs} ms`);
        await pause(2);
      }
    },
    stop: () => clearInterval(timer),
  };
}

async function look(page: WakePage, needle: string, answer = ""): Promise<Look> {
  return page.evaluate(({ needle, answer }: { needle: string; answer: string }) => {
    const wake = (window as unknown as InPage).__wake;
    const text = (node: Element) => (node as HTMLElement).innerText?.trim() ?? "";
    const rows = [...document.querySelectorAll('[role="log"] [data-from="user"]')].filter((row) => (row.textContent ?? "").includes(needle)).map((row) => row.closest("[data-mid]") ?? row);
    const queued = wake.tray().filter((row) => (row.textContent ?? "").includes(needle));
    const log = wake.log();
    const said = [...document.querySelectorAll('[role="status"], [role="alert"]')].map(text).filter(Boolean);
    return {
      bubbles: rows.length,
      waitingBubbles: rows.filter((row) => row.querySelector("[data-send-held]")).length,
      sendingBubbles: rows.filter((row) => row.querySelector("[data-sending-track]")).length,
      tray: queued.map((row) => text(row.querySelector("span") ?? row)),
      trayButtons: wake.tray().flatMap((row) => [...row.querySelectorAll("button")].map((button) => text(button) || button.getAttribute("aria-label") || "")),
      notSent: wake.failed().map(text).filter((line) => line.includes(needle)),
      lines: [...document.querySelectorAll("[data-pane-error]")].map(text),
      statuses: [...new Set(said)],
      composer: (document.querySelector('textarea[aria-label^="Message "]') as HTMLTextAreaElement | null)?.value ?? "",
      answers: answer ? log.split(answer).length - 1 : 0,
      raw: [...new Set(document.body.innerText.match(/\[object Object\]|undefined|TypeError|Failed to fetch|NaN|\b50[234]\b|Unexpected token/g) ?? [])],
    };
  }, { needle, answer });
}

async function typeAndSend(page: WakePage, dog: Dog, words: string): Promise<{ enterAt: number; shownAt: number; where: "bubble" | "tray" }> {
  await page.click(composerOf(dog));
  await page.keyboard.type(words, { delay: 5 });
  const shown = page.evaluate(async (needle: string) => {
    const { __perf: perf, __wake: wake } = window as unknown as InPage;
    wake.enterAt = null;
    await perf.until(() => wake.enterAt !== null, 30_000);
    const listed = () => wake.tray().some((row) => (row.textContent ?? "").includes(needle));
    await perf.until(() => wake.log().includes(needle) || listed(), 30_000);
    return { enterAt: wake.enterAt!, shownAt: wake.wall(), where: wake.log().includes(needle) ? "bubble" as const : "tray" as const };
  }, words);
  await page.waitForTimeout(50);
  await page.keyboard.press("Enter");
  return shown;
}

async function newestAnswer(page: WakePage): Promise<number> {
  return page.evaluate(() => (window as unknown as InPage).__wake.newest());
}

function firstWords(page: WakePage, after: number, timeoutMs = 180_000): Promise<{ at: number; index: number }> {
  return page.evaluate(async ({ after, timeoutMs }: { after: number; timeoutMs: number }) => {
    const { __perf: perf, __wake: wake } = window as unknown as InPage;
    await perf.until(() => wake.newest() > after, timeoutMs);
    return { at: wake.wall(), index: wake.newest() };
  }, { after, timeoutMs });
}

function seenInPage(page: WakePage, kind: Sight, needle: string, timeoutMs = 30_000): Promise<number> {
  return page.evaluate(async ({ kind, needle, timeoutMs }: { kind: Sight; needle: string; timeoutMs: number }) => {
    const { __perf: perf, __wake: wake } = window as unknown as InPage;
    const listed = () => wake.tray().some((row) => (row.textContent ?? "").includes(needle));
    const bubbles = () => [...document.querySelectorAll('[role="log"] [data-from="user"]')].filter((row) => (row.textContent ?? "").includes(needle)).map((row) => row.closest("[data-mid]") ?? row);
    await perf.until(() => {
      if (kind === "not sent") return wake.failed().some((row) => (row.textContent ?? "").includes(needle));
      if (kind === "no tray") return !listed();
      if (kind === "in tray") return listed();
      if (kind === "sent bubble") return !listed() && bubbles().some((row) => !row.querySelector("[data-send-held]"));
      return bubbles().some((row) => row.querySelector("[data-send-held]"));
    }, timeoutMs);
    return wake.wall();
  }, { kind, needle, timeoutMs });
}

async function press(page: WakePage, label: string, within = "body"): Promise<boolean> {
  return page.evaluate(({ label, within }: { label: string; within: string }) => {
    const button = [...document.querySelectorAll(`${within} button`)].find((candidate) => (candidate as HTMLElement).innerText.trim() === label || candidate.getAttribute("aria-label") === label) as HTMLElement | undefined;
    button?.click();
    return Boolean(button);
  }, { label, within });
}

type HomeBots = { bots: Array<{ id: string; busy?: boolean; activity?: string; messages?: Array<{ role: string; text?: string }> }> };

async function homeCount(world: World, dog: Dog, needle: string): Promise<number> {
  const state = await world.home("GET", "/api/bots?messages=200") as HomeBots;
  return (state.bots.find((bot) => bot.id === dog.id)?.messages ?? []).filter((message) => message.role === "user" && message.text?.includes(needle)).length;
}

async function homeAnswer(world: World, dog: Dog, answer: string): Promise<string> {
  const state = await world.home("GET", "/api/bots?messages=200") as HomeBots;
  return (state.bots.find((bot) => bot.id === dog.id)?.messages ?? []).find((message) => message.role === "bot" && message.text?.startsWith(answer))?.text ?? "";
}

async function working(world: World, dogs: readonly Dog[]): Promise<number> {
  const state = await world.home("GET", "/api/bots") as HomeBots;
  return state.bots.filter((bot) => dogs.some((dog) => dog.id === bot.id) && (bot.busy || bot.activity === "working")).length;
}

async function rest(world: World, dog: Dog): Promise<void> {
  await pause(150);
  await settled(world.home, [dog.id], 180_000);
}

async function ready(page: WakePage, dog: Dog): Promise<void> {
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
  await open(page, dog);
  await page.waitForTimeout(400);
}

async function desk(world: World, run: Run, dog: Dog): Promise<{ page: WakePage; close(): Promise<void> }> {
  const context = await world.browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: run.theme });
  await context.addInitScript(PAGE_PROBE);
  await context.addInitScript(WAKE_PROBE);
  const page = await context.newPage();
  await page.goto(world.edge.url);
  await ready(page, dog);
  return { page, close: () => context.close() };
}

async function reloadWithFreshSave(world: World, page: WakePage, dog: Dog): Promise<void> {
  world.edge.saveNextAnswers();
  await page.reload();
  await ready(page, dog);
}

function recorder(run: Run, name: string, short: string) {
  const result: CaseResult = { case: name, run: run.index, theme: run.theme, checks: [], splits: [], looks: {}, numbers: {} };
  const check = (label: string, ok: boolean, saw?: unknown) => {
    result.checks.push({ name: label, ok, ...(ok || saw === undefined ? {} : { saw }) });
  };
  const defect = (label: string, ok: boolean, saw?: unknown) => {
    result.checks.push({ name: label, ok, ...(ok ? {} : { defect: true as const, ...(saw === undefined ? {} : { saw }) }) });
  };
  const seen = (label: string, state: Look) => {
    result.looks[label] = state;
    check(`${label}: no raw error text on screen`, state.raw.length === 0, state.raw);
  };
  const shoot = async (page: WakePage, state: string) => {
    if (run.shots) await page.screenshot({ path: join(run.shots, `${short}-${state}.jpg`), type: "jpeg", quality: 55 });
  };
  return { result, check, defect, seen, shoot };
}

async function awakeSend(world: World, page: WakePage, dog: Dog, words: string): Promise<{ split: Split; index: number; answer: string }> {
  const newest = await newestAnswer(page);
  const started = Date.now();
  const reply = firstWords(page, newest);
  const shown = await typeAndSend(page, dog, words);
  const taken = await world.edge.seen("sent", { after: started }, 30_000);
  const engineAt = await world.engine.started(words);
  const first = await reply;
  return {
    index: first.index,
    answer: answerOf(first.index),
    split: {
      kind: "awake",
      uiMs: round(shown.shownAt - shown.enterAt),
      networkMs: round(taken.at - shown.shownAt),
      wakeMs: 0,
      queueMs: round(engineAt - taken.at),
      engineMs: round(first.at - engineAt),
      totalMs: round(first.at - shown.enterAt),
      queuedRowMs: null,
      homeReadyToAcceptedMs: null,
      shownAs: shown.where,
    },
  };
}

async function awake(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(run, "0. send to a home that is awake", "0-awake");
  const dog = world.dogs.awake;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, QUICK);
    await awakeSend(world, page, dog, `Warm the chat up ${token()}`);
    await rest(world, dog);
    for (let index = 0; index < world.setup.awakeRuns; index += 1) {
      await page.waitForTimeout(600);
      const words = `Where does the release stand? ${token()}`;
      const sent = await awakeSend(world, page, dog, words);
      result.splits.push(sent.split);
      if (index === 0) await shoot(page, "1-reply-streaming");
      await rest(world, dog);
      await page.waitForTimeout(500);
      const done = await look(page, words, sent.answer);
      if (index === 0) {
        seen("sent and answered", done);
        await shoot(page, "2-answered");
      }
      check(`send ${index + 1}: one bubble, nothing waiting, one reply`, done.bubbles === 1 && done.tray.length === 0 && done.waitingBubbles === 0 && done.answers === 1 && done.notSent.length === 0, { bubbles: done.bubbles, tray: done.tray, answers: done.answers });
      check(`send ${index + 1}: the home took it once`, await homeCount(world, dog, words) === 1);
    }
  } finally {
    await close();
  }
  return result;
}

async function slowWake(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(run, "a. send while the home is asleep, then it wakes", "a-wake");
  const dog = world.dogs.wake;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, QUICK);
    const awakeWords = `Where does the release stand? ${token()}`;
    const before = await awakeSend(world, page, dog, awakeWords);
    await rest(world, dog);
    await reloadWithFreshSave(world, page, dog);
    const wakingAt = Date.now();
    world.edge.sleep();
    world.edge.wakeIn(world.setup.wakeMs);
    await page.waitForTimeout(1_500);
    const asleep = await look(page, awakeWords, before.answer);
    seen("while waking, before sending", asleep);
    check("the chat from before the home slept is still on screen while it wakes", asleep.bubbles === 1 && asleep.answers === 1, { bubbles: asleep.bubbles, answers: asleep.answers });
    await shoot(page, "1-asleep-before-sending");

    const heldWords = `Run the checks again please ${token()}`;
    const newest = await newestAnswer(page);
    const started = Date.now();
    const shown = await typeAndSend(page, dog, heldWords);
    const held = await world.edge.seen("held", { after: started }, 15_000);
    const queuedRowAt = await seenInPage(page, "in tray", heldWords, 15_000);
    await page.waitForTimeout(300);
    const waiting = await look(page, heldWords);
    seen("held", waiting);
    check("the held message shows once, as a queued row with its words", waiting.tray.length === 1 && waiting.bubbles === 0 && waiting.tray[0]!.includes(heldWords), { tray: waiting.tray, bubbles: waiting.bubbles });
    check("the queued row offers Edit and Delete", waiting.trayButtons.includes("Edit queued message 1 of 1") && waiting.trayButtons.includes("Delete queued message 1 of 1"), waiting.trayButtons);
    check("the box is empty again after sending", waiting.composer === "", waiting.composer);
    await shoot(page, "2-queued");
    const reply = firstWords(page, newest);
    const serving = await world.edge.seen("serving", { after: wakingAt }, world.setup.wakeMs + 15_000);
    const delivered = await world.edge.seen("delivered", { id: held.id }, 30_000);
    const sentRowAt = await seenInPage(page, "sent bubble", heldWords, 30_000);
    const engineAt = await world.engine.started(heldWords);
    const first = await reply;
    await shoot(page, "3-sent-reply-streaming");
    await rest(world, dog);
    await page.waitForTimeout(700);
    const done = await look(page, heldWords, answerOf(first.index));
    seen("delivered", done);
    check("after the wake: one bubble, nothing queued, one reply", done.bubbles === 1 && done.tray.length === 0 && done.waitingBubbles === 0 && done.answers === 1, { bubbles: done.bubbles, tray: done.tray, waiting: done.waitingBubbles, answers: done.answers });
    check("the reply on screen is whole", (await look(page, heldWords, endOf(first.index))).answers === 1);
    check("the home took the message once", await homeCount(world, dog, heldWords) === 1);
    check("the edge delivered it once", world.edge.events.filter((event) => event.kind === "delivered" && event.id === held.id).length === 1);
    const earlier = await look(page, awakeWords, before.answer);
    check("the earlier exchange is still there once", earlier.bubbles === 1 && earlier.answers === 1, { bubbles: earlier.bubbles, answers: earlier.answers });
    await shoot(page, "4-answered");
    result.splits.push({
      kind: `held through a ${world.setup.wakeMs / 1000} s wake`,
      uiMs: round(shown.shownAt - shown.enterAt),
      networkMs: round(held.at - shown.shownAt),
      wakeMs: round(delivered.at - held.at),
      queueMs: round(engineAt - delivered.at),
      engineMs: round(first.at - engineAt),
      totalMs: round(first.at - shown.enterAt),
      queuedRowMs: round(queuedRowAt - shown.enterAt),
      homeReadyToAcceptedMs: round(delivered.at - serving.at),
      shownAs: shown.where,
    });
    result.numbers["home accepted to the row showing as sent, ms"] = round(sentRowAt - delivered.at);
    result.numbers["sent before the home was ready by, ms"] = round(serving.at - held.at);
  } finally {
    await close();
  }
  return result;
}

async function sendNowAndCancel(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(run, "b. Send now and cancel on a held row while the home wakes", "b-held-row");
  const dog = world.dogs.busy;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, { everyMs: 250, chars: FIRST_PIECE });
    const jobWords = `Start the long job ${token()}`;
    const job = await awakeSend(world, page, dog, jobWords);
    stream(world, QUICK);
    await reloadWithFreshSave(world, page, dog);
    const wakingAt = Date.now();
    world.edge.sleep();
    world.edge.wakeIn(world.setup.wakeMs + 6_000);
    await page.waitForTimeout(1_500);

    const keptWords = `Also check the release notes ${token()}`;
    let started = Date.now();
    await typeAndSend(page, dog, keptWords);
    const first = await world.edge.seen("held", { after: started }, 15_000);
    await seenInPage(page, "in tray", keptWords, 15_000);
    await page.waitForTimeout(300);
    const waiting = await look(page, keptWords);
    seen("held while the dog is working", waiting);
    check("the held message is a queued row with Send now", waiting.tray.length === 1 && waiting.trayButtons.includes("Send now"), { tray: waiting.tray, buttons: waiting.trayButtons });
    await shoot(page, "1-queued-dog-working");

    check("Send now can be pressed", await press(page, "Send now", '[aria-label="Queued messages"]'));
    const asked = await world.edge.seen("send-now", { id: first.id }, 10_000);
    await page.waitForTimeout(500);
    const answered = await look(page, keptWords);
    seen("Send now answer", answered);
    check("Send now answers in a sentence that says the message is waiting for the home", answered.lines.includes(HELD_UNTIL_UP), answered.lines);
    check("the message is still held after Send now", answered.tray.length === 1 && world.edge.held().includes(first.id), { tray: answered.tray, held: world.edge.held() });
    check("the edge answered Send now with 200", asked.status === 200, asked.status);
    await shoot(page, "2-send-now-answer");

    const secondWords = `And the pricing line ${token()}`;
    started = Date.now();
    await typeAndSend(page, dog, secondWords);
    const second = await world.edge.seen("held", { after: started }, 15_000);
    await seenInPage(page, "in tray", secondWords, 15_000);
    await page.waitForTimeout(300);
    const two = await look(page, secondWords);
    seen("two held", two);
    check("the second held message is listed too", two.tray.length === 1 && two.trayButtons.includes("Delete queued message 2 of 2"), { tray: two.tray, buttons: two.trayButtons });
    await shoot(page, "3-two-queued");
    check("cancel can be pressed", await press(page, "Delete queued message 2 of 2", '[aria-label="Queued messages"]'));
    await world.edge.seen("cancelled", { id: second.id }, 10_000);
    await seenInPage(page, "no tray", secondWords, 10_000);
    await page.waitForTimeout(300);
    const cancelled = await look(page, secondWords);
    seen("cancelled", cancelled);
    check("the cancelled message is gone from the list and the edge", cancelled.tray.length === 0 && cancelled.bubbles === 0 && !world.edge.held().includes(second.id), { tray: cancelled.tray, held: world.edge.held() });
    check("the cancelled message is not called Not sent", cancelled.notSent.length === 0, cancelled.notSent);
    const kept = await look(page, keptWords);
    check("the other held message is still listed", kept.tray.length === 1, kept.tray);
    check("the cancel happened while the home was still waking", world.edge.state() === "starting", world.edge.state());
    await shoot(page, "4-cancelled");

    const serving = await world.edge.seen("serving", { after: wakingAt }, world.setup.wakeMs + 20_000);
    const delivered = await world.edge.seen("delivered", { id: first.id }, 30_000);
    await rest(world, dog);
    await page.waitForTimeout(900);
    const done = await look(page, keptWords);
    seen("delivered after Send now", done);
    check("after the wake the kept message shows once and nothing is queued", done.bubbles === 1 && done.tray.length === 0 && done.waitingBubbles === 0, { bubbles: done.bubbles, tray: done.tray });
    check("the home took the kept message once", await homeCount(world, dog, keptWords) === 1);
    check("the home never saw the cancelled message", await homeCount(world, dog, secondWords) === 0);
    const gone = await look(page, secondWords);
    check("the cancelled message did not come back", gone.bubbles === 0 && gone.tray.length === 0 && gone.notSent.length === 0, { bubbles: gone.bubbles, tray: gone.tray, notSent: gone.notSent });
    const before = await look(page, jobWords, job.answer);
    check("the long job and its reply are still there once", before.bubbles === 1 && before.answers === 1, { bubbles: before.bubbles, answers: before.answers });
    await shoot(page, "5-after-the-wake");
    result.numbers["held to accepted by the home, ms"] = round(delivered.at - first.at);
    result.numbers["home ready to accepted by the home, ms"] = round(delivered.at - serving.at);
  } finally {
    await close();
  }
  return result;
}

async function dropped(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(run, "c. the home refuses a held message, and a hold runs out", "c-not-sent");
  const dog = world.dogs.dropped;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, QUICK);
    for (const why of ["refused", "expired"] as const) {
      const words = `${why === "refused" ? "Ship the build" : "Draft the update note"} ${token()}`;
      world.edge.sleep();
      if (why === "refused") {
        world.edge.refuseNextDelivery(409);
        world.edge.wakeIn(4_000);
      }
      await page.waitForTimeout(1_200);
      const started = Date.now();
      await typeAndSend(page, dog, words);
      const held = await world.edge.seen("held", { after: started }, 15_000);
      await seenInPage(page, "in tray", words, 15_000);
      await shoot(page, `${why}-1-queued`);
      if (why === "expired") {
        await page.waitForTimeout(500);
        await world.edge.expireHeld();
        world.edge.serve();
      }
      const lost = await world.edge.seen(why, { id: held.id }, 30_000);
      const up = await world.edge.seen("serving", { after: started }, 30_000);
      const toldAt = await seenInPage(page, "not sent", words, 45_000);
      await page.waitForTimeout(300);
      const state = await look(page, words);
      seen(`Not sent (${why})`, state);
      check(`${why}: the row says Not sent and keeps the words`, state.notSent.length === 1 && state.notSent[0]!.includes(words), state.notSent);
      check(`${why}: nothing is left queued or shown as sent`, state.tray.length === 0 && state.bubbles === 0, { tray: state.tray, bubbles: state.bubbles });
      check(`${why}: a sentence says why`, state.lines.includes(NOT_SENT_LINE), state.lines);
      check(`${why}: the home has not seen it`, await homeCount(world, dog, words) === 0);
      await shoot(page, `${why}-2-not-sent`);
      result.numbers[`${why}: Not sent shown after the home was ready, ms`] = round(toldAt - Math.max(lost.at, up.at));

      const newest = await newestAnswer(page);
      const again = Date.now();
      const reply = firstWords(page, newest);
      check(`${why}: Retry can be pressed`, await press(page, "Retry"));
      const taken = await world.edge.seen("sent", { id: held.id, after: again }, 30_000);
      const engineAt = await world.engine.started(words);
      const first = await reply;
      await rest(world, dog);
      await page.waitForTimeout(700);
      const done = await look(page, words, answerOf(first.index));
      seen(`sent again (${why})`, done);
      check(`${why}: sent again it shows once with one reply and no Not sent row`, done.bubbles === 1 && done.answers === 1 && done.notSent.length === 0 && done.tray.length === 0, { bubbles: done.bubbles, answers: done.answers, notSent: done.notSent });
      check(`${why}: the sentence is gone after Retry`, !done.lines.includes(NOT_SENT_LINE), done.lines);
      check(`${why}: the home took it once`, await homeCount(world, dog, words) === 1);
      check(`${why}: the edge no longer calls it dropped`, !world.edge.dropped().some((send) => send.id === held.id), world.edge.dropped());
      await shoot(page, `${why}-3-sent-again`);
      result.numbers[`${why}: Retry to accepted by the home, ms`] = round(taken.at - again);
      result.numbers[`${why}: Retry to first reply words, ms`] = round(first.at - again);
      result.numbers[`${why}: Retry, home accepted to engine start, ms`] = round(engineAt - taken.at);
    }
  } finally {
    await close();
  }
  return result;
}

async function boxOf(page: WakePage, dog: Dog): Promise<string> {
  return page.evaluate((selector: string) => (document.querySelector(selector) as HTMLTextAreaElement | null)?.value ?? "", composerOf(dog));
}

async function clearBox(page: WakePage, dog: Dog): Promise<void> {
  await open(page, dog);
  await page.click(composerOf(dog));
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
}

async function reconnect(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(run, "d. the connection drops mid-reply and comes back", "d-reconnect");
  const dog = world.dogs.reconnect;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, { everyMs: 150, chars: FIRST_PIECE });
    const words = `Show me the function you changed ${token()}`;
    const sent = await awakeSend(world, page, dog, words);
    stream(world, QUICK);
    await page.waitForTimeout(1_500);
    await shoot(page, "1-reply-streaming");
    const lengthAtCut = (await page.evaluate(() => (window as unknown as InPage).__wake.log())).length;
    const cutAt = Date.now();
    world.edge.dropConnection(world.setup.dropMs);
    await page.waitForTimeout(600);
    const during = `Anything still waiting on me? ${token()}`;
    const shown = await typeAndSend(page, dog, during);
    await seenInPage(page, "waiting bubble", during, 15_000);
    await page.waitForTimeout(200);
    await page.click(composerOf(dog));
    await page.keyboard.type(SECOND_DRAFT, { delay: 5 });
    const cut = await look(page, during);
    seen("connection down", cut);
    check("a message sent while the connection is down shows once as Not sent yet", cut.bubbles === 1 && cut.waitingBubbles === 1, { bubbles: cut.bubbles, waiting: cut.waitingBubbles });
    const partial = await look(page, words, sent.answer);
    check("the reply that was streaming stays on screen while the connection is down", partial.bubbles === 1 && partial.answers === 1, { bubbles: partial.bubbles, answers: partial.answers });
    check("the reply was cut before it finished", (await look(page, words, endOf(sent.index))).answers === 0);
    check("a draft typed while the connection is down is in the box", cut.composer === SECOND_DRAFT, cut.composer);
    await shoot(page, "2-connection-down");
    const back = await world.edge.seen("connection-back", { after: cutAt }, world.setup.dropMs + 5_000);
    const taken = await world.edge.seen("sent", { after: back.at }, 40_000);
    const engineAt = await world.engine.started(during);
    const second = await firstWords(page, sent.index);
    await shoot(page, "3-back-second-reply-streaming");
    await rest(world, dog);
    await page.waitForTimeout(900);
    const whole = await homeAnswer(world, dog, sent.answer);
    const first = await look(page, words, sent.answer);
    seen("after reconnecting", first);
    const tail = await look(page, words, endOf(sent.index));
    check("the cut reply is whole and shown once", first.bubbles === 1 && first.answers === 1 && tail.answers === 1 && whole.endsWith(endOf(sent.index)), { bubbles: first.bubbles, starts: first.answers, ends: tail.answers });
    const onScreen = await page.evaluate((text: string) => (window as unknown as InPage).__wake.log().includes(text), whole);
    check("the reply on screen is the reply the home has", onScreen && whole.length > 0);
    const late = await look(page, during, answerOf(second.index));
    check("the message sent while down shows once with one reply and nothing waiting", late.bubbles === 1 && late.waitingBubbles === 0 && late.answers === 1, { bubbles: late.bubbles, waiting: late.waitingBubbles, answers: late.answers });
    check("the home took each message once", await homeCount(world, dog, words) === 1 && await homeCount(world, dog, during) === 1);
    check("the draft is still in the box after the connection came back", first.composer === SECOND_DRAFT, first.composer);
    await shoot(page, "4-after-reconnecting");
    result.splits.push({
      kind: "sent while the connection was down",
      uiMs: round(shown.shownAt - shown.enterAt),
      networkMs: round(taken.at - shown.shownAt),
      wakeMs: 0,
      queueMs: round(engineAt - taken.at),
      engineMs: round(second.at - engineAt),
      totalMs: round(second.at - shown.enterAt),
      queuedRowMs: null,
      homeReadyToAcceptedMs: null,
      shownAs: shown.where,
    });
    result.numbers["connection down, ms"] = round(back.at - cutAt);
    result.numbers["connection back to the held message accepted by the home, ms"] = round(taken.at - back.at);
    result.numbers["reply characters on screen when the connection dropped"] = lengthAtCut;
    await clearBox(page, dog);
    await page.waitForTimeout(400);
  } finally {
    await close();
  }
  return result;
}

async function reloadWhileHeld(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(run, "e. the app reloads while a message is held", "e-reload");
  const dog = world.dogs.reload;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, QUICK);
    const wakingAt = Date.now();
    world.edge.sleep();
    world.edge.wakeIn(world.setup.wakeMs + 9_000);
    await page.waitForTimeout(1_500);
    const words = `Hold this until you are up ${token()}`;
    const started = Date.now();
    await typeAndSend(page, dog, words);
    const held = await world.edge.seen("held", { after: started }, 15_000);
    await seenInPage(page, "in tray", words, 15_000);
    await page.waitForTimeout(300);
    seen("held before the reload", await look(page, words));
    await shoot(page, "1-queued");
    const reloadAt = Date.now();
    await page.reload();
    await ready(page, dog);
    result.numbers["reload to the chat open again while waking, ms"] = Date.now() - reloadAt;
    check("the reload happened while the home was still waking", world.edge.state() === "starting", world.edge.state());
    const after = await look(page, words);
    seen("held after the reload", after);
    check("the held row is still there after the reload, once, with its words", after.tray.length === 1 && after.tray[0]!.includes(words) && after.bubbles === 0, { tray: after.tray, bubbles: after.bubbles });
    check("the held message is not called Not sent after the reload", after.notSent.length === 0, after.notSent);
    check("the edge still holds it", world.edge.held().includes(held.id), world.edge.held());
    await shoot(page, "2-queued-after-reload");
    const newest = await newestAnswer(page);
    const reply = firstWords(page, newest);
    const serving = await world.edge.seen("serving", { after: wakingAt }, world.setup.wakeMs + 25_000);
    const delivered = await world.edge.seen("delivered", { id: held.id }, 30_000);
    const first = await reply;
    await rest(world, dog);
    await page.waitForTimeout(900);
    const done = await look(page, words, answerOf(first.index));
    seen("delivered after the reload", done);
    check("after the wake: one bubble, nothing queued, one reply", done.bubbles === 1 && done.tray.length === 0 && done.answers === 1 && done.notSent.length === 0, { bubbles: done.bubbles, tray: done.tray, answers: done.answers, notSent: done.notSent });
    check("the home took the message once", await homeCount(world, dog, words) === 1);
    await shoot(page, "3-answered");
    result.numbers["home ready to accepted by the home, ms"] = round(delivered.at - serving.at);
  } finally {
    await close();
  }
  return result;
}

interface Typed {
  keys: Distribution;
  longTasks: number;
  longTaskMs: number;
  worstFrameMs: number;
  slowFrames: number;
}

async function typed(page: WakePage, dog: Dog, words: string): Promise<Typed> {
  await page.click(composerOf(dog));
  await page.evaluate(() => (window as unknown as InPage).__perf.begin());
  await page.keyboard.type(words, { delay: 35 });
  await page.waitForTimeout(300);
  const spent = await page.evaluate(() => (window as unknown as InPage).__perf.end());
  return { keys: distribution(spent.keys), longTasks: spent.longTasks, longTaskMs: round(spent.longTaskMs), worstFrameMs: round(spent.worstFrameMs), slowFrames: spent.slowFrames };
}

async function caret(page: WakePage, dog: Dog): Promise<{ start: number; end: number; focused: boolean; open: string }> {
  return page.evaluate((selector: string) => {
    const box = document.querySelector(selector) as HTMLTextAreaElement | null;
    const shown = document.querySelector('textarea[aria-label^="Message "]')?.getAttribute("aria-label") ?? "";
    return { start: box?.selectionStart ?? -1, end: box?.selectionEnd ?? -1, focused: document.activeElement === box, open: shown };
  }, composerOf(dog));
}

async function threeDogs(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(run, "f. three dogs stream replies while the person types in a fourth chat", "f-three-dogs");
  const { typing, streamers } = world.dogs;
  const { page, close } = await desk(world, run, typing);
  try {
    const quiet = await typed(page, typing, SENTENCE);
    await clearBox(page, typing);
    await page.waitForTimeout(400);
    stream(world, { everyMs: 50, chars: 4 });
    const asks = streamers.map((dog) => ({ dog, words: `Walk me through the release ${token()}` }));
    await Promise.all(asks.map(({ dog, words }) => world.home("POST", `/api/bots/${dog.id}/messages`, { text: words, threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") })));
    await Promise.all(asks.map(({ words }) => world.engine.started(words)));
    stream(world, QUICK);
    await page.waitForTimeout(300);
    const busy = await typed(page, typing, SENTENCE);
    const stillWorking = await working(world, streamers);
    check("all three dogs were still replying when the typing ended", stillWorking === 3, stillWorking);
    check("every key landed in the fourth chat's box", await boxOf(page, typing) === SENTENCE, await boxOf(page, typing));
    for (let index = 0; index < SELECTED; index += 1) await page.keyboard.press("Shift+ArrowLeft");
    const selected = await caret(page, typing);
    check("the last word is selected in the box", selected.end - selected.start === SELECTED && selected.end === SENTENCE.length && selected.focused, selected);
    await shoot(page, "1-typing-while-three-reply");
    await settled(world.home, streamers.map((dog) => dog.id), 180_000);
    await page.waitForTimeout(900);
    const after = await caret(page, typing);
    check("the selection is the same after the three replies finished", after.start === selected.start && after.end === selected.end && after.focused, after);
    check("the fourth chat is still the open one", after.open === `Message ${typing.name}`, after.open);
    check("the draft is the same after the three replies finished", await boxOf(page, typing) === SENTENCE, await boxOf(page, typing));
    await page.keyboard.type("again?", { delay: 20 });
    check("typing over the selection replaces only the selected word", await boxOf(page, typing) === `${SENTENCE.slice(0, -SELECTED)}again?`, await boxOf(page, typing));
    const state = await look(page, SENTENCE);
    seen("after the three replies", state);
    check("nothing was sent from the fourth chat", state.bubbles === 0 && state.tray.length === 0, { bubbles: state.bubbles, tray: state.tray });
    const previews = await page.evaluate((ids: string[]) => ids.map((id) => (document.querySelector(`[data-sidebar-bot-row=${JSON.stringify(id)}]`) as HTMLElement | null)?.innerText ?? ""), streamers.map((dog) => dog.id));
    check("each of the three dogs shows its finished reply in the sidebar", previews.every((preview) => /Answer \d+\./.test(preview)), previews);
    await shoot(page, "2-after-three-replies");
    result.numbers["key to frame with no dog working, ms"] = quiet.keys;
    result.numbers["key to frame while three dogs reply, ms"] = busy.keys;
    result.numbers["long tasks while typing, no dog working"] = quiet.longTasks;
    result.numbers["long tasks while typing, three dogs replying"] = busy.longTasks;
    result.numbers["long task time while typing, three dogs replying, ms"] = busy.longTaskMs;
    result.numbers["worst frame while typing, no dog working, ms"] = quiet.worstFrameMs;
    result.numbers["worst frame while typing, three dogs replying, ms"] = busy.worstFrameMs;
    result.numbers["frames over 25 ms while typing, three dogs replying"] = busy.slowFrames;
    await clearBox(page, typing);
    await page.waitForTimeout(400);
  } finally {
    await close();
  }
  return result;
}

async function whileWaking(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(run, "g. typing, drafts and moving between chats while the home wakes", "g-drafts");
  const { drafts, notes } = world.dogs;
  const { page, close } = await desk(world, run, drafts);
  try {
    result.numbers["key to frame while the home is up, ms"] = (await typed(page, drafts, SENTENCE)).keys;
    await clearBox(page, drafts);
    world.edge.sleep();
    world.edge.wakeIn(world.setup.wakeMs + 14_000);
    await page.waitForTimeout(1_500);
    result.numbers["key to frame while the home wakes, ms"] = (await typed(page, drafts, SENTENCE)).keys;
    check("every key landed in the box", await boxOf(page, drafts) === SENTENCE, await boxOf(page, drafts));
    await shoot(page, "1-typing-while-waking");
    const away = await open(page, notes).catch(() => -1);
    check("another chat opens while the home wakes", away >= 0);
    await page.click(composerOf(notes));
    await page.keyboard.type(SECOND_DRAFT, { delay: 5 });
    await page.waitForTimeout(400);
    const backAgain = await open(page, drafts).catch(() => -1);
    check("the first chat opens again while the home wakes", backAgain >= 0);
    check("the draft is still in its chat after switching away and back", await boxOf(page, drafts) === SENTENCE, await boxOf(page, drafts));
    result.numbers["open another chat while waking, ms"] = round(away);
    result.numbers["come back to the first chat while waking, ms"] = round(backAgain);
    const reloadAt = Date.now();
    await page.reload();
    await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
    result.numbers["reload to message box while waking, ms"] = Date.now() - reloadAt;
    check("the reload happened while the home was still waking", world.edge.state() === "starting", world.edge.state());
    await open(page, drafts);
    check("the draft is still there after a reload", await boxOf(page, drafts) === SENTENCE, await boxOf(page, drafts));
    await open(page, notes);
    check("the other chat's draft is still there after a reload", await boxOf(page, notes) === SECOND_DRAFT, await boxOf(page, notes));
    const state = await look(page, SECOND_DRAFT);
    seen("while waking", state);
    await shoot(page, "2-drafts-after-reload");
    result.numbers["status lines shown while waking"] = state.statuses.length + state.lines.length;
    await world.edge.seen("serving", { after: reloadAt }, world.setup.wakeMs + 30_000);
    await page.waitForTimeout(1_500);
    await clearBox(page, drafts);
    await clearBox(page, notes);
    await page.waitForTimeout(400);
  } finally {
    await close();
  }
  return result;
}

async function staleSavedChat(world: World, run: Run): Promise<CaseResult> {
  const { result, check, defect, seen, shoot } = recorder(run, "h. the home stops soon after a reply", "h-older-copy");
  const dog = world.dogs.stale;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, QUICK);
    for (const idleMs of [0, 8_000]) {
      const label = idleMs ? `${idleMs / 1000} s after the reply` : "right after the reply";
      const words = `Where does the release stand? ${token()}`;
      const sent = await awakeSend(world, page, dog, words);
      await rest(world, dog);
      await page.waitForTimeout(500 + idleMs);
      const shownBefore = await look(page, words, sent.answer);
      check(`${label}: the exchange is on screen before the home stops`, shownBefore.bubbles === 1 && shownBefore.answers === 1, { bubbles: shownBefore.bubbles, answers: shownBefore.answers });
      const wakingAt = Date.now();
      world.edge.sleep();
      world.edge.wakeIn(world.setup.wakeMs);
      await page.waitForTimeout(2_000);
      const asleep = await look(page, words, sent.answer);
      seen(`home stopped ${label}`, asleep);
      defect(`home stopped ${label}: the newest exchange stays on screen while the home wakes`, asleep.bubbles === 1 && asleep.answers === 1, { bubbles: asleep.bubbles, answers: asleep.answers });
      await shoot(page, `${idleMs ? "2" : "1"}-waking-${idleMs ? "after-idle" : "right-after-reply"}`);
      await world.edge.seen("serving", { after: wakingAt }, world.setup.wakeMs + 15_000);
      await page.waitForTimeout(2_500);
      const up = await look(page, words, sent.answer);
      check(`${label}: the exchange is on screen once the home is up`, up.bubbles === 1 && up.answers === 1, { bubbles: up.bubbles, answers: up.answers });
    }
    await shoot(page, "3-home-up-again");
  } finally {
    await close();
  }
  return result;
}

async function seed(home: ReturnType<typeof fixtureApi>): Promise<Dogs> {
  await home("PATCH", "/api/config", { language: "en", onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });
  const make = async (name: string): Promise<Dog> => {
    const created = await home("POST", "/api/bots", { name }) as { bot: Dog };
    return { id: created.bot.id, name: created.bot.name, threadId: created.bot.threadId };
  };
  const dogs: Dogs = {
    awake: await make("Pacer"),
    wake: await make("Marathon"),
    busy: await make("Builder"),
    dropped: await make("Courier"),
    reconnect: await make("Scout"),
    reload: await make("Keeper"),
    typing: await make("Typist"),
    drafts: await make("Scribe"),
    notes: await make("Ledger"),
    stale: await make("Archivist"),
    streamers: [await make("Runner"), await make("Fetcher"), await make("Digger")],
  };
  const asks = ["Where does the release stand?", "Anything still waiting on me?"];
  const all = [...Object.values(dogs).filter((dog): dog is Dog => !Array.isArray(dog)), ...dogs.streamers];
  for (const group of [all.slice(0, 5), all.slice(5, 10), all.slice(10)]) {
    await Promise.all(group.map(async (dog) => {
      for (const ask of asks) {
        await home("POST", `/api/bots/${dog.id}/messages`, { text: ask, threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") });
        await pause(40);
        await settled(home, [dog.id]);
      }
    }));
  }
  return dogs;
}

function spread(values: readonly number[]): string {
  if (values.length === 0) return "none";
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return `${middle} (${sorted[0]} to ${sorted.at(-1)}, ${sorted.length} ${sorted.length === 1 ? "run" : "runs"})`;
}

function table(cases: readonly CaseResult[]): string {
  const splits = cases.flatMap((result) => result.splits);
  const kinds = [...new Set(splits.map((split) => split.kind))];
  const column = (kind: string, pick: (split: Split) => number | null) => spread(splits.filter((split) => split.kind === kind).flatMap((split) => pick(split) ?? []));
  const rows: Array<[string, (split: Split) => number | null]> = [
    ["UI: Enter to own words on screen", (split) => split.uiMs],
    ["Network: own words on screen to the edge's answer", (split) => split.networkMs],
    ["Wake: the edge's answer to the home accepting the message", (split) => split.wakeMs],
    ["of which after the home was ready", (split) => split.homeReadyToAcceptedMs],
    ["Queue: home accepted to the engine getting the message", (split) => split.queueMs],
    ["Engine: engine got the message to first reply words on screen", (split) => split.engineMs],
    ["Whole: Enter to first reply words", (split) => split.totalMs],
    ["Enter to the row showing as queued", (split) => split.queuedRowMs],
  ];
  return [
    `| Step, ms: median (lowest to highest, runs) | ${kinds.join(" | ")} |`,
    `|---|${kinds.map(() => "---").join("|")}|`,
    ...rows.map(([name, pick]) => `| ${name} | ${kinds.map((kind) => column(kind, pick)).join(" | ")} |`),
  ].join("\n");
}

async function main() {
  const setup = setupFromArgs();
  const staticDir = resolve(option("dist", join(ROOT, "dist")));
  if (!existsSync(join(staticDir, "index.html"))) throw new Error("build the renderer first: pnpm exec vite build");
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-desktop-wake-"));
  const streamFile = join(scratch, "stream.json");
  const repliesFile = join(scratch, "replies.json");
  const promptsFile = join(scratch, "prompts.jsonl");
  writeFileSync(streamFile, JSON.stringify(QUICK));
  writeFileSync(repliesFile, JSON.stringify(Array.from({ length: 3000 }, (_, index) => `${answerOf(index + 1)} ${PROSE} ${endOf(index + 1)}`)));
  const fixture = await launchVerificationServer({
    ...process.env,
    LATERDOG_TEST_STATIC_DIR: staticDir,
    FAKE_CLAUDE_REPLIES_FILE: repliesFile,
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-index"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_STREAM_FILE: streamFile,
    FAKE_CLAUDE_PROMPTS: promptsFile,
  });
  const edge = await startFixtureEdge({ home: fixture.info.url });
  const engine = watchEngine(promptsFile);
  const { chromium } = createRequire(join(setup.playwright, "package.json"))("playwright-core") as { chromium: { launch(options: unknown): Promise<Browser> } };
  const browser = await chromium.launch({ executablePath: setup.browser, args: ["--no-sandbox"] });
  try {
    const home = fixtureApi(fixture.info.url);
    const world: World = { setup, edge, home, browser, dogs: await seed(home), engine, streamFile };
    if (setup.shots) mkdirSync(setup.shots, { recursive: true });
    const only = process.argv.includes("--only") ? option("only").split("") : null;
    const everything: Array<[string, (world: World, run: Run) => Promise<CaseResult>, boolean]> = [
      ["0", awake, true],
      ["a", slowWake, false],
      ["b", sendNowAndCancel, false],
      ["c", dropped, false],
      ["d", reconnect, false],
      ["e", reloadWhileHeld, false],
      ["f", threeDogs, false],
      ["g", whileWaking, false],
      ["h", staleSavedChat, false],
    ];
    const scenarios = everything.filter(([letter]) => !only || only.includes(letter));
    const cases: CaseResult[] = [];
    const everyDog = [...Object.values(world.dogs).filter((dog): dog is Dog => !Array.isArray(dog)), ...world.dogs.streamers];
    for (let index = 0; index < setup.runs; index += 1) {
      const run: Run = { index: index + 1, theme: index === 1 ? "dark" : "light", shots: index === 0 ? setup.shots : null };
      for (const [, scenario, once] of scenarios) {
        if (once && index > 0) continue;
        const started = Date.now();
        try {
          cases.push(await scenario(world, run));
        } catch (error) {
          cases.push({ case: scenario.name, run: run.index, theme: run.theme, checks: [{ name: "the case ran to the end", ok: false, saw: error instanceof Error ? error.message : String(error) }], splits: [], looks: {}, numbers: {} });
        }
        edge.serve();
        stream(world, QUICK);
        await pause(300);
        await settled(home, everyDog.map((dog) => dog.id), 180_000).catch(() => undefined);
        const last = cases.at(-1)!;
        process.stderr.write(`run ${run.index} ${last.case}: ${last.checks.filter((check) => !check.ok && !check.defect).length} failed, ${last.checks.filter((check) => check.defect).length} known defects seen, ${Math.round((Date.now() - started) / 1000)} s\n`);
      }
    }
    const notOk = cases.flatMap((result) => result.checks.filter((check) => !check.ok).map((check) => ({ case: result.case, run: result.run, ...check })));
    const failed = notOk.filter((check) => !check.defect);
    const defects = notOk.filter((check) => check.defect);
    const result = {
      label: setup.label,
      at: new Date().toISOString(),
      setup: { ...setup, renderer: "production build served by the fixture home through the fixture edge", platform: `${process.platform} ${process.arch}`, injected: { wakeMs: setup.wakeMs, connectionDownMs: setup.dropMs, replyStream: `${QUICK.chars} characters every ${QUICK.everyMs} ms` } },
      passed: cases.reduce((sum, each) => sum + each.checks.filter((check) => check.ok).length, 0),
      failed,
      defects,
      table: table(cases),
      cases,
    };
    mkdirSync(dirname(setup.out), { recursive: true });
    writeFileSync(setup.out, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${result.table}\n\n${result.passed} checks passed, ${failed.length} failed, ${defects.length} known defects seen\n${JSON.stringify([...failed, ...defects], null, 2)}\n`);
  } finally {
    engine.stop();
    await browser.close();
    await edge.close();
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
