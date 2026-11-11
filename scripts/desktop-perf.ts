import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchVerificationServer, type VerificationServer } from "./control-laterdog.ts";
import { fixtureApi } from "./testing/preview-fixture.ts";

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

interface Activity {
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
  return Array.from({ length: 4000 }, (_, index) => `Answer ${index + 1}. ${shapes[index % shapes.length]}`);
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
  await api("PATCH", "/api/config", { language: "en" });
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
  const perf = { commits: 0, rendered: 0, counting: false, longTasks: [], frames: [], composerAt: null, keys: [] };
  window.__perf = perf;
  const component = (tag) => tag === 0 || tag === 1 || tag === 11 || tag === 14 || tag === 15;
  const visit = (next, previous) => {
    if (component(next.tag) && (next.flags & 1) === 1) perf.rendered += 1;
    if (previous && next.child === previous.child) return;
    for (let child = next.child; child; child = child.sibling) visit(child, child.alternate);
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot(_id, root) { perf.commits += 1; if (perf.counting) visit(root.current, root.current.alternate); },
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
  perf.begin = () => { perf.commits = 0; perf.rendered = 0; perf.longTasks.length = 0; perf.frames.length = 0; perf.keys.length = 0; perf.startedAt = performance.now(); };
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
  });
  perf.until = (test, timeoutMs) => new Promise((done, fail) => {
    const deadline = performance.now() + timeoutMs;
    const look = () => { if (test()) done(performance.now()); else if (performance.now() > deadline) fail(new Error("timed out waiting in the page")); else requestAnimationFrame(look); };
    look();
  });
  perf.shown = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
})();`;

type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T>(run: string | ((argument: never) => T | Promise<T>), argument?: unknown): Promise<T>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  click(selector: string): Promise<void>;
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

async function measured<T>(page: Page, counting: boolean, work: () => Promise<T>): Promise<Activity & { keys: number[]; value: T }> {
  await page.evaluate((on: boolean) => {
    const perf = (window as unknown as { __perf: { counting: boolean; begin(): void } }).__perf;
    perf.counting = on;
    perf.begin();
  }, counting);
  const value = await work();
  const result = await page.evaluate(() => (window as unknown as { __perf: { end(): Activity & { keys: number[] } } }).__perf.end());
  return { ...result, value };
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

async function heap(page: Page): Promise<{ heapMb: number; nodes: number }> {
  const session = await page.context().newCDPSession(page);
  await session.send("HeapProfiler.collectGarbage");
  const { metrics = [] } = await session.send("Performance.getMetrics");
  const value = (name: string) => metrics.find((metric) => metric.name === name)?.value ?? 0;
  return { heapMb: Math.round(value("JSHeapUsedSize") / 1024 / 1024 * 10) / 10, nodes: value("Nodes") };
}

async function pass(browser: { newContext(options: unknown): Promise<{ addInitScript(script: string): Promise<void>; newPage(): Promise<Page>; close(): Promise<void> }> }, fixture: VerificationServer, api: ReturnType<typeof fixtureApi>, dogs: { long: Dog; others: Dog[] }, setup: Options, streamFile: string, counting: boolean) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(PAGE_PROBE);
  const page = await context.newPage();
  await page.goto(fixture.info.url);
  await page.waitForSelector('textarea[aria-label^="Message "]', { timeout: 60_000 });
  await page.waitForTimeout(1_000);
  const idle = await heap(page);
  const short = dogs.others[0]!;
  await open(page, dogs.long);
  await open(page, short);

  const toLong: number[] = [];
  const toShort: number[] = [];
  const switching = await measured(page, counting, async () => {
    for (let round = 0; round < setup.switches; round += 1) {
      toLong.push(await open(page, dogs.long));
      toShort.push(await open(page, short));
    }
  });

  await open(page, dogs.long);
  await page.click(composerOf(dogs.long));
  const typing = await measured(page, counting, async () => {
    await page.keyboard.type("Can you also check whether the release notes mention the bigger chat text and the new usage sheet, and fix them if not?", { delay: 35 });
    await page.waitForTimeout(300);
  });
  for (let index = 0; index < 130; index += 1) await page.keyboard.press("Backspace");

  await page.mouse.move(820, 420);
  const scrolling = await measured(page, counting, async () => {
    for (let step = 0; step < 90; step += 1) {
      await page.mouse.wheel(0, step < 60 ? -700 : 900);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(300);
  });

  writeFileSync(streamFile, JSON.stringify({ everyMs: 25, chars: 28 }));
  await open(page, dogs.long);
  await page.click(composerOf(dogs.long));
  const token = `streamed-${randomUUID().slice(0, 8)}`;
  await page.keyboard.type(`One more pass please ${token}`, { delay: 5 });
  const streaming = await measured(page, counting, async () => {
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

  const elsewhere = await measured(page, counting, async () => {
    await Promise.all(dogs.others.slice(0, 4).map((dog) => api("POST", `/api/bots/${dog.id}/messages`, { text: "Run the checks again and show me the table.", threadId: dog.threadId, sendId: randomUUID().replaceAll("-", "") })));
    await new Promise((done) => setTimeout(done, 150));
    await settled(api, dogs.others.map((dog) => dog.id));
    await page.waitForTimeout(400);
  });
  rmSync(streamFile, { force: true });

  const after = await heap(page);
  await context.close();
  const trim = ({ keys: _keys, value: _value, ...rest }: Activity & { keys: number[]; value: unknown }) => rest;
  return {
    heapIdleMb: idle.heapMb,
    heapAfterMb: after.heapMb,
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

async function main() {
  const setup = options();
  const staticDir = join(ROOT, "dist");
  if (!existsSync(join(staticDir, "index.html"))) throw new Error("build the renderer first: pnpm exec vite build");
  const scratch = mkdtempSync(join(tmpdir(), "laterdog-desktop-perf-"));
  const streamFile = join(scratch, "stream.json");
  const fixture = await launchVerificationServer({
    ...process.env,
    LATERDOG_TEST_STATIC_DIR: staticDir,
    FAKE_CLAUDE_REPLIES: JSON.stringify(replies()),
    FAKE_CLAUDE_REPLY_STATE: join(scratch, "reply-index"),
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
    const cold = await coldLoads(browser, fixture.info.url, setup.coldRuns);
    const timed = await pass(browser, fixture, api, dogs, setup, streamFile, false);
    const counted = await pass(browser, fixture, api, dogs, setup, streamFile, true);
    const result = {
      label: setup.label,
      at: new Date().toISOString(),
      setup: { ...setup, seedSeconds, renderer: "production build served by the fixture server", browser: setup.browser, platform: `${process.platform} ${process.arch}`, messagesInLongChat: setup.longTurns * 2 },
      cold,
      timed,
      counted: {
        switching: { commits: counted.switching.commits, rendered: counted.switching.rendered },
        typing: { commits: counted.typing.commits, rendered: counted.typing.rendered },
        scrolling: { commits: counted.scrolling.commits, rendered: counted.scrolling.rendered },
        streaming: { commits: counted.streaming.commits, rendered: counted.streaming.rendered },
        otherDogsWorking: { commits: counted.otherDogsWorking.commits, rendered: counted.otherDogsWorking.rendered },
      },
      memory: { serverTreeRssMb: treeRss(fixture.info.pid), harnessTreeRssMb: treeRss(process.pid) },
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
