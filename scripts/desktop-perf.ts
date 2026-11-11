import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, type VerificationServer } from "./control-laterdog.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

const WELCOME_VERSION = 2;
const WINDOW_ROWS = 120;
const VIEWPORT = { width: 1440, height: 900 };
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  out: string;
  playwright: string;
  browser: string;
  label: string;
  longTurns: number;
  otherDogs: number;
  otherTurns: number;
  coldRuns: number;
  switches: number;
}

interface Dog {
  id: string;
  name: string;
  threadId: string;
}

interface Distribution {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

interface MainThread {
  scriptMs: number;
  layoutMs: number;
  styleMs: number;
  taskMs: number;
  layouts: number;
  styleRecalcs: number;
}

interface Memory {
  serverTreeRssMb: number;
  browserTreeRssMb: number;
}

interface Activity {
  mainThread?: MainThread;
  ms: number;
  commits: number;
  rendered: number;
  longTasks: number;
  longTaskMs: number;
  frames: number;
  slowFrames: number;
  worstFrameMs: number;
}

function option(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? fallback : process.argv[index + 1];
  if (value === undefined) throw new Error(`desktop-perf needs --${name}`);
  return value;
}

function options(): Options {
  return {
    out: resolve(option("out", ".laterdog-scratch/desktop-perf/result.json")),
    playwright: resolve(option("playwright", process.env.PLAYWRIGHT_HOME)),
    browser: option("browser", process.env.PERF_BROWSER ?? "/usr/bin/chromium"),
    label: option("label", "run"),
    longTurns: Number(option("long-turns", "120")),
    otherDogs: Number(option("other-dogs", "5")),
    otherTurns: Number(option("other-turns", "6")),
    coldRuns: Number(option("cold-runs", "5")),
    switches: Number(option("switches", "8")),
  };
}

function distribution(values: readonly number[]): Distribution {
  const sorted = [...values].sort((left, right) => left - right);
  const at = (share: number) => sorted.length === 0 ? 0 : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]! * 10) / 10;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}

function replies(): string[] {
  const table = ["| Step | Result | Time |", "|---|---|---|", "| Install | passed | 41 s |", "| Typecheck | passed | 18 s |", "| Tests | 1,884 passed | 3 min 12 s |", "| Export | one bundle, 5.9 MB | 58 s |"].join("\n");
  const code = ["```ts", "export function carryOn(waiting: readonly string[], after: string | undefined): readonly string[] {", "  if (after === undefined) return waiting;", "  const start = waiting.findIndex((path) => path > after);", "  return start <= 0 ? waiting : [...waiting.slice(start), ...waiting.slice(0, start)];", "}", "```"].join("\n");
  const prose = "The release checklist is done apart from the two items that need you. The signed build finished and passed its smoke tests on both window sizes, the update guide names the new group and the rollback target, and the pull request is merged. Nothing else changed in this pass, so the next step is yours.";
  const list = ["Here is where things stand:", "", "- **Build:** finished and signed, with the long dog names fitting their rows.", "- **Docs:** the update guide is merged and names the rollback target.", "- **Waiting on you:** approve the screenshots and confirm the pricing line before Friday.", "", "`pnpm verify` passed in 4 min 12 s."].join("\n");
  const shapes = [prose, list, `${prose}\n\n${code}`, `Results from this run:\n\n${table}\n\n${prose}`, "Done. Nothing else needed.", `${list}\n\n${code}\n\n${table}`];
  return Array.from({ length: 1200 }, (_, index) => `Answer ${index + 1}. ${shapes[index % shapes.length]}`);
}

async function settled(api: ReturnType<typeof fixtureApi>, botIds: readonly string[], timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await api("GET", "/api/bots") as { bots: Array<{ id: string; busy?: boolean; activity?: string }> };
    const working = state.bots.filter((bot) => botIds.includes(bot.id) && (bot.busy || bot.activity === "working"));
    if (working.length === 0) return;
    if (Date.now() > deadline) throw new Error(`dogs still working after ${timeoutMs} ms: ${working.map((bot) => bot.id).join(", ")}`);
    await new Promise((done) => setTimeout(done, 60));
  }
}

async function exchange(api: ReturnType<typeof fixtureApi>, dog: Dog, text: string): Promise<void> {
  await api("POST", `/api/bots/${dog.id}/messages`, { text, threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") });
  await new Promise((done) => setTimeout(done, 40));
  await settled(api, [dog.id]);
}

async function seed(api: ReturnType<typeof fixtureApi>, setup: Options): Promise<{ long: Dog; others: Dog[] }> {
  await api("PATCH", "/api/config", { language: "en", onboarding: { completedAt: new Date().toISOString(), version: WELCOME_VERSION } });
  const make = async (name: string): Promise<Dog> => {
    const created = await api("POST", "/api/bots", { name }) as { bot: Dog };
    return { id: created.bot.id, name: created.bot.name, threadId: created.bot.threadId };
  };
  const long = await make("Marathon");
  const others: Dog[] = [];
  for (let index = 0; index < setup.otherDogs; index += 1) others.push(await make(`Helper ${index + 1}`));
  const asks = ["Where does the release stand?", "Run the checks again and show me the table.", "Show me the function you changed.", "Anything still waiting on me?"];
  const fill = async (dog: Dog, turns: number) => {
    for (let turn = 0; turn < turns; turn += 1) await exchange(api, dog, `${asks[turn % asks.length]} (${dog.name}, ${turn + 1})`);
  };
  await Promise.all([fill(long, setup.longTurns), ...others.map((dog) => fill(dog, setup.otherTurns))]);
  return { long, others };
}

const PAGE_PROBE = `(() => {
  const perf = { commits: 0, rendered: 0, counting: false, longTasks: [], frames: [], composerAt: null, keys: [], names: new Map(), watchingStore: false, store: null, storeChanges: [], startedAt: 0 };
  window.__perf = perf;
  const component = (tag) => tag === 0 || tag === 1 || tag === 11 || tag === 14 || tag === 15;
  const visit = (next, previous) => {
    if (component(next.tag) && (next.flags & 1) === 1) {
      perf.rendered += 1;
      const type = next.type && (next.type.type || next.type.render || next.type);
      const name = (next.type && next.type.displayName) || (type && (type.displayName || type.name)) || "(unnamed)";
      perf.names.set(name, (perf.names.get(name) || 0) + 1);
    }
    if (previous && next.child === previous.child) return;
    for (let child = next.child; child; child = child.sibling) visit(child, child.alternate);
  };
  const storeOf = (fiber, depth) => {
    for (let at = fiber; at; at = at.sibling) {
      for (let hook = component(at.tag) ? at.memoizedState : null; hook; hook = hook.next) {
        const held = hook.memoizedState;
        if (held && typeof held === "object" && Array.isArray(held.bots) && Array.isArray(held.groups) && "selectedId" in held) return held;
      }
      const below = depth > 0 && at.child ? storeOf(at.child, depth - 1) : null;
      if (below) return below;
    }
    return null;
  };
  const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((name) => !Object.is(before[name], after[name]));
  const noteStore = (root) => {
    const store = storeOf(root.current, 12);
    const last = perf.store;
    if (!store || store === last) return;
    perf.store = store;
    if (!last) return;
    const fields = changedFields(last, store);
    const dogFields = {};
    let dogs = 0;
    if (last.bots !== store.bots) {
      const before = new Map(last.bots.map((bot) => [bot.id, bot]));
      for (const bot of store.bots) {
        const was = before.get(bot.id);
        if (was === bot) continue;
        dogs += 1;
        for (const name of was ? changedFields(was, bot) : ["(new dog)"]) dogFields[name] = (dogFields[name] || 0) + 1;
        if (was && changedFields(was, bot).length === 0) dogFields["(same fields, new object)"] = (dogFields["(same fields, new object)"] || 0) + 1;
      }
    }
    perf.storeChanges.push({ atMs: Math.round(performance.now() - perf.startedAt), fields, dogs, dogFields });
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot(_id, root) { perf.commits += 1; if (perf.watchingStore) noteStore(root); if (perf.counting) visit(root.current, root.current.alternate); },
    onPostCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    checkDCE() {},
  };
  new PerformanceObserver((list) => { for (const entry of list.getEntries()) perf.longTasks.push(entry.duration); }).observe({ type: "longtask", buffered: true });
  let last = null;
  const frame = (at) => { if (last !== null) perf.frames.push(at - last); last = at; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  const seen = new MutationObserver(() => {
    if (perf.composerAt === null && document.querySelector('textarea[aria-label^="Message "]')) { perf.composerAt = performance.now(); seen.disconnect(); }
  });
  document.addEventListener("DOMContentLoaded", () => seen.observe(document.documentElement, { childList: true, subtree: true }));
  addEventListener("keydown", (event) => {
    const pressed = event.timeStamp;
    requestAnimationFrame(() => requestAnimationFrame((shown) => perf.keys.push(shown - pressed)));
  }, true);
  perf.begin = () => { perf.names.clear(); perf.commits = 0; perf.rendered = 0; perf.longTasks.length = 0; perf.frames.length = 0; perf.keys.length = 0; perf.startedAt = performance.now(); };
  perf.end = () => ({
    ms: performance.now() - perf.startedAt,
    commits: perf.commits,
    rendered: perf.rendered,
    longTasks: perf.longTasks.length,
    longTaskMs: perf.longTasks.reduce((sum, value) => sum + value, 0),
    frames: perf.frames.length,
    slowFrames: perf.frames.filter((gap) => gap > 25).length,
    worstFrameMs: perf.frames.reduce((worst, gap) => Math.max(worst, gap), 0),
    keys: [...perf.keys],
    top: [...perf.names.entries()].sort((left, right) => right[1] - left[1]).slice(0, 120).map(([name, count]) => name + " " + count),
  });
  perf.until = (test, timeoutMs) => new Promise((done, fail) => {
    const deadline = performance.now() + timeoutMs;
    const look = () => { if (test()) done(performance.now()); else if (performance.now() > deadline) fail(new Error("timed out waiting in the page")); else requestAnimationFrame(look); };
    look();
  });
  perf.shown = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  perf.holdFill = () => {
    perf.holding = true;
    const press = () => { if (!perf.holding) return; window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" })); requestAnimationFrame(press); };
    press();
  };
  perf.releaseFill = () => { perf.holding = false; };
})();`;

type PagePerf = {
  until(test: () => boolean, timeoutMs: number): Promise<number>;
  shown(): Promise<void>;
  holdFill(): void;
  releaseFill(): void;
};

type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T>(run: string | ((argument: never) => T | Promise<T>), argument?: unknown): Promise<T>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(selector: string): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  keyboard: { type(text: string, options?: { delay?: number }): Promise<void>; press(key: string): Promise<void> };
  mouse: { move(x: number, y: number): Promise<void>; wheel(x: number, y: number): Promise<void> };
  context(): { newCDPSession(page: Page): Promise<{ send(method: string, params?: unknown): Promise<{ metrics?: Array<{ name: string; value: number }> }> }> };
  close(): Promise<void>;
};

const composerOf = (dog: Dog) => `textarea[aria-label=${JSON.stringify(`Message ${dog.name}`)}]`;
const rowOf = (dog: Dog) => `[data-sidebar-bot-row=${JSON.stringify(dog.id)}]`;

async function open(page: Page, dog: Dog): Promise<number> {
  return page.evaluate(async ({ row, composer, name }: { row: string; composer: string; name: string }) => {
    const perf = (window as unknown as { __perf: { until(test: () => boolean, timeoutMs: number): Promise<number>; shown(): Promise<void> } }).__perf;
    const started = performance.now();
    (document.querySelector(row) as HTMLElement).click();
    await perf.until(() => Boolean(document.querySelector(composer)) && Boolean(document.querySelector(`[role="log"][aria-label*=${JSON.stringify(name)}] [data-mid]`)), 30_000);
    await perf.shown();
    return performance.now() - started;
  }, { row: rowOf(dog), composer: composerOf(dog), name: dog.name });
}

interface Opening {
  shownMs: number;
  rowsAtFirstSight: number;
  filledMs: number | null;
  rows: number;
  pixelsFromBottom: number;
}

async function openFilling(page: Page, dog: Dog, hold = false): Promise<Opening> {
  return page.evaluate(async ({ row, composer, name, hold, full }: { row: string; composer: string; name: string; hold: boolean; full: number }) => {
    const perf = (window as unknown as { __perf: PagePerf }).__perf;
    const rows = () => document.querySelectorAll(`[role="log"][aria-label*=${JSON.stringify(name)}] [data-mid]`).length;
    if (hold) perf.holdFill();
    const started = performance.now();
    (document.querySelector(row) as HTMLElement).click();
    const shown = await perf.until(() => Boolean(document.querySelector(composer)) && rows() > 0, 30_000);
    const rowsAtFirstSight = rows();
    const filled = hold ? null : await perf.until(() => rows() >= full, 20_000).catch(() => null);
    await perf.shown();
    const scroller = document.querySelector('[role="log"]')!.parentElement!;
    return {
      shownMs: Math.round(shown - started),
      rowsAtFirstSight,
      filledMs: filled === null ? null : Math.round(filled - started),
      rows: rows(),
      pixelsFromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
    };
  }, { row: rowOf(dog), composer: composerOf(dog), name: dog.name, hold, full: WINDOW_ROWS });
}

interface FixtureFiles {
  stream: string;
  replyIndex: string;
}

const scriptedReplies = replies();
const longestReply = scriptedReplies.reduce((longest, text) => Math.max(longest, text.length), 0);

async function fillUnderStream(page: Page, api: ReturnType<typeof fixtureApi>, dogs: { long: Dog; others: Dog[] }, files: FixtureFiles) {
  const working = async () => {
    const state = await api("GET", "/api/bots") as { bots: Array<{ id: string; busy?: boolean; activity?: string }> };
    return state.bots.some((bot) => bot.id === dogs.long.id && Boolean(bot.busy || bot.activity === "working"));
  };
  const startLongReply = async () => {
    await open(page, dogs.others[0]!);
    const next = Number(readFileSync(files.replyIndex, "utf8")) || 0;
    writeFileSync(files.replyIndex, String(scriptedReplies.findIndex((text, index) => index >= next && text.length > longestReply * 0.9)));
    writeFileSync(files.stream, JSON.stringify({ everyMs: 30, chars: 3 }));
    await api("POST", `/api/bots/${dogs.long.id}/messages`, { text: "Give me the whole picture again.", threadId: dogs.long.threadId, sendId: randomUUID().replaceAll("-", "") });
    await page.waitForTimeout(1_600);
  };

  await startLongReply();
  const following = await openFilling(page, dogs.long);
  const followingStillStreaming = await working();
  await settled(api, [dogs.long.id]);

  await startLongReply();
  const held = await openFilling(page, dogs.long, true);
  await page.mouse.move(820, 420);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(400);
  const reader = await page.evaluate(async ({ name, full }: { name: string; full: number }) => {
    const perf = (window as unknown as { __perf: PagePerf }).__perf;
    const log = document.querySelector(`[role="log"][aria-label*=${JSON.stringify(name)}]`)!;
    const scroller = log.parentElement!;
    const rows = () => log.querySelectorAll("[data-mid]").length;
    const top = scroller.getBoundingClientRect().top;
    const row = [...log.querySelectorAll("[data-mid]")].find((candidate) => candidate.getBoundingClientRect().top >= top)!;
    const before = row.getBoundingClientRect().top;
    const rowsWhenReleased = rows();
    const heightWhenReleased = scroller.scrollHeight;
    let moved = 0;
    const watch = () => { moved = Math.max(moved, Math.abs(row.getBoundingClientRect().top - before)); };
    perf.releaseFill();
    const released = performance.now();
    const filled = await perf.until(() => { watch(); return rows() >= full; }, 20_000).catch(() => null);
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise((done) => requestAnimationFrame(done));
      watch();
    }
    return {
      rowsWhenReleased,
      rows: rows(),
      filledMsAfterRelease: filled === null ? null : Math.round(filled - released),
      readerRowMovedPx: Math.round(moved * 10) / 10,
      readerRowEndedPx: Math.round((row.getBoundingClientRect().top - before) * 10) / 10,
      transcriptGrewPx: Math.round(scroller.scrollHeight - heightWhenReleased),
    };
  }, { name: dogs.long.name, full: WINDOW_ROWS });
  const readerStillStreaming = await working();
  await settled(api, [dogs.long.id]);
  rmSync(files.stream, { force: true });
  return {
    following: { ...following, replyStillStreaming: followingStillStreaming },
    scrolledUp: { rowsAtFirstSight: held.rowsAtFirstSight, ...reader, replyStillStreaming: readerStillStreaming },
  };
}

async function fillsWhileIdle(page: Page, dogs: { long: Dog; others: Dog[] }, rounds: number) {
  const filled: number[] = [];
  const firstRows = new Set<number>();
  let unfilled = 0;
  let pixelsFromBottom = 0;
  for (let round = 0; round < rounds; round += 1) {
    await open(page, dogs.others[0]!);
    const opening = await openFilling(page, dogs.long);
    firstRows.add(opening.rowsAtFirstSight);
    if (opening.filledMs === null) unfilled += 1;
    else filled.push(opening.filledMs);
    pixelsFromBottom = Math.max(pixelsFromBottom, opening.pixelsFromBottom);
  }
  return { filledMs: distribution(filled), unfilled, rowsAtFirstSight: [...firstRows].sort((left, right) => left - right), worstPixelsFromBottom: pixelsFromBottom };
}

type Cdp = Awaited<ReturnType<ReturnType<Page["context"]>["newCDPSession"]>>;

async function mainThread(cdp: Cdp): Promise<MainThread> {
  const { metrics = [] } = await cdp.send("Performance.getMetrics");
  const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  const ms = (name: string) => value(name) * 1000;
  return { scriptMs: ms("ScriptDuration"), layoutMs: ms("LayoutDuration"), styleMs: ms("RecalcStyleDuration"), taskMs: ms("TaskDuration"), layouts: value("LayoutCount"), styleRecalcs: value("RecalcStyleCount") };
}

function spent(before: MainThread, after: MainThread): MainThread {
  const round = (value: number) => Math.round(value);
  return {
    scriptMs: round(after.scriptMs - before.scriptMs),
    layoutMs: round(after.layoutMs - before.layoutMs),
    styleMs: round(after.styleMs - before.styleMs),
    taskMs: round(after.taskMs - before.taskMs),
    layouts: after.layouts - before.layouts,
    styleRecalcs: after.styleRecalcs - before.styleRecalcs,
  };
}

async function measured<T>(page: Page, cdp: Cdp, counting: boolean, work: () => Promise<T>): Promise<Activity & { keys: number[]; top: string[]; value: T }> {
  const before = await mainThread(cdp);
  await page.evaluate((on: boolean) => {
    const perf = (window as unknown as { __perf: { counting: boolean; begin(): void } }).__perf;
    perf.counting = on;
    perf.begin();
  }, counting);
  const value = await work();
  const result = await page.evaluate(() => (window as unknown as { __perf: { end(): Activity & { keys: number[]; top: string[] } } }).__perf.end());
  return { ...result, mainThread: spent(before, await mainThread(cdp)), value };
}

function treeRss(rootPid: number): number {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], { encoding: "utf8" }).trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map<number, number[]>();
  const rss = new Map<number, number>();
  for (const [pid, parent, size] of rows) {
    rss.set(pid!, size!);
    children.set(parent!, [...(children.get(parent!) ?? []), pid!]);
  }
  let total = 0;
  const walk = (pid: number) => { total += rss.get(pid) ?? 0; for (const child of children.get(pid) ?? []) walk(child); };
  walk(rootPid);
  return Math.round(total / 1024);
}

function memory(serverPid: number): Memory {
  const serverTreeRssMb = treeRss(serverPid);
  return { serverTreeRssMb, browserTreeRssMb: treeRss(process.pid) - serverTreeRssMb - Math.round(process.memoryUsage().rss / 1024 / 1024) };
}

async function heap(page: Page): Promise<{ heapMb: number; nodes: number }> {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  await session.send("HeapProfiler.collectGarbage");
  const { metrics = [] } = await session.send("Performance.getMetrics");
  const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { heapMb: Math.round(value("JSHeapUsedSize") / 1024 / 1024 * 10) / 10, nodes: value("Nodes") };
}

function rendererMemoryMb(rootPid: number): number {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss=,args="], { encoding: "utf8" }).trim().split("\n").map((line) => {
    const [pid, parent, rss, ...command] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), rss: Number(rss), command: command.join(" ") };
  });
  const inTree = new Set<number>([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) if (inTree.has(row.parent) && !inTree.has(row.pid)) { inTree.add(row.pid); grew = true; }
  }
  const anonymous = (pid: number, fallbackKb: number) => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const field = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0);
      return field("RssAnon") + field("VmSwap");
    } catch {
      return fallbackKb;
    }
  };
  const renderers = rows.filter((row) => inTree.has(row.pid) && row.command.includes("--type=renderer")).map((row) => anonymous(row.pid, row.rss));
  return Math.round(Math.max(0, ...renderers) / 1024);
}

interface SoakSample {
  cycle: number;
  heapMb: number;
  rendererMb: number;
  counters: Record<string, number>;
}

const SOAK_COUNTERS = ["Nodes", "JSEventListeners", "Documents", "Frames", "LayoutObjects", "Resources", "ArrayBufferContents", "DetachedScriptStates", "UACSSResources", "V8PerContextDatas", "ContextLifecycleStateObservers"];

function growthPerCycle(samples: readonly SoakSample[], read: (sample: SoakSample) => number): number {
  const tail = samples.slice(Math.floor(samples.length / 2));
  if (tail.length < 2) return 0;
  const meanCycle = tail.reduce((sum, sample) => sum + sample.cycle, 0) / tail.length;
  const meanValue = tail.reduce((sum, sample) => sum + read(sample), 0) / tail.length;
  const spread = tail.reduce((sum, sample) => sum + (sample.cycle - meanCycle) ** 2, 0);
  const slope = tail.reduce((sum, sample) => sum + (sample.cycle - meanCycle) * (read(sample) - meanValue), 0) / spread;
  return Math.round(slope * 1000) / 1000;
}

async function soak(browser: { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }> }, pageUrl: string, api: ReturnType<typeof fixtureApi>, dogs: { long: Dog; others: Dog[] }, streamFile: string, cycles: number, every: number) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  await page.goto(pageUrl);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 120_000 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const sample = async (cycle: number): Promise<SoakSample> => {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(250);
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics = [] } = await cdp.send("Performance.getMetrics");
    const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
    const timeline = await page.evaluate(() => ({ PerformanceMeasures: performance.getEntriesByType("measure").length, PerformanceMarks: performance.getEntriesByType("mark").length }));
    return {
      cycle,
      heapMb: Math.round(value("JSHeapUsedSize") / 1024 / 1024 * 10) / 10,
      rendererMb: rendererMemoryMb(process.pid),
      counters: { ...Object.fromEntries(SOAK_COUNTERS.map((name) => [name, value(name)])), ...timeline },
    };
  };
  const short = dogs.others[0]!;
  const send = (dog: Dog, text: string) => api("POST", `/api/bots/${dog.id}/messages`, { text, threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") });
  writeFileSync(streamFile, JSON.stringify({ everyMs: 20, chars: 24 }));
  await open(page, dogs.long);
  await open(page, short);
  await page.waitForTimeout(2_000);
  const samples = [await sample(0)];
  const started = Date.now();
  for (let cycle = 1; cycle <= cycles; cycle += 1) {
    await open(page, dogs.long);
    await Promise.all([send(dogs.long, `Soak pass ${cycle}: show me the table and the function again.`), ...dogs.others.slice(0, 4).map((dog) => send(dog, `Soak pass ${cycle}: where does it stand?`))]);
    await new Promise((done) => setTimeout(done, 150));
    await open(page, short);
    await open(page, dogs.long);
    await settled(api, [dogs.long.id, ...dogs.others.map((dog) => dog.id)]);
    await open(page, short);
    if (cycle % every === 0 || cycle === cycles) {
      const taken = await sample(cycle);
      samples.push(taken);
      process.stderr.write(`soak ${cycle}/${cycles}: heap ${taken.heapMb} MB, renderer ${taken.rendererMb} MB, nodes ${taken.counters.Nodes}, listeners ${taken.counters.JSEventListeners}\n`);
    }
  }
  rmSync(streamFile, { force: true });
  await context.close();
  return {
    cycles,
    seconds: Math.round((Date.now() - started) / 1000),
    eachCycle: "open the long chat, one streamed reply there and four other dogs take a turn, switch to a short chat and back twice",
    first: samples[0],
    last: samples.at(-1),
    growthPerCycle: {
      heapMb: growthPerCycle(samples, (taken) => taken.heapMb),
      rendererMb: growthPerCycle(samples, (taken) => taken.rendererMb),
      ...Object.fromEntries(Object.keys(samples[0]!.counters).map((name) => [name, growthPerCycle(samples, (taken) => taken.counters[name] ?? 0)])),
    },
    samples,
  };
}

async function hotReloadStorm(browser: { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }> }, hot: { url: string; lines: string[] }, saved: readonly string[], watchSeconds: number) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  await page.goto(hot.url);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 120_000 });
  await page.waitForTimeout(3_000);
  const results = [];
  for (const file of saved) {
    const path = join(ROOT, file);
    const before = hot.lines.length;
    await page.evaluate(() => { (window as unknown as { __perf: { begin(): void } }).__perf.begin(); (window as unknown as { __loads: number }).__loads = ((window as unknown as { __loads?: number }).__loads ?? 0); });
    const marker = await page.evaluate(() => { const token = String(Math.random()); (window as unknown as { __alive: string }).__alive = token; return token; });
    writeFileSync(path, readFileSync(path, "utf8"));
    await page.waitForTimeout(watchSeconds * 1000);
    const said = hot.lines.slice(before);
    const reloaded = await page.evaluate((token: string) => (window as unknown as { __alive?: string }).__alive !== token, marker).catch(() => true);
    const commits = reloaded ? null : await page.evaluate(() => (window as unknown as { __perf: { end(): Activity } }).__perf.end().commits);
    results.push({
      saved: file,
      watchedSeconds: watchSeconds,
      updates: said.filter((line) => line.includes("hmr update")).length,
      invalidations: said.filter((line) => line.includes("hmr invalidate")).length,
      pageReloads: said.filter((line) => line.includes("page reload")).length,
      windowReloaded: reloaded,
      reactCommits: commits,
      lastLines: said.slice(-3).map((line) => line.slice(0, 160)),
    });
    if (reloaded) await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 120_000 });
    await page.waitForTimeout(1_500);
  }
  await context.close();
  return results;
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => done(port));
    });
  });
}

async function devServer(apiUrl: string, scratch: string): Promise<{ url: string; child: ChildProcess; lines: string[] }> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, LATERDOG_DEV_API_URL: apiUrl, LATERDOG_HOME: join(scratch, "dev-home"), LATERDOG_UI_PORT: String(port), LATERDOG_VARIANT: "dev", FORCE_COLOR: "0", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines: string[] = [];
  let partial = "";
  child.stdout!.setEncoding("utf8");
  child.stdout!.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop() ?? "";
    lines.push(...parts);
  });
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the dev server stopped with code ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return { url, child, lines };
    } catch {
      if (Date.now() > deadline) throw new Error("the dev server did not answer within 60 s");
    }
    await new Promise((done) => setTimeout(done, 200));
  }
}

async function pass(browser: { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }> }, fixture: VerificationServer, api: ReturnType<typeof fixtureApi>, dogs: { long: Dog; others: Dog[] }, setup: Options, files: FixtureFiles, counting: boolean) {
  const streamFile = files.stream;
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  await page.goto(fixture.info.url);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
  await page.waitForTimeout(1_000);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  if (process.argv.includes("--css")) await (page as unknown as { addStyleTag(options: { content: string }): Promise<unknown> }).addStyleTag({ content: option("css") });
  const named = process.argv.includes("--names");
  const trim = ({ keys: _keys, value: _value, top, ...rest }: Activity & { keys: number[]; top: string[]; value: unknown }) => (named && counting ? { ...rest, top } : rest);
  const idle = await heap(page);
  const rendererIdleMb = rendererMemoryMb(process.pid);
  const rendererSeenMb = [rendererIdleMb];
  const sampleRenderer = () => { rendererSeenMb.push(rendererMemoryMb(process.pid)); };
  const idling = await measured(page, cdp, false, async () => {
    await page.waitForTimeout(3_000);
  });
  const blinkSeenMs = await page.evaluate(async () => {
    const started = performance.now();
    while (performance.now() - started < 7_000) {
      if (document.getAnimations().some((animation) => ((animation.effect as KeyframeEffect | null)?.target as Element | null)?.classList.contains("ld-dog-blink"))) return Math.round(performance.now() - started);
      await new Promise((done) => setTimeout(done, 40));
    }
    return null;
  });
  const animations = await page.evaluate(() => {
    const running = document.getAnimations().filter((animation) => animation.playState === "running");
    const names = new Map<string, number>();
    for (const animation of running) {
      const name = (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? "script";
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    return { running: running.length, byName: [...names.entries()].sort((left, right) => right[1] - left[1]).slice(0, 12).map(([name, count]) => `${name} ${count}`) };
  });
  const memoryIdle = memory(fixture.info.pid);
  const memoryPeak = { ...memoryIdle };
  const sampling = setInterval(() => {
    const now = memory(fixture.info.pid);
    memoryPeak.serverTreeRssMb = Math.max(memoryPeak.serverTreeRssMb, now.serverTreeRssMb);
    memoryPeak.browserTreeRssMb = Math.max(memoryPeak.browserTreeRssMb, now.browserTreeRssMb);
  }, 1_000);
  const short = dogs.others[0]!;
  await open(page, dogs.long);
  await page.waitForTimeout(1_500);
  const longChatOpened = await page.evaluate(() => {
    const scroller = document.querySelector('[role="log"]')!.parentElement!;
    return { rows: document.querySelectorAll('[role="log"] [data-mid]').length, pixelsFromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight) };
  });
  const shots = process.argv.includes("--shots") ? resolve(option("shots")) : null;
  if (shots && !counting) {
    mkdirSync(shots, { recursive: true });
    const shoot = (name: string) => (page as unknown as { screenshot(options: { path: string }): Promise<unknown> }).screenshot({ path: join(shots, `${setup.label}-${name}.png`) });
    await shoot("long-chat");
    await page.mouse.move(160, 400);
    await page.mouse.wheel(0, 1_400);
    await page.waitForTimeout(400);
    await shoot("sidebar-scrolled");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(200);
    await shoot("sidebar-focus");
    await page.mouse.move(160, 300);
    await page.waitForTimeout(200);
    await shoot("sidebar-hover");
    await page.mouse.wheel(0, -4_000);
    await page.waitForTimeout(300);
    await page.mouse.move(820, 420);
  }
  await open(page, short);

  const toLong: number[] = [];
  const toShort: number[] = [];
  const switching = await measured(page, cdp, counting, async () => {
    for (let round = 0; round < setup.switches; round += 1) {
      toLong.push(await open(page, dogs.long));
      toShort.push(await open(page, short));
    }
  });
  sampleRenderer();

  await open(page, dogs.long);
  await page.click(composerOf(dogs.long));
  const typing = await measured(page, cdp, counting, async () => {
    await page.keyboard.type("Can you also check whether the release notes mention the bigger chat text and the new usage sheet, and fix them if not?", { delay: 35 });
    await page.waitForTimeout(300);
  });
  sampleRenderer();
  for (let index = 0; index < 130; index += 1) await page.keyboard.press("Backspace");

  await page.mouse.move(820, 420);
  const scrolling = await measured(page, cdp, counting, async () => {
    for (let step = 0; step < 90; step += 1) {
      await page.mouse.wheel(0, step < 60 ? -700 : 900);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
  });

  sampleRenderer();
  writeFileSync(streamFile, JSON.stringify({ everyMs: 30, chars: 10 }));
  await open(page, dogs.long);
  await page.click(composerOf(dogs.long));
  const token = `streamed-${randomUUID().slice(0, 8)}`;
  await page.keyboard.type(`One more pass please ${token}`, { delay: 5 });
  const streaming = await measured(page, cdp, counting, async () => {
    const marks = page.evaluate(async (needle: string) => {
      const perf = (window as unknown as { __perf: { until(test: () => boolean, timeoutMs: number): Promise<number> } }).__perf;
      const log = () => document.querySelector('[role="log"]');
      const before = new Set([...document.querySelectorAll('[role="log"] [data-mid]')].map((node) => node.getAttribute("data-mid")));
      const pressed = await new Promise<number>((done) => addEventListener("keydown", (event) => { if (event.key === "Enter") done(event.timeStamp); }, { capture: true, once: true }));
      const own = await perf.until(() => Boolean(log()?.textContent?.includes(needle)), 30_000);
      const reply = await perf.until(() => [...document.querySelectorAll('[role="log"] [data-mid]')].some((node) => !before.has(node.getAttribute("data-mid")) && !node.textContent?.includes(needle) && (node.textContent?.length ?? 0) > 0), 60_000);
      return { ownBubbleMs: own - pressed, firstReplyMs: reply - pressed };
    }, token);
    await page.waitForTimeout(50);
    await page.keyboard.press("Enter");
    const seen = await marks;
    await new Promise((done) => setTimeout(done, 150));
    await settled(api, [dogs.long.id]);
    await page.waitForTimeout(400);
    return seen;
  });
  sampleRenderer();

  const elsewhere = await measured(page, cdp, counting, async () => {
    await Promise.all(dogs.others.slice(0, 4).map((dog) => api("POST", `/api/bots/${dog.id}/messages`, { text: "Run the checks again and show me the table.", threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") })));
    await new Promise((done) => setTimeout(done, 150));
    await settled(api, dogs.others.map((dog) => dog.id));
    await page.waitForTimeout(400);
  });
  rmSync(streamFile, { force: true });
  sampleRenderer();

  const after = await heap(page);
  const fill = counting ? null : { idle: await fillsWhileIdle(page, dogs, setup.switches), whileReplyStreams: await fillUnderStream(page, api, dogs, files) };
  clearInterval(sampling);
  const memoryAfter = memory(fixture.info.pid);
  await context.close();
  return {
    idle: { ...trim(idling), animations, blinkSeenMs },
    longChatOpened,
    ...(fill ? { fill } : {}),
    heapIdleMb: idle.heapMb,
    heapAfterMb: after.heapMb,
    rendererIdleMb,
    rendererPeakMb: Math.max(...rendererSeenMb),
    rssMb: { idle: memoryIdle, peak: memoryPeak, afterRun: memoryAfter },
    domNodesAfter: after.nodes,
    switchToLongMs: distribution(toLong),
    switchToShortMs: distribution(toShort),
    switching: trim(switching),
    typingKeyToFrameMs: distribution(typing.keys),
    typing: trim(typing),
    scrolling: trim(scrolling),
    send: streaming.value,
    streaming: trim(streaming),
    otherDogsWorking: trim(elsewhere),
  };
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}

async function switchProfile(browser: { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }> }, url: string, dogs: { long: Dog; others: Dog[] }, typing = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
  await open(page, dogs.long);
  await open(page, dogs.others[0]!);
  const session = await page.context().newCDPSession(page) as unknown as { send(method: string, params?: unknown): Promise<{ profile?: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] } }> };
  await session.send("Profiler.enable");
  await session.send("Profiler.setSamplingInterval", { interval: 200 });
  if (!typing) await session.send("Profiler.start");
  if (typing) {
    await open(page, dogs.long);
    await page.waitForTimeout(1_500);
    await page.click(composerOf(dogs.long));
    const tracer = session as unknown as { on(event: string, listener: (payload: { value?: Array<{ name: string; ph: string; dur?: number }> }) => void): void; send(method: string, params?: unknown): Promise<unknown> };
    const stages = new Map<string, { ms: number; count: number }>();
    const finished = new Promise<void>((done) => tracer.on("Tracing.tracingComplete", () => done()));
    tracer.on("Tracing.dataCollected", ({ value = [] }) => {
      for (const event of value) {
        if (event.ph !== "X" || !event.dur) continue;
        const stage = stages.get(event.name) ?? { ms: 0, count: 0 };
        stage.ms += event.dur / 1000;
        stage.count += 1;
        stages.set(event.name, stage);
      }
    });
    await tracer.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline"] } });
    await session.send("Profiler.start");
    await page.keyboard.type("Can you also check whether the release notes mention the bigger chat text and the new usage sheet?", { delay: 35 });
    await tracer.send("Tracing.end");
    await finished;
    process.stdout.write(`${JSON.stringify([...stages.entries()].sort((left, right) => right[1].ms - left[1].ms).slice(0, 16).map(([name, stage]) => `${Math.round(stage.ms)} ms x${stage.count}  ${name}`), null, 2)}\n`);
  } else {
    for (let round = 0; round < 6; round += 1) {
      await open(page, dogs.long);
      await open(page, dogs.others[0]!);
    }
  }
  const { profile } = await session.send("Profiler.stop");
  await context.close();
  if (!profile) return [];
  const names = new Map(profile.nodes.map((node) => [node.id, `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url.split("/").at(-1)}:${node.callFrame.lineNumber}`]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, index) => {
    const name = names.get(id) ?? "?";
    self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000);
  });
  return [...self.entries()].sort((left, right) => right[1] - left[1]).slice(0, 40).map(([name, ms]) => `${Math.round(ms)} ms  ${name}`);
}

async function coldLoads(browser: { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }> }, url: string, runs: number) {
  const ready: number[] = [];
  const painted: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(PAGE_PROBE);
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
    const seen = await page.evaluate(() => ({
      composer: (window as unknown as { __perf: { composerAt: number | null } }).__perf.composerAt ?? performance.now(),
      paint: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0,
    }));
    ready.push(seen.composer);
    painted.push(seen.paint);
    await context.close();
  }
  return { firstPaintMs: distribution(painted), composerReadyMs: distribution(ready) };
}

type Browser = { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }> };

async function openingShots(browser: Browser, url: string, dogs: { long: Dog; others: Dog[] }, folder: string, label: string) {
  mkdirSync(folder, { recursive: true });
  const seen: Array<Record<string, unknown>> = [];
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: scheme });
    await context.addInitScript(PAGE_PROBE);
    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
    await open(page, dogs.long);
    await page.waitForTimeout(1_500);
    await open(page, dogs.others[0]!);
    const look = async (stage: string) => {
      const state = await page.evaluate(() => {
        const log = document.querySelector('[role="log"]')!;
        const scroller = log.parentElement!;
        const rows = [...log.querySelectorAll("[data-mid]")];
        return {
          rows: rows.length,
          pixelsFromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
          newestRowBottomPx: Math.round(rows.at(-1)!.getBoundingClientRect().bottom),
          earlierWorkLine: document.querySelector("[data-native-work-fallbacks] summary")?.textContent ?? null,
          pills: [...document.querySelectorAll('[data-new-messages-pill], button[aria-label="Jump to latest messages"]')].map((pill) => pill.textContent ?? ""),
          arrivingRows: log.querySelectorAll("[data-arriving]").length,
        };
      });
      const file = join(folder, `${label}-${stage}-${scheme}.png`);
      await page.screenshot({ path: file });
      seen.push({ scheme, stage, file, ...state });
    };
    const first = (await openFilling(page, dogs.long, true)).rowsAtFirstSight;
    await page.evaluate(() => (window as unknown as { __perf: PagePerf }).__perf.shown());
    await look("open-1-newest-rows");
    await page.evaluate(async (shown: number) => {
      const perf = (window as unknown as { __perf: PagePerf }).__perf;
      perf.releaseFill();
      await perf.until(() => document.querySelectorAll('[role="log"] [data-mid]').length > shown, 10_000);
      perf.holdFill();
      await perf.shown();
    }, first);
    await look("open-2-filling");
    await page.evaluate(async (full: number) => {
      const perf = (window as unknown as { __perf: PagePerf }).__perf;
      perf.releaseFill();
      await perf.until(() => document.querySelectorAll('[role="log"] [data-mid]').length >= full, 10_000);
      await perf.shown();
    }, WINDOW_ROWS);
    await page.waitForTimeout(300);
    await look("open-3-filled");

    await open(page, dogs.others[0]!);
    const everyFrame = await page.evaluate(async ({ row, name, full }: { row: string; name: string; full: number }) => {
      const perf = (window as unknown as { __perf: PagePerf }).__perf;
      const log = () => document.querySelector(`[role="log"][aria-label*=${JSON.stringify(name)}]`);
      const earlierWorkLines = new Set<string>();
      const pills = new Set<string>();
      const rowCounts = new Set<number>();
      let worstPixelsFromBottom = 0;
      let arrivingRows = 0;
      let frames = 0;
      const watch = () => {
        const transcript = log();
        if (!transcript) return;
        frames += 1;
        const scroller = transcript.parentElement!;
        rowCounts.add(transcript.querySelectorAll("[data-mid]").length);
        worstPixelsFromBottom = Math.max(worstPixelsFromBottom, Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight));
        arrivingRows = Math.max(arrivingRows, transcript.querySelectorAll("[data-arriving]").length);
        earlierWorkLines.add(document.querySelector("[data-native-work-fallbacks] summary")?.textContent ?? "none");
        for (const pill of document.querySelectorAll('[data-new-messages-pill], button[aria-label="Jump to latest messages"]')) pills.add(pill.textContent ?? "");
      };
      (document.querySelector(row) as HTMLElement).click();
      await perf.until(() => { watch(); return (log()?.querySelectorAll("[data-mid]").length ?? 0) >= full; }, 20_000);
      for (let frame = 0; frame < 45; frame += 1) {
        await new Promise((done) => requestAnimationFrame(done));
        watch();
      }
      return { frames, rowCounts: [...rowCounts], earlierWorkLines: [...earlierWorkLines], pills: [...pills], worstPixelsFromBottom, arrivingRows };
    }, { row: rowOf(dogs.long), name: dogs.long.name, full: WINDOW_ROWS });
    seen.push({ scheme, stage: "every frame of one more open", ...everyFrame });
    await context.close();
  }
  return seen;
}

async function sidebarRows(browser: Browser, url: string, api: ReturnType<typeof fixtureApi>, dogs: { long: Dog; others: Dog[] }, shots: string | null, label: string) {
  const titled = dogs.others.filter((_, index) => index % 2 === 1).map((dog) => dog.id);
  for (const id of titled) await api("PATCH", `/api/bots/${id}/profile`, { title: "Release notes and checks" });
  const everyDog = await api("GET", "/api/bots") as { bots: Array<{ id: string; threadId: string }> };
  for (const dog of everyDog.bots) await api("POST", `/api/bots/${dog.id}/read`, { threadId: dog.threadId });
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  const load = async () => {
    await page.goto(url);
    await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
    await page.waitForSelector("[data-sidebar-row]", { timeout: 60_000 });
    await page.waitForTimeout(1_000);
  };
  const heldHeights = () => page.evaluate(() => {
    const held: Record<string, number[]> = {};
    let rows = 0;
    let notDrawn = 0;
    for (const row of document.querySelectorAll("[data-sidebar-row]")) {
      rows += 1;
      if (row.querySelector("[data-sidebar-bot-row] > *")!.checkVisibility({ contentVisibilityAuto: true })) continue;
      notDrawn += 1;
      const kind = row.getAttribute("data-sidebar-row") || "unmarked";
      const height = Math.round(row.getBoundingClientRect().height * 10) / 10;
      held[kind] = [...new Set([...(held[kind] ?? []), height])];
    }
    return { rows, notDrawn, held };
  });
  const drawnHeights = () => page.evaluate(async () => {
    const drawn: Record<string, number[]> = {};
    for (const row of document.querySelectorAll("[data-sidebar-row]")) {
      row.scrollIntoView({ block: "center" });
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const kind = row.getAttribute("data-sidebar-row") || "unmarked";
      const height = Math.round(row.getBoundingClientRect().height * 10) / 10;
      drawn[kind] = [...new Set([...(drawn[kind] ?? []), height])];
    }
    return drawn;
  });

  await load();
  const before = await heldHeights();
  const target = await page.evaluate((titled: string[]) => {
    const rows = [...document.querySelectorAll("[data-sidebar-row]")];
    const row = rows[rows.length - 12]!;
    const notDrawn = (candidate: Element) => !candidate.querySelector("[data-sidebar-bot-row] > *")!.checkVisibility({ contentVisibilityAuto: true });
    const above = rows.slice(0, rows.length - 12);
    return {
      id: row.querySelector("[data-sidebar-bot-row]")!.getAttribute("data-sidebar-bot-row")!,
      kind: row.getAttribute("data-sidebar-row") || "unmarked",
      notDrawnAbove: above.filter(notDrawn).length,
      titledNotDrawnAbove: above.filter((candidate) => notDrawn(candidate) && titled.includes(candidate.querySelector("[data-sidebar-bot-row]")?.getAttribute("data-sidebar-bot-row") ?? "")).length,
      unreadRowsBefore: document.querySelectorAll("[data-sidebar-unread]").length,
    };
  }, titled);
  await api("PATCH", `/api/bots/${target.id}`, { unread: true });
  await page.waitForSelector('[data-more-unreads="below"]', { timeout: 15_000 });
  const unreadRows = await page.evaluate(() => document.querySelectorAll("[data-sidebar-unread]").length);
  await page.click('[data-more-unreads="below"]');
  const landed = await page.evaluate(async (id: string) => {
    const scroller = document.querySelector("[data-sidebar-scroller]")!;
    const started = performance.now();
    let still = 0;
    let last = scroller.scrollTop;
    let settledAt = started;
    while (still < 30 && performance.now() - started < 10_000) {
      await new Promise((done) => requestAnimationFrame(done));
      if (scroller.scrollTop === last) still += 1;
      else { still = 0; last = scroller.scrollTop; settledAt = performance.now(); }
    }
    const view = scroller.getBoundingClientRect();
    const row = document.querySelector(`[data-sidebar-bot-row=${JSON.stringify(id)}]`)!.getBoundingClientRect();
    return {
      inView: row.top >= view.top && row.bottom <= view.bottom,
      pxFromCentre: Math.round(((row.top + row.bottom) / 2 - (view.top + view.bottom) / 2) * 10) / 10,
      scrolledToPx: Math.round(scroller.scrollTop),
      scrollTookMs: Math.round(settledAt - started),
      pillStillShown: Boolean(document.querySelector('[data-more-unreads="below"]')),
    };
  }, target.id);
  if (shots) {
    mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: join(shots, `${label}-sidebar-unread-jump.png`) });
  }
  const drawn = await drawnHeights();

  await page.evaluate(() => localStorage.setItem("laterdog.sidebarDensity", "icons"));
  await load();
  const iconsHeld = await heldHeights();
  const iconsDrawn = await drawnHeights();
  await page.evaluate(() => localStorage.removeItem("laterdog.sidebarDensity"));
  await context.close();
  return {
    rows: before.rows,
    rowsNotDrawnAtLoad: before.notDrawn,
    heightHeldWhileNotDrawnPx: { list: before.held, iconRail: iconsHeld.held },
    heightWhenDrawnPx: { list: drawn, iconRail: iconsDrawn },
    iconRail: { rows: iconsHeld.rows, rowsNotDrawnAtLoad: iconsHeld.notDrawn },
    unreadJump: { target: target.kind, unreadRowsBefore: target.unreadRowsBefore, unreadRows, rowsNotDrawnAbove: target.notDrawnAbove, titledRowsNotDrawnAbove: target.titledNotDrawnAbove, clicks: 1, ...landed },
  };
}

async function kept(browser: Browser, url: string, dogs: { long: Dog; others: Dog[] }) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  const load = async () => {
    await page.goto(url);
    await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
    await page.waitForSelector("[data-sidebar-bot-row]", { timeout: 60_000 });
    await page.waitForTimeout(1_000);
  };
  const draftOf = (dog: Dog) => page.evaluate((selector: string) => (document.querySelector(selector) as HTMLTextAreaElement | null)?.value ?? null, composerOf(dog));
  const selected = () => page.evaluate(() => document.querySelector('[data-sidebar-bot-row][aria-current="page"]')?.getAttribute("data-sidebar-bot-row") ?? null);
  const write = async (dog: Dog, text: string) => {
    await open(page, dog);
    await page.click(composerOf(dog));
    await page.keyboard.type(text, { delay: 5 });
  };
  const short = dogs.others[0]!;
  const longDraft = "Draft kept for the long chat";
  const shortDraft = "Draft kept for the short chat";

  await load();
  await write(dogs.long, longDraft);
  await write(short, shortDraft);
  await open(page, dogs.long);
  const longAfterSwitch = await draftOf(dogs.long);
  await open(page, short);
  const shortAfterSwitch = await draftOf(short);
  await open(page, dogs.long);
  await page.waitForTimeout(800);
  await load();
  const selectedAfterReload = await selected();
  const longAfterReload = await draftOf(dogs.long);
  await open(page, short);
  const shortAfterReload = await draftOf(short);
  for (const dog of [short, dogs.long]) {
    await open(page, dog);
    await page.click(composerOf(dog));
    await page.keyboard.press("Control+End");
    for (let index = 0; index < shortDraft.length + 2; index += 1) await page.keyboard.press("Backspace");
  }

  if (process.argv.includes("--css")) {
    await (page as unknown as { addStyleTag(options: { content: string }): Promise<unknown> }).addStyleTag({ content: option("css") });
    await page.waitForTimeout(300);
  }
  const cdp = await page.context().newCDPSession(page) as unknown as { send(method: string, params?: unknown): Promise<Record<string, unknown>> };
  await cdp.send("DOM.enable");
  await cdp.send("Accessibility.enable");
  const root = (await cdp.send("DOM.getDocument", { depth: 0 })).root as { nodeId: number };
  const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-sidebar-bot-row]" }) as { nodeIds: number[] };
  const drawnRows = await page.evaluate(() => [...document.querySelectorAll("[data-sidebar-bot-row]")].map((row) => (row.firstElementChild ?? row).checkVisibility({ contentVisibilityAuto: true })));
  const spoken: Array<{ drawn: boolean; role: string; name: string; ignored: boolean; why: string }> = [];
  for (const [index, nodeId] of nodeIds.entries()) {
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false }) as { nodes: Array<{ ignored: boolean; role?: { value: string }; name?: { value: string }; ignoredReasons?: Array<{ name: string }> }> };
    const node = nodes[0];
    spoken.push({ drawn: drawnRows[index] ?? true, role: node?.role?.value ?? "", name: node?.name?.value ?? "", ignored: node?.ignored ?? true, why: (node?.ignoredReasons ?? []).map((reason) => reason.name).join(" ") });
  }
  const namedButton = (row: { role: string; name: string; ignored: boolean }) => !row.ignored && row.role === "button" && row.name.trim().length > 0;
  await page.waitForTimeout(1_500);
  const transcript = await page.evaluate(() => {
    const log = document.querySelector('[role="log"]');
    return { label: log?.getAttribute("aria-label") ?? null, live: log?.getAttribute("aria-live") ?? null, rows: log?.querySelectorAll("[data-mid]").length ?? 0 };
  });

  await page.evaluate(() => {
    document.querySelector("[data-sidebar-scroller]")!.scrollTop = 0;
    (document.querySelector("[data-sidebar-bot-row]") as HTMLElement).focus();
  });
  const notDrawnAtTop = await page.evaluate(async () => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    return [...document.querySelectorAll("[data-sidebar-bot-row]")].filter((row) => !(row.firstElementChild ?? row).checkVisibility({ contentVisibilityAuto: true })).map((row) => row.getAttribute("data-sidebar-bot-row")!);
  });
  const reached: Array<{ id: string; inView: boolean; ring: boolean }> = [];
  for (let press = 0; press < nodeIds.length * 4 && reached.length < nodeIds.length; press += 1) {
    const at = await page.evaluate(() => {
      const row = document.activeElement?.closest("[data-sidebar-bot-row]");
      if (!row || row !== document.activeElement) return null;
      const view = document.querySelector("[data-sidebar-scroller]")!.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      const style = getComputedStyle(row);
      return {
        id: row.getAttribute("data-sidebar-bot-row")!,
        inView: box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
        ring: row.matches(":focus-visible") && (style.outlineStyle !== "none" || style.boxShadow !== "none"),
      };
    });
    if (at && !reached.some((row) => row.id === at.id)) reached.push(at);
    await page.keyboard.press("Tab");
  }
  const last = reached[reached.length - 1];
  await page.evaluate((id: string) => (document.querySelector(`[data-sidebar-bot-row=${JSON.stringify(id)}]`) as HTMLElement).focus(), last?.id ?? dogs.long.id);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const openedByEnter = await selected();
  await context.close();
  return {
    drafts: {
      afterSwitching: { long: longAfterSwitch === longDraft, short: shortAfterSwitch === shortDraft },
      afterReload: { long: longAfterReload === longDraft, short: shortAfterReload === shortDraft },
    },
    selection: { openBeforeReload: "long chat", sameChatAfterReload: selectedAfterReload === dogs.long.id },
    screenReader: {
      rows: spoken.length,
      rowsNotDrawn: spoken.filter((row) => !row.drawn).length,
      namedButtons: spoken.filter(namedButton).length,
      namedButtonsNotDrawn: spoken.filter((row) => !row.drawn && namedButton(row)).length,
      exampleDrawn: spoken.find((row) => row.drawn)?.name ?? null,
      exampleNotDrawn: spoken.find((row) => !row.drawn) ?? null,
      transcript,
    },
    keyboard: {
      rowsReachedByTab: reached.length,
      rowsNotDrawnBeforeTabbing: notDrawnAtTop.length,
      reachedOfThoseNotDrawn: reached.filter((row) => notDrawnAtTop.includes(row.id)).length,
      inViewWhenFocused: reached.filter((row) => row.inView).length,
      focusRingShown: reached.filter((row) => row.ring).length,
      enterOpensTheFocusedRow: Boolean(last) && openedByEnter === last!.id,
    },
  };
}

async function messageBox(browser: Browser, url: string, dogs: { long: Dog; others: Dog[] }) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage() as Page & { setViewportSize(size: { width: number; height: number }): Promise<void> };
  await page.goto(url);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
  await page.waitForSelector("[data-sidebar-bot-row]", { timeout: 60_000 });
  const short = dogs.others[0]!;
  await open(page, dogs.long);
  await page.waitForTimeout(1_500);
  await page.click(composerOf(dogs.long));
  const steps: Array<{ step: string; boxPx: number; wholeBoxPx: number; textPx: number; mirrorPx: number; expanded: boolean; scrolled: number; focused: boolean; characters: number }> = [];
  const note = async (step: string, dog = dogs.long) => {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    steps.push({ step, ...await page.evaluate((selector: string) => {
      const input = document.querySelector(selector) as HTMLTextAreaElement;
      const whole = input.closest("[data-composer-row]")?.parentElement ?? input;
      const mirror = input.parentElement!.querySelector(".mention-editor-mirror") as HTMLElement | null;
      return {
        boxPx: input.getBoundingClientRect().height,
        wholeBoxPx: whole.getBoundingClientRect().height,
        textPx: input.scrollHeight,
        mirrorPx: mirror?.getBoundingClientRect().width ?? 0,
        expanded: Boolean(input.closest("[data-expanded]")),
        scrolled: Math.round(input.scrollTop),
        focused: document.activeElement === input,
        characters: input.value.length,
      };
    }, composerOf(dog)) });
  };
  const type = (text: string) => page.keyboard.type(text, { delay: 3 });
  const press = async (key: string, times = 1) => { for (let index = 0; index < times; index += 1) await page.keyboard.press(key); };
  const wide = "wide ".repeat(70);

  await note("empty");
  await type("Short line");
  await note("one short line");
  await type(` ${wide}`);
  await note("typed past the edge of the box");
  await press("Backspace", wide.length - 40);
  await note("deleted back towards one line");
  await press("Backspace", 60);
  await note("deleted to nothing");
  for (let line = 1; line <= 8; line += 1) {
    await type(`line ${line}`);
    if (line < 8) await press("Shift+Enter");
    await note(`${line} typed lines`);
  }
  await press("Backspace", 14);
  await note("removed the last two lines");
  await press("Control+Home");
  await press("Delete", 7);
  await note("removed the first line from the top");
  await press("Control+a");
  await type("x");
  await note("replaced everything with one letter");
  await press("Backspace");
  await type(`aa ${"b".repeat(400)}`);
  await note("one very long word after a short one");
  await press("Control+Home");
  await press("ArrowRight", 30);
  await type(" ");
  await note("a space typed into the long word");
  await press("Control+a");
  await press("Backspace");
  await type("first");
  await press("Shift+Enter");
  await type("second");
  await press("Shift+Enter");
  await type("third");
  await note("three lines before the window narrows");
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(400);
  await note("three lines in a narrow window");
  await press("Control+a");
  await type(wide);
  await note("a long line in a narrow window");
  await page.setViewportSize(VIEWPORT);
  await page.waitForTimeout(400);
  await note("the same long line in the wide window again");
  await open(page, short);
  await note("another chat, empty box", short);
  await open(page, dogs.long);
  await page.waitForTimeout(400);
  await note("back in the chat that holds the long draft");
  await page.click(composerOf(dogs.long));
  await press("Control+a");
  await type("Two lines");
  await press("Shift+Enter");
  await type("to send");
  await note("two lines ready to send");
  await press("Enter");
  await page.waitForTimeout(600);
  await note("after sending");
  await type("y");
  await note("one letter after sending");
  await press("Backspace");
  await context.close();
  return steps;
}

interface StoreChange {
  atMs: number;
  fields: string[];
  dogs: number;
  dogFields: Record<string, number>;
}

async function storeChanges(browser: Browser, url: string, api: ReturnType<typeof fixtureApi>, dogs: { long: Dog; others: Dog[] }, streamFile: string) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
  await open(page, dogs.long);
  await page.waitForTimeout(2_000);
  const watched = async (work: () => Promise<void>) => {
    await page.evaluate(() => {
      const perf = (window as unknown as { __perf: { watchingStore: boolean; counting: boolean; storeChanges: StoreChange[]; begin(): void } }).__perf;
      perf.storeChanges.length = 0;
      perf.watchingStore = true;
      perf.counting = true;
      perf.begin();
    });
    await work();
    const seen = await page.evaluate(() => {
      const perf = (window as unknown as { __perf: { watchingStore: boolean; storeChanges: StoreChange[]; end(): Activity & { top: string[] } } }).__perf;
      perf.watchingStore = false;
      return { changes: [...perf.storeChanges], activity: perf.end() };
    });
    const kinds = new Map<string, number>();
    for (const change of seen.changes) {
      const kind = `${change.fields.join(",")}${change.dogs ? ` [${change.dogs} dogs: ${Object.entries(change.dogFields).map(([name, count]) => `${name} ${count}`).join(", ")}]` : ""}`;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    return { storeChanges: seen.changes.length, commits: seen.activity.commits, rendered: seen.activity.rendered, kinds: [...kinds.entries()].sort((left, right) => right[1] - left[1]).map(([kind, count]) => `${count} x ${kind}`), top: seen.activity.top.slice(0, 60) };
  };
  const idle = await watched(() => page.waitForTimeout(3_000));
  writeFileSync(streamFile, JSON.stringify({ everyMs: 30, chars: 10 }));
  const otherDogsWorking = await watched(async () => {
    await Promise.all(dogs.others.slice(0, 4).map((dog) => api("POST", `/api/bots/${dog.id}/messages`, { text: "Run the checks again and show me the table.", threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") })));
    await new Promise((done) => setTimeout(done, 150));
    await settled(api, dogs.others.map((dog) => dog.id));
    await page.waitForTimeout(400);
  });
  rmSync(streamFile, { force: true });
  await context.close();
  return { idle, otherDogsWorking };
}

interface DrawnLayer {
  layerId: string;
  backendNodeId?: number;
  width: number;
  height: number;
  drawsContent: boolean;
}

async function layers(browser: Browser, url: string, dogs: { long: Dog; others: Dog[] }) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
  await open(page, dogs.long);
  await page.waitForTimeout(2_000);
  const cdp = await page.context().newCDPSession(page) as unknown as {
    send(method: string, params?: unknown): Promise<Record<string, unknown>>;
    on(event: string, listener: (payload: { layers?: DrawnLayer[]; value?: Array<{ name: string; ph: string; dur?: number }> }) => void): void;
  };
  let drawn: DrawnLayer[] = [];
  cdp.on("LayerTree.layerTreeDidChange", (payload) => { if (payload.layers) drawn = payload.layers; });
  await cdp.send("DOM.enable");
  await cdp.send("LayerTree.enable");
  await page.click(composerOf(dogs.long));
  await page.keyboard.type("ab", { delay: 60 });
  await page.waitForTimeout(600);
  const why = new Map<string, number>();
  const where = new Map<string, number>();
  for (const layer of drawn) {
    const { compositingReasonIds = [] } = await cdp.send("LayerTree.compositingReasons", { layerId: layer.layerId }).catch(() => ({})) as { compositingReasonIds?: string[] };
    const reason = compositingReasonIds.join("+") || "(none given)";
    why.set(reason, (why.get(reason) ?? 0) + 1);
    let place = "(no element)";
    if (layer.backendNodeId) {
      const described = await cdp.send("DOM.describeNode", { backendNodeId: layer.backendNodeId }).catch(() => null) as { node?: { localName?: string; attributes?: string[] } } | null;
      const attributes = described?.node?.attributes ?? [];
      const named = (name: string) => { const index = attributes.indexOf(name); return index === -1 ? "" : attributes[index + 1] ?? ""; };
      const marks = attributes.filter((_, index) => index % 2 === 0 && attributes[index]!.startsWith("data-")).slice(0, 3).join(" ");
      place = `${described?.node?.localName ?? "?"} ${marks} .${named("class").slice(0, 60)}`;
    }
    where.set(`${reason} @ ${place}`, (where.get(`${reason} @ ${place}`) ?? 0) + 1);
  }
  const ranked = (counts: Map<string, number>) => [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 40).map(([name, count]) => `${count} x ${name}`);
  await cdp.send("LayerTree.disable");

  const typed = async (label: string, selector: string) => {
    const stages = new Map<string, { ms: number; count: number }>();
    const collect = (payload: { value?: Array<{ name: string; ph: string; dur?: number }> }) => {
      for (const event of payload.value ?? []) {
        if (event.ph !== "X" || !event.dur) continue;
        const stage = stages.get(event.name) ?? { ms: 0, count: 0 };
        stage.ms += event.dur / 1000;
        stage.count += 1;
        stages.set(event.name, stage);
      }
    };
    let finish = () => {};
    const finished = new Promise<void>((done) => { finish = done; });
    cdp.on("Tracing.dataCollected", collect);
    cdp.on("Tracing.tracingComplete", () => finish());
    await page.click(selector);
    await cdp.send("Tracing.start", { transferMode: "ReportEvents", traceConfig: { includedCategories: ["devtools.timeline"] } });
    await page.keyboard.type("Can you also check whether the notes mention it?", { delay: 35 });
    await page.waitForTimeout(200);
    await cdp.send("Tracing.end");
    await finished;
    for (let index = 0; index < 60; index += 1) await page.keyboard.press("Backspace");
    const stage = (name: string) => `${name} ${Math.round(stages.get(name)?.ms ?? 0)} ms x${stages.get(name)?.count ?? 0}`;
    return `${label}: ${["Layerize", "Paint", "PrePaint", "Layout", "UpdateLayoutTree", "EventDispatch", "FunctionCall"].map(stage).join(", ")}`;
  };
  const results: string[] = [];
  results.push(await typed("message box as it is", composerOf(dogs.long)));
  await page.evaluate(() => {
    const plain = document.createElement("textarea");
    plain.id = "perf-plain-box";
    plain.style.cssText = "position:fixed;left:600px;top:10px;width:300px;height:40px;z-index:99999";
    document.body.append(plain);
  });
  results.push(await typed("a plain box added to the page", "#perf-plain-box"));
  await page.evaluate(() => document.querySelector("#perf-plain-box")!.remove());
  const without = async (label: string, selector: string) => {
    const hidden = await page.evaluate((target: string) => {
      const found = [...document.querySelectorAll(target)] as HTMLElement[];
      for (const element of found) element.style.display = "none";
      return found.length;
    }, selector);
    await page.waitForTimeout(300);
    results.push(await typed(`${label} hidden (${hidden})`, composerOf(dogs.long)));
    await page.evaluate((target: string) => { for (const element of [...document.querySelectorAll(target)] as HTMLElement[]) element.style.display = ""; }, selector);
    await page.waitForTimeout(300);
  };
  await without("sidebar rows", "[data-sidebar-row]");
  await without("transcript", '[role="log"]');
  if (process.argv.includes("--hide")) await without(option("hide"), option("hide"));
  await context.close();
  return { layers: drawn.length, drawing: drawn.filter((layer) => layer.drawsContent).length, why: ranked(why), where: ranked(where), typing: results };
}

function redraws(activity: Activity & { top?: string[] }) {
  return { commits: activity.commits, rendered: activity.rendered, ...(activity.top ? { top: activity.top } : {}) };
}

async function main() {
  const setup = options();
  const staticDir = resolve(option("dist", join(ROOT, "dist")));
  if (!existsSync(join(staticDir, "index.html"))) throw new Error("build the renderer first: pnpm exec vite build");
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-desktop-perf-"));
  const streamFile = join(scratch, "stream.json");
  const repliesFile = join(scratch, "replies.json");
  const replyIndexFile = join(scratch, "reply-index");
  writeFileSync(repliesFile, JSON.stringify(scriptedReplies));
  const fixture = await launchVerificationServer({
    ...process.env,
    LATERDOG_TEST_STATIC_DIR: staticDir,
    FAKE_CLAUDE_REPLIES_FILE: repliesFile,
    FAKE_CLAUDE_REPLY_STATE: replyIndexFile,
    FAKE_CLAUDE_TOOL_CALLS: "[]",
    FAKE_CLAUDE_STREAM_FILE: streamFile,
  });
  const { chromium } = createRequire(join(setup.playwright, "package.json"))("playwright-core") as { chromium: { launch(options: unknown): Promise<{ newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }>; close(): Promise<void> }> } };
  const browser = await chromium.launch({ executablePath: setup.browser, args: ["--no-sandbox", "--enable-precise-memory-info"] });
  try {
    const api = fixtureApi(fixture.info.url);
    const seedStarted = Date.now();
    const dogs = await seed(api, setup);
    const seedSeconds = Math.round((Date.now() - seedStarted) / 1000);
    if (process.argv.includes("--probe-remove")) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(PAGE_PROBE);
      const page = await context.newPage();
      await page.goto(fixture.info.url);
      await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
      await open(page, dogs.long);
      const probe = await page.evaluate(() => {
        const log = document.querySelector('[role="log"]') as HTMLElement;
        const settle = () => document.body.getBoundingClientRect().height;
        const copies = [0, 1, 2].map(() => log.cloneNode(true) as HTMLElement);
        for (const copy of copies) { copy.removeAttribute("role"); log.parentElement!.append(copy); }
        settle();
        const timed = (work: () => void) => { const started = performance.now(); work(); const removed = performance.now() - started; settle(); return { removeMs: Math.round(removed * 10) / 10, withLayoutMs: Math.round((performance.now() - started) * 10) / 10 }; };
        const oneByOne = timed(() => { while (copies[0]!.firstChild) copies[0]!.removeChild(copies[0]!.firstChild); });
        const whole = timed(() => copies[1]!.remove());
        const hiddenFirst = timed(() => { copies[2]!.style.display = "none"; settle(); copies[2]!.remove(); });
        return { children: log.children.length, nodes: log.querySelectorAll("*").length, oneByOne, whole, hiddenFirst, observers: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize };
      });
      process.stdout.write(`${JSON.stringify(probe)}\n`);
      await page.evaluate(() => {
        const slow: string[] = [];
        (window as unknown as { __slow: string[] }).__slow = slow;
        const original = Node.prototype.removeChild;
        Node.prototype.removeChild = function patched<T extends Node>(this: Node, child: T): T {
          const started = performance.now();
          const element = child as unknown as Element;
          const about = `${element.tagName ?? child.nodeName} .${String(element.className ?? "").slice(0, 70)} nodes=${element.querySelectorAll ? element.querySelectorAll("*").length : 0} parent=${(this as Element).tagName}.${String((this as Element).className ?? "").slice(0, 50)}`;
          const result = original.call(this, child) as T;
          const took = performance.now() - started;
          if (took > 1.5) slow.push(`${took.toFixed(1)} ms ${about}`);
          return result;
        };
      });
      await open(page, dogs.others[0]!);
      await open(page, dogs.long);
      await open(page, dogs.others[0]!);
      process.stdout.write(`${JSON.stringify(await page.evaluate(() => (window as unknown as { __slow: string[] }).__slow), null, 1)}\n`);
      const rounds = async (blurFirst: boolean) => {
        const times: number[] = [];
        for (let round = 0; round < 8; round += 1) {
          await open(page, dogs.others[0]!);
          if (blurFirst) await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
          times.push(await open(page, dogs.long));
        }
        return distribution(times);
      };
      process.stdout.write(`${JSON.stringify({ asIs: await rounds(false), blurFirst: await rounds(true), asIsAgain: await rounds(false) })}\n`);
      await context.close();
      return;
    }
    if (process.argv.includes("--hot-reload-storm")) {
      const hot = await devServer(fixture.info.url, scratch);
      try {
        const result = { label: setup.label, at: new Date().toISOString(), storms: await hotReloadStorm(browser, hot, option("hot-reload-storm").split(","), Number(option("storm-seconds", "12"))) };
        mkdirSync(dirname(setup.out), { recursive: true });
        writeFileSync(setup.out, `${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } finally {
        hot.child.kill();
      }
      return;
    }
    if (process.argv.includes("--soak")) {
      const hot = process.argv.includes("--dev-server") ? await devServer(fixture.info.url, scratch) : null;
      try {
        const result = {
          label: setup.label,
          at: new Date().toISOString(),
          setup: { ...setup, seedSeconds, renderer: hot ? "this checkout through the hot-reload dev server" : "production build served by the fixture server", platform: `${process.platform} ${process.arch}`, messagesInLongChat: setup.longTurns * 2 },
          soak: await soak(browser, hot?.url ?? fixture.info.url, api, dogs, streamFile, Number(option("soak")), Number(option("soak-every", "5"))),
        };
        mkdirSync(dirname(setup.out), { recursive: true });
        writeFileSync(setup.out, `${JSON.stringify(result, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify({ ...result, soak: { ...result.soak, samples: undefined } }, null, 2)}\n`);
      } finally {
        hot?.child.kill();
      }
      return;
    }
    if (process.argv.includes("--profile-switch") || process.argv.includes("--profile-typing")) {
      process.stdout.write(`${JSON.stringify(await switchProfile(browser, fixture.info.url, dogs, process.argv.includes("--profile-typing")), null, 2)}\n`);
      return;
    }
    const files = { stream: streamFile, replyIndex: replyIndexFile };
    if (process.argv.includes("--opening-shots")) {
      process.stdout.write(`${JSON.stringify(await openingShots(browser, fixture.info.url, dogs, resolve(option("opening-shots")), setup.label), null, 2)}\n`);
      return;
    }
    if (process.argv.includes("--store-changes")) {
      process.stdout.write(`${JSON.stringify(await storeChanges(browser, fixture.info.url, api, dogs, streamFile), null, 2)}\n`);
      return;
    }
    if (process.argv.includes("--layers")) {
      process.stdout.write(`${JSON.stringify(await layers(browser, fixture.info.url, dogs), null, 2)}\n`);
      return;
    }
    if (process.argv.includes("--message-box")) {
      const result = { label: setup.label, at: new Date().toISOString(), dogs: dogs.others.length + 1, messageBox: await messageBox(browser, fixture.info.url, dogs) };
      mkdirSync(dirname(setup.out), { recursive: true });
      writeFileSync(setup.out, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    if (process.argv.includes("--sidebar-rows") || process.argv.includes("--kept")) {
      const result = {
        label: setup.label,
        at: new Date().toISOString(),
        dogs: dogs.others.length + 1,
        ...(process.argv.includes("--kept") ? { kept: await kept(browser, fixture.info.url, dogs) } : {}),
        ...(process.argv.includes("--sidebar-rows") ? await sidebarRows(browser, fixture.info.url, api, dogs, process.argv.includes("--shots") ? resolve(option("shots")) : null, setup.label) : {}),
      };
      mkdirSync(dirname(setup.out), { recursive: true });
      writeFileSync(setup.out, `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const cold = await coldLoads(browser, fixture.info.url, setup.coldRuns);
    const timed = await pass(browser, fixture, api, dogs, setup, files, false);
    const counted = await pass(browser, fixture, api, dogs, setup, files, true);
    const result = {
      label: setup.label,
      at: new Date().toISOString(),
      setup: { ...setup, seedSeconds, renderer: "production build served by the fixture server", browser: setup.browser, platform: `${process.platform} ${process.arch}`, messagesInLongChat: setup.longTurns * 2 },
      cold,
      timed,
      counted: {
        switching: redraws(counted.switching),
        typing: redraws(counted.typing),
        scrolling: redraws(counted.scrolling),
        streaming: redraws(counted.streaming),
        otherDogsWorking: redraws(counted.otherDogsWorking),
      },
      memory: timed.rssMb,
    };
    mkdirSync(dirname(setup.out), { recursive: true });
    writeFileSync(setup.out, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await browser.close();
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
