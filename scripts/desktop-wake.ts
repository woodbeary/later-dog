import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

type Theme = "light" | "dark";
type WakePage = Page & { screenshot(options: { path: string }): Promise<unknown>; reload(): Promise<unknown> };
type Browser = { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<WakePage>; close(): Promise<void> }>; close(): Promise<void> };

interface Setup {
  out: string;
  shots: string | null;
  playwright: string;
  browser: string;
  label: string;
  runs: number;
  wakeMs: number;
  dropMs: number;
}

interface Run {
  index: number;
  theme: Theme;
  shots: string | null;
}

interface Dogs {
  wake: Dog;
  busy: Dog;
  dropped: Dog;
  reconnect: Dog;
  drafts: Dog;
  notes: Dog;
}

interface World {
  setup: Setup;
  edge: FixtureEdge;
  home: ReturnType<typeof fixtureApi>;
  browser: Browser;
  dogs: Dogs;
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

interface Timeline {
  kind: "awake" | "held through a wake" | "sent again after Not sent" | "held on the device through a dropped connection";
  uiMs: number | null;
  acknowledgedMs: number | null;
  wakeMs: number | null;
  firstWakingAnswerMs: number | null;
  queueWaitMs: number | null;
  handedOverAfterReadyMs: number | null;
  engineMs: number;
  enterToFirstWordsMs: number | null;
  shownAs: string;
}

interface Check {
  name: string;
  ok: boolean;
  saw?: unknown;
}

interface CaseResult {
  case: string;
  run: number;
  theme: Theme;
  checks: Check[];
  timelines: Timeline[];
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
    runs: Math.max(1, Number(option("runs", "3"))),
    wakeMs: Number(option("wake-ms", "6000")),
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
  __perf: { until(test: () => boolean, timeoutMs: number): Promise<number>; begin(): void; end(): { keys: number[] } };
  __wake: { enterAt: number | null; wall(): number; log(): string; tray(): Element[]; newest(): number; failed(): Element[] };
};

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const token = () => randomUUID().slice(0, 8);
const round = (value: number) => Math.round(value);

function stream(world: World, everyMs: number, chars: number): void {
  writeFileSync(world.streamFile, JSON.stringify({ everyMs, chars }));
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

function firstWords(page: WakePage, after: number, timeoutMs = 120_000): Promise<{ at: number; answer: string }> {
  return page.evaluate(async ({ after, timeoutMs }: { after: number; timeoutMs: number }) => {
    const { __perf: perf, __wake: wake } = window as unknown as InPage;
    await perf.until(() => wake.newest() > after, timeoutMs);
    return { at: wake.wall(), answer: `Answer ${wake.newest()}.` };
  }, { after, timeoutMs });
}

async function seenInPage(page: WakePage, kind: "not sent" | "waiting bubble" | "no tray", needle: string, timeoutMs = 30_000): Promise<number> {
  return page.evaluate(async ({ kind, needle, timeoutMs }: { kind: string; needle: string; timeoutMs: number }) => {
    const { __perf: perf, __wake: wake } = window as unknown as InPage;
    await perf.until(() => {
      if (kind === "not sent") return wake.failed().some((row) => (row.textContent ?? "").includes(needle));
      if (kind === "no tray") return !wake.tray().some((row) => (row.textContent ?? "").includes(needle));
      return [...document.querySelectorAll("[data-send-held]")].some((mark) => (mark.closest("[data-mid]")?.textContent ?? "").includes(needle));
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

async function homeCount(world: World, dog: Dog, needle: string): Promise<number> {
  const state = await world.home("GET", "/api/bots?messages=200") as { bots: Array<{ id: string; messages?: Array<{ role: string; text?: string }> }> };
  return (state.bots.find((bot) => bot.id === dog.id)?.messages ?? []).filter((message) => message.role === "user" && message.text?.includes(needle)).length;
}

async function homeAnswer(world: World, dog: Dog, answer: string): Promise<string> {
  const state = await world.home("GET", "/api/bots?messages=200") as { bots: Array<{ id: string; messages?: Array<{ role: string; text?: string }> }> };
  return (state.bots.find((bot) => bot.id === dog.id)?.messages ?? []).find((message) => message.role === "bot" && message.text?.startsWith(answer))?.text ?? "";
}

async function rest(world: World, dog: Dog): Promise<void> {
  await pause(150);
  await settled(world.home, [dog.id], 180_000);
}

async function desk(world: World, run: Run, dog: Dog): Promise<{ page: WakePage; close(): Promise<void> }> {
  const context = await world.browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: run.theme });
  await context.addInitScript(PAGE_PROBE);
  await context.addInitScript(WAKE_PROBE);
  const page = await context.newPage();
  await page.goto(world.edge.url);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
  await open(page, dog);
  await page.waitForTimeout(400);
  return { page, close: () => context.close() };
}

function recorder(world: World, run: Run, name: string) {
  const result: CaseResult = { case: name, run: run.index, theme: run.theme, checks: [], timelines: [], looks: {}, numbers: {} };
  const check = (label: string, ok: boolean, saw?: unknown) => {
    result.checks.push({ name: label, ok, ...(ok || saw === undefined ? {} : { saw }) });
  };
  const seen = (label: string, state: Look) => {
    result.looks[label] = state;
    check(`${label}: no raw error text on screen`, state.raw.length === 0, state.raw);
  };
  const shoot = async (page: WakePage, state: string) => {
    if (run.shots) await page.screenshot({ path: join(run.shots, `${state}-${run.theme}.png`) });
  };
  return { result, check, seen, shoot };
}

async function awakeSend(world: World, page: WakePage, dog: Dog, words: string): Promise<{ timeline: Timeline; answer: string }> {
  const newest = await newestAnswer(page);
  const started = Date.now();
  const reply = firstWords(page, newest);
  const shown = await typeAndSend(page, dog, words);
  const taken = await world.edge.seen("sent", { after: started }, 30_000);
  const first = await reply;
  return {
    answer: first.answer,
    timeline: {
      kind: "awake",
      uiMs: round(shown.shownAt - shown.enterAt),
      acknowledgedMs: round(taken.at - shown.enterAt),
      wakeMs: null,
      firstWakingAnswerMs: null,
      queueWaitMs: 0,
      handedOverAfterReadyMs: null,
      engineMs: round(first.at - taken.at),
      enterToFirstWordsMs: round(first.at - shown.enterAt),
      shownAs: shown.where,
    },
  };
}

async function slowWake(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(world, run, "a. slow wake");
  const dog = world.dogs.wake;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, 30, 10);
    const awakeWords = `Where does the release stand? ${token()}`;
    const awake = await awakeSend(world, page, dog, awakeWords);
    result.timelines.push(awake.timeline);
    await rest(world, dog);
    await page.waitForTimeout(500);
    const wakingAt = Date.now();
    world.edge.sleep();
    world.edge.wakeIn(world.setup.wakeMs);
    await page.waitForTimeout(1_500);
    const asleep = await look(page, awakeWords, awake.answer);
    seen("while waking, before sending", asleep);
    check("the chat from before the home slept is still on screen while it wakes", asleep.bubbles === 1 && asleep.answers === 1, { bubbles: asleep.bubbles, answers: asleep.answers });

    const heldWords = `Run the checks again please ${token()}`;
    const newest = await newestAnswer(page);
    const started = Date.now();
    const shown = await typeAndSend(page, dog, heldWords);
    const held = await world.edge.seen("held", { after: started }, 15_000);
    await page.waitForTimeout(300);
    const waiting = await look(page, heldWords);
    seen("held", waiting);
    check("the held message shows once, as waiting", waiting.tray.length + waiting.bubbles === 1, { tray: waiting.tray, bubbles: waiting.bubbles });
    check("the box is empty again after sending", waiting.composer === "", waiting.composer);
    await shoot(page, "held");
    const reply = firstWords(page, newest);
    const serving = await world.edge.seen("serving", { after: wakingAt }, world.setup.wakeMs + 15_000);
    const delivered = await world.edge.seen("delivered", { id: held.id }, 30_000);
    const first = await reply;
    await rest(world, dog);
    await page.waitForTimeout(700);
    const done = await look(page, heldWords, first.answer);
    seen("delivered", done);
    check("after the wake: one bubble, nothing waiting, one reply", done.bubbles === 1 && done.tray.length === 0 && done.waitingBubbles === 0 && done.answers === 1, { bubbles: done.bubbles, tray: done.tray, waiting: done.waitingBubbles, answers: done.answers });
    check("the home took the message once", await homeCount(world, dog, heldWords) === 1);
    check("the edge delivered it once", world.edge.events.filter((event) => event.kind === "delivered" && event.id === held.id).length === 1);
    const earlier = await look(page, awakeWords, awake.answer);
    check("the earlier exchange is still there once", earlier.bubbles === 1 && earlier.answers === 1, { bubbles: earlier.bubbles, answers: earlier.answers });
    await shoot(page, "delivered");
    const told = world.edge.events.find((event) => event.kind === "told-waking" && event.at >= wakingAt);
    result.timelines.push({
      kind: "held through a wake",
      uiMs: round(shown.shownAt - shown.enterAt),
      acknowledgedMs: round(held.at - shown.enterAt),
      wakeMs: round(serving.at - wakingAt),
      firstWakingAnswerMs: told ? round(told.at - wakingAt) : null,
      queueWaitMs: round(delivered.at - held.at),
      handedOverAfterReadyMs: round(delivered.at - serving.at),
      engineMs: round(first.at - delivered.at),
      enterToFirstWordsMs: round(first.at - shown.enterAt),
      shownAs: shown.where,
    });
  } finally {
    await close();
  }
  return result;
}

async function sendNowAndCancel(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(world, run, "b. Send now and cancel while held");
  const dog = world.dogs.busy;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, 250, 8);
    const jobWords = `Start the long job ${token()}`;
    const job = await awakeSend(world, page, dog, jobWords);
    stream(world, 30, 10);
    world.edge.saveNextAnswers();
    await page.reload();
    await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
    await open(page, dog);
    await page.waitForTimeout(400);
    const wakingAt = Date.now();
    world.edge.sleep();
    world.edge.wakeIn(world.setup.wakeMs + 5_000);
    await page.waitForTimeout(1_500);

    const keptWords = `Also check the release notes ${token()}`;
    let started = Date.now();
    await typeAndSend(page, dog, keptWords);
    const first = await world.edge.seen("held", { after: started }, 15_000);
    await page.waitForTimeout(300);
    const waiting = await look(page, keptWords);
    seen("held while the dog is working", waiting);
    check("the held message is in the waiting list with Send now", waiting.tray.length === 1 && waiting.trayButtons.includes("Send now"), { tray: waiting.tray, buttons: waiting.trayButtons });
    await shoot(page, "held-dog-working");

    check("Send now can be pressed", await press(page, "Send now", '[aria-label="Queued messages"]'));
    const asked = await world.edge.seen("send-now", { id: first.id }, 10_000);
    await page.waitForTimeout(500);
    const answered = await look(page, keptWords);
    seen("Send now answer", answered);
    check("Send now answers in a sentence that says the message is waiting for the home", answered.lines.includes(HELD_UNTIL_UP), answered.lines);
    check("the message is still held after Send now", answered.tray.length === 1 && world.edge.held().includes(first.id), { tray: answered.tray, held: world.edge.held() });
    check("the edge answered Send now with 200", asked.status === 200, asked.status);
    await shoot(page, "send-now-answer");

    const secondWords = `And the pricing line ${token()}`;
    started = Date.now();
    await typeAndSend(page, dog, secondWords);
    const second = await world.edge.seen("held", { after: started }, 15_000);
    await page.waitForTimeout(300);
    const two = await look(page, secondWords);
    seen("two held", two);
    check("the second held message is listed too", two.tray.length === 1 && two.trayButtons.includes("Delete queued message 2 of 2"), { tray: two.tray, buttons: two.trayButtons });
    check("cancel can be pressed", await press(page, "Delete queued message 2 of 2", '[aria-label="Queued messages"]'));
    await world.edge.seen("cancelled", { id: second.id }, 10_000);
    await seenInPage(page, "no tray", secondWords, 10_000);
    await page.waitForTimeout(300);
    const cancelled = await look(page, secondWords);
    seen("cancelled", cancelled);
    check("the cancelled message is gone from the list and the edge", cancelled.tray.length === 0 && cancelled.bubbles === 0 && !world.edge.held().includes(second.id), { tray: cancelled.tray, held: world.edge.held() });
    const kept = await look(page, keptWords);
    check("the other held message is still listed", kept.tray.length === 1, kept.tray);
    await shoot(page, "cancelled");

    const serving = await world.edge.seen("serving", { after: wakingAt }, world.setup.wakeMs + 20_000);
    const delivered = await world.edge.seen("delivered", { id: first.id }, 30_000);
    await rest(world, dog);
    await page.waitForTimeout(900);
    const done = await look(page, keptWords);
    seen("delivered after Send now", done);
    check("after the wake the kept message shows once and nothing is waiting", done.bubbles === 1 && done.tray.length === 0 && done.waitingBubbles === 0, { bubbles: done.bubbles, tray: done.tray });
    check("the home took the kept message once", await homeCount(world, dog, keptWords) === 1);
    check("the home never saw the cancelled message", await homeCount(world, dog, secondWords) === 0);
    const gone = await look(page, secondWords);
    check("the cancelled message did not come back", gone.bubbles === 0 && gone.tray.length === 0, { bubbles: gone.bubbles, tray: gone.tray });
    const before = await look(page, jobWords, job.answer);
    check("the long job and its reply are still there once", before.bubbles === 1 && before.answers === 1, { bubbles: before.bubbles, answers: before.answers });
    result.numbers.queueWaitMs = round(delivered.at - first.at);
    result.numbers.handedOverAfterReadyMs = round(delivered.at - serving.at);
  } finally {
    await close();
  }
  return result;
}

async function dropped(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(world, run, "c. the edge drops a held message");
  const dog = world.dogs.dropped;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, 30, 10);
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
      if (why === "expired") {
        await page.waitForTimeout(500);
        await world.edge.expireHeld();
        world.edge.serve();
      }
      const lost = await world.edge.seen(why, { id: held.id }, 30_000);
      const ready = await world.edge.seen("serving", { after: started }, 30_000);
      const toldAt = await seenInPage(page, "not sent", words, 40_000);
      await page.waitForTimeout(300);
      const state = await look(page, words);
      seen(`Not sent (${why})`, state);
      check(`${why}: the row says Not sent and keeps the words`, state.notSent.length === 1 && state.notSent[0]!.includes(words), state.notSent);
      check(`${why}: nothing is left waiting or shown as sent`, state.tray.length === 0 && state.bubbles === 0, { tray: state.tray, bubbles: state.bubbles });
      check(`${why}: a sentence says why`, state.lines.includes(NOT_SENT_LINE), state.lines);
      check(`${why}: the home has not seen it`, await homeCount(world, dog, words) === 0);
      if (why === "refused") await shoot(page, "not-sent");
      result.numbers[`${why}: Not sent shown after the home was ready, ms`] = round(toldAt - Math.max(lost.at, ready.at));

      const newest = await newestAnswer(page);
      const again = Date.now();
      const reply = firstWords(page, newest);
      check(`${why}: Retry can be pressed`, await press(page, "Retry"));
      const taken = await world.edge.seen("sent", { id: held.id, after: again }, 30_000);
      const first = await reply;
      await rest(world, dog);
      await page.waitForTimeout(700);
      const done = await look(page, words, first.answer);
      seen(`sent again (${why})`, done);
      check(`${why}: sent again it shows once with one reply and no Not sent row`, done.bubbles === 1 && done.answers === 1 && done.notSent.length === 0 && done.tray.length === 0, { bubbles: done.bubbles, answers: done.answers, notSent: done.notSent });
      check(`${why}: the home took it once`, await homeCount(world, dog, words) === 1);
      check(`${why}: the edge no longer calls it dropped`, !world.edge.dropped().some((send) => send.id === held.id), world.edge.dropped());
      result.timelines.push({
        kind: "sent again after Not sent",
        uiMs: null,
        acknowledgedMs: round(taken.at - again),
        wakeMs: null,
        firstWakingAnswerMs: null,
        queueWaitMs: 0,
        handedOverAfterReadyMs: null,
        engineMs: round(first.at - taken.at),
        enterToFirstWordsMs: null,
        shownAs: "bubble",
      });
    }
  } finally {
    await close();
  }
  return result;
}

async function reconnect(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(world, run, "d. the connection is cut mid-reply");
  const dog = world.dogs.reconnect;
  const { page, close } = await desk(world, run, dog);
  try {
    stream(world, 150, 8);
    const words = `Show me the function you changed ${token()}`;
    const sent = await awakeSend(world, page, dog, words);
    stream(world, 30, 10);
    await page.waitForTimeout(1_500);
    const cutAt = Date.now();
    world.edge.dropConnection(world.setup.dropMs);
    await page.waitForTimeout(600);
    const during = `Anything still waiting on me? ${token()}`;
    const shown = await typeAndSend(page, dog, during);
    await seenInPage(page, "waiting bubble", during, 15_000);
    await page.waitForTimeout(200);
    const cut = await look(page, during);
    seen("reconnecting", cut);
    check("a message sent while the connection is down shows once as Not sent yet", cut.bubbles === 1 && cut.waitingBubbles === 1, { bubbles: cut.bubbles, waiting: cut.waitingBubbles });
    const partial = await look(page, words, sent.answer);
    check("the reply that was streaming stays on screen while the connection is down", partial.bubbles === 1 && partial.answers === 1, { bubbles: partial.bubbles, answers: partial.answers });
    await shoot(page, "reconnecting");
    const back = await world.edge.seen("connection-back", { after: cutAt }, world.setup.dropMs + 5_000);
    const taken = await world.edge.seen("sent", { after: back.at }, 40_000);
    const newest = Number(sent.answer.slice(7, -1));
    const second = await firstWords(page, newest);
    await rest(world, dog);
    await page.waitForTimeout(900);
    const whole = await homeAnswer(world, dog, sent.answer);
    const first = await look(page, words, sent.answer);
    seen("after reconnecting", first);
    const tail = await look(page, words, `End of answer ${newest}.`);
    check("the cut reply is whole and shown once", first.bubbles === 1 && first.answers === 1 && tail.answers === 1 && whole.endsWith(`End of answer ${newest}.`), { bubbles: first.bubbles, starts: first.answers, ends: tail.answers });
    const onScreen = await page.evaluate((text: string) => (window as unknown as InPage).__wake.log().includes(text), whole);
    check("the reply on screen is the reply the home has", onScreen && whole.length > 0);
    const late = await look(page, during, second.answer);
    check("the message sent while down shows once with one reply and nothing waiting", late.bubbles === 1 && late.waitingBubbles === 0 && late.answers === 1, { bubbles: late.bubbles, waiting: late.waitingBubbles, answers: late.answers });
    check("the home took each message once", await homeCount(world, dog, words) === 1 && await homeCount(world, dog, during) === 1);
    result.timelines.push(sent.timeline, {
      kind: "held on the device through a dropped connection",
      uiMs: round(shown.shownAt - shown.enterAt),
      acknowledgedMs: round(taken.at - shown.enterAt),
      wakeMs: null,
      firstWakingAnswerMs: null,
      queueWaitMs: round(taken.at - shown.enterAt),
      handedOverAfterReadyMs: round(taken.at - back.at),
      engineMs: round(second.at - taken.at),
      enterToFirstWordsMs: round(second.at - shown.enterAt),
      shownAs: shown.where,
    });
    result.numbers.connectionDownMs = round(back.at - cutAt);
  } finally {
    await close();
  }
  return result;
}

async function typed(page: WakePage, dog: Dog, words: string): Promise<Distribution> {
  await page.click(composerOf(dog));
  await page.evaluate(() => (window as unknown as InPage).__perf.begin());
  await page.keyboard.type(words, { delay: 35 });
  await page.waitForTimeout(300);
  return distribution(await page.evaluate(() => (window as unknown as InPage).__perf.end().keys));
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

async function whileWaking(world: World, run: Run): Promise<CaseResult> {
  const { result, check, seen, shoot } = recorder(world, run, "e. typing, drafts and moving between chats while waking");
  const { drafts, notes } = world.dogs;
  const { page, close } = await desk(world, run, drafts);
  try {
    result.numbers["key to frame while the home is up, ms"] = await typed(page, drafts, SENTENCE);
    await clearBox(page, drafts);
    world.edge.sleep();
    world.edge.wakeIn(world.setup.wakeMs + 14_000);
    await page.waitForTimeout(1_500);
    result.numbers["key to frame while the home wakes, ms"] = await typed(page, drafts, SENTENCE);
    check("every key landed in the box", await boxOf(page, drafts) === SENTENCE, await boxOf(page, drafts));
    await shoot(page, "waking-typing");
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
    result.numbers.statusLinesShownWhileWaking = state.statuses.length + state.lines.length;
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

async function seed(home: ReturnType<typeof fixtureApi>): Promise<Dogs> {
  await home("PATCH", "/api/config", { language: "en", onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });
  const make = async (name: string): Promise<Dog> => {
    const created = await home("POST", "/api/bots", { name }) as { bot: Dog };
    return { id: created.bot.id, name: created.bot.name, threadId: created.bot.threadId };
  };
  const dogs: Dogs = { wake: await make("Marathon"), busy: await make("Builder"), dropped: await make("Courier"), reconnect: await make("Scout"), drafts: await make("Scribe"), notes: await make("Ledger") };
  const asks = ["Where does the release stand?", "Anything still waiting on me?"];
  await Promise.all(Object.values(dogs).map(async (dog: Dog) => {
    for (const ask of asks) {
      await home("POST", `/api/bots/${dog.id}/messages`, { text: ask, threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") });
      await pause(40);
      await settled(home, [dog.id]);
    }
  }));
  return dogs;
}

function spread(values: readonly number[]): string {
  if (values.length === 0) return "none";
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return `${middle} (${sorted[0]} to ${sorted.at(-1)}, ${sorted.length} runs)`;
}

function table(cases: readonly CaseResult[]): string {
  const timelines = cases.flatMap((result) => result.timelines);
  const kinds = [...new Set(timelines.map((timeline) => timeline.kind))];
  const column = (kind: Timeline["kind"], pick: (timeline: Timeline) => number | null) => spread(timelines.filter((timeline) => timeline.kind === kind).flatMap((timeline) => pick(timeline) ?? []));
  const rows: Array<[string, (timeline: Timeline) => number | null]> = [
    ["UI: Enter to own words on screen", (timeline) => timeline.uiMs],
    ["Acknowledged: Enter to accepted by the edge or home", (timeline) => timeline.acknowledgedMs],
    ["Wake: home starting to home ready", (timeline) => timeline.wakeMs],
    ["Queue wait: accepted by the edge or device to accepted by the home", (timeline) => timeline.queueWaitMs],
    ["of which after the home was ready", (timeline) => timeline.handedOverAfterReadyMs],
    ["Engine: accepted by the home to first reply words on screen", (timeline) => timeline.engineMs],
    ["Enter to first reply words", (timeline) => timeline.enterToFirstWordsMs],
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
  writeFileSync(repliesFile, JSON.stringify(Array.from({ length: 400 }, (_, index) => `Answer ${index + 1}. ${PROSE} End of answer ${index + 1}.`)));
  const fixture = await launchVerificationServer({
    ...process.env,
    LATERDOG_TEST_STATIC_DIR: staticDir,
    FAKE_CLAUDE_REPLIES_FILE: repliesFile,
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-index"),
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_STREAM_FILE: streamFile,
  });
  const edge = await startFixtureEdge({ home: fixture.info.url });
  const { chromium } = createRequire(join(setup.playwright, "package.json"))("playwright-core") as { chromium: { launch(options: unknown): Promise<Browser> } };
  const browser = await chromium.launch({ executablePath: setup.browser, args: ["--no-sandbox"] });
  try {
    const home = fixtureApi(fixture.info.url);
    const world: World = { setup, edge, home, browser, dogs: await seed(home), streamFile };
    if (setup.shots) mkdirSync(setup.shots, { recursive: true });
    const only = process.argv.includes("--only") ? option("only").split(",") : null;
    const scenarios = [slowWake, sendNowAndCancel, dropped, reconnect, whileWaking].filter((_, index) => !only || only.includes("abcde"[index]!));
    const cases: CaseResult[] = [];
    for (let index = 0; index < setup.runs; index += 1) {
      const run: Run = { index: index + 1, theme: index === 1 ? "dark" : "light", shots: index < 2 ? setup.shots : null };
      for (const scenario of scenarios) {
        const started = Date.now();
        try {
          cases.push(await scenario(world, run));
        } catch (error) {
          cases.push({ case: scenario.name, run: run.index, theme: run.theme, checks: [{ name: "the case ran to the end", ok: false, saw: error instanceof Error ? error.message : String(error) }], timelines: [], looks: {}, numbers: {} });
        }
        edge.serve();
        await pause(300);
        await settled(home, Object.values(world.dogs).map((dog: Dog) => dog.id), 180_000).catch(() => undefined);
        process.stderr.write(`run ${run.index} ${scenario.name}: ${cases.at(-1)!.checks.filter((check) => !check.ok).length} failed, ${Math.round((Date.now() - started) / 1000)} s\n`);
      }
    }
    const failed = cases.flatMap((result) => result.checks.filter((check) => !check.ok).map((check) => ({ case: result.case, run: result.run, ...check })));
    const result = {
      label: setup.label,
      at: new Date().toISOString(),
      setup: { ...setup, renderer: "production build served by the fixture home through the fixture edge", platform: `${process.platform} ${process.arch}`, injected: { wakeMs: setup.wakeMs, connectionDownMs: setup.dropMs, replyStream: "10 characters every 30 ms" } },
      passed: cases.reduce((sum, each) => sum + each.checks.filter((check) => check.ok).length, 0),
      failed,
      table: table(cases),
      cases,
    };
    mkdirSync(dirname(setup.out), { recursive: true });
    writeFileSync(setup.out, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${result.table}\n\n${result.passed} checks passed, ${failed.length} failed\n${JSON.stringify(failed, null, 2)}\n`);
  } finally {
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
