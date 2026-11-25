import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchVerificationServer,
  runControlLaterDog,
  type VerificationServer,
} from "../control-laterdog.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";
import { openBrowser, type Browser, type Page } from "./wait-and-landing-cdp.ts";
import { BUSY_TURN } from "./wait-and-landing-model.ts";
import { MOMENTS, WORK, browserPath } from "./wait-and-landing-shots.ts";

const DOG = "Scout";
const TOOL_CALLS = [
  { name: "Read", input: { file_path: "/srv/shop/src/OrderForm.tsx" }, output: "ok" },
  { name: "Read", input: { file_path: "/srv/shop/docs/spring-menu.md" }, output: "ok" },
  {
    name: "Edit",
    input: {
      file_path: "/srv/shop/docs/spring-menu.md",
      old_string: "Soup",
      new_string: "Spring soup",
    },
    output: "ok",
  },
  {
    name: "Bash",
    input: { command: "pnpm test order-form", description: "Run the order form tests" },
    pending: true,
  },
];
const ROW = `document.querySelector('[data-sidebar-bot-row="' + window.__scout + '"]')`;
const COMPOSER = `document.querySelector('textarea[aria-label="Message ${DOG}"]')`;
const FRAME_TIMES = [0, 50, 100, 150, 200, 300, 400];
const HISTORY = [
  "Can you check which suppliers still owe us an invoice?",
  "Thanks. And the fridge repair?",
  "Let's do the spring menu next.",
  "Lovely. A few people say they can't order though.",
];

interface Sample {
  t: number;
  workLine: string | null;
  workLineHeight: number | null;
  headerDot: boolean;
  sidebarDot: string | null;
  sidebarLine: string | null;
  foldLine: string | null;
  receipt: string | null;
  sending: boolean;
  promptTop: number | null;
  scrollTop: number;
}

const SAMPLE = `(() => {
  const log = document.querySelector('[role="log"]');
  const scroller = log ? log.closest('.glass-scroller') : null;
  const line = log ? log.querySelector('[data-work-line]') : null;
  const bubbles = log ? [...log.querySelectorAll('[data-chat-bubble]')] : [];
  const prompt = bubbles.find((node) => node.textContent.includes(${JSON.stringify(BUSY_TURN.prompt)}));
  const row = ${ROW};
  const dot = row ? row.querySelector('[data-row-dot]') : null;
  const fold = log ? log.querySelector('[data-fold-line]') : null;
  const receipt = log ? log.querySelector('[data-receipt], [data-send-held]') : null;
  return {
    workLine: line ? line.textContent.replace(/\\s+/g, ' ').trim() : null,
    workLineHeight: line ? Math.round(line.getBoundingClientRect().height * 100) / 100 : null,
    headerDot: Boolean(document.querySelector('[data-chathead-pill] [data-working-dot], [data-chathead-pill] [data-testid="waiting-dot"]')),
    sidebarDot: dot ? dot.getAttribute('data-row-dot') : null,
    sidebarLine: row ? row.textContent.replace(/\\s+/g, ' ').trim() : null,
    foldLine: fold ? fold.textContent.replace(/\\s+/g, ' ').trim() : null,
    receipt: receipt ? receipt.textContent.trim() : null,
    sending: Boolean(log && log.querySelector('[data-sending-track]')),
    promptTop: prompt ? Math.round(prompt.getBoundingClientRect().top * 100) / 100 : null,
    scrollTop: scroller ? scroller.scrollTop : 0,
  };
})()`;

const ROWS = `(() => {
  const log = document.querySelector('[role="log"]');
  const seen = new Map();
  return [...log.querySelectorAll('[data-chat-bubble], [data-work-line], [data-fold-line]')].map((node) => {
    const base = (node.hasAttribute('data-chat-bubble') ? 'bubble:' : node.hasAttribute('data-work-line') ? 'work-line:' : 'fold-line:') + node.textContent.replace(/\\s+/g, ' ').trim().slice(0, 40);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const box = node.getBoundingClientRect();
    return { id: base + '#' + count, top: Math.round(box.top * 100) / 100, height: Math.round(box.height * 100) / 100 };
  });
})()`;

interface RowBox {
  id: string;
  top: number;
  height: number;
}

async function until(started: number, at: number): Promise<void> {
  const wait = started + at - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

async function sampleWhile(
  page: Page,
  started: number,
  untilMs: number,
  samples: Sample[],
): Promise<void> {
  while (Date.now() - started < untilMs) {
    samples.push({ t: Date.now() - started, ...(await page.evaluate<Omit<Sample, "t">>(SAMPLE)) });
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function moved(before: RowBox[], after: RowBox[]): { rows: number; max: number } {
  let max = 0;
  let rows = 0;
  for (const row of before) {
    if (row.id.startsWith("work-line:")) continue;
    const now = after.find((candidate) => candidate.id === row.id);
    if (!now) continue;
    rows += 1;
    max = Math.max(max, Math.abs(now.top - row.top));
  }
  return { rows, max: Math.round(max * 100) / 100 };
}

async function main(): Promise<void> {
  mkdirSync(join(WORK, "frames"), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "wait-and-landing-before-"));
  const gate = join(work, "finish.gate");
  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await launchVerificationServer({
      ...process.env,
      FAKE_CLAUDE_MODE: "slow",
      FAKE_CLAUDE_SLOW_FINISH_GATE: gate,
      FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(TOOL_CALLS),
    });
    await fixtureApi(fixture.info.url)("PATCH", "/api/config", { language: "en" });
    const created = (await runControlLaterDog([
      "new-bot",
      "--name",
      DOG,
      "--url",
      fixture.info.url,
    ])) as { bot: { id: string } };
    preview = await mountPreview(fixture, {
      entry: "/scripts/testing/threads-preview.tsx",
      route: "/__threads.html",
      title: "Isolated later.dog Chat",
      logLevel: "warn",
    });
    browser = await openBrowser(await browserPath());
    const page = browser.page;
    await page.viewport(1280, 800, 2);
    await page.goto(preview.previewUrl);
    await page.evaluate(`(localStorage.setItem("laterdog-skin", "daylight"), true)`);
    await page.goto(preview.previewUrl, `!document.querySelector('[data-launch-splash="shown"]')`);
    await page.evaluate(`(window.__scout = ${JSON.stringify(created.bot.id)}, true)`);
    await page.waitFor(ROW, 60_000);
    await page.evaluate(`(${ROW}.click(), true)`);
    await page.waitFor(COMPOSER, 30_000);
    await page.frames(10);
    const greeting = await page.evaluate<string>(
      `(() => { const node = document.querySelector('[role="log"] [data-from="agent"] [data-chat-bubble]'); return node ? node.textContent.trim() : ""; })()`,
    );
    writeFileSync(gate, "go");
    const history: Array<{ user: string; reply: string; fold: string | null }> = [];
    for (const text of HISTORY) {
      await page.evaluate(`(${COMPOSER}.focus(), true)`);
      await page.typeText(text);
      await page.pressEnter();
      await page.waitFor(
        `[...document.querySelectorAll('[role="log"] [data-chat-bubble]')].some((node) => node.textContent.includes(${JSON.stringify(`reply to: ${text}`)}))`,
        60_000,
      );
      await page.waitFor(`!document.querySelector('[role="log"] [data-work-line]')`, 30_000);
      history.push({ user: text, reply: `reply to: ${text}`, fold: null });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const folds = await page.evaluate<string[]>(
      `[...document.querySelectorAll('[role="log"] [data-fold-line]')].map((node) => node.textContent.replace(/\\s+/g, ' ').trim())`,
    );
    history.forEach((entry, index) => {
      entry.fold = folds[index] ?? null;
    });
    rmSync(gate, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.evaluate(`(${COMPOSER}.focus(), true)`);
    await page.typeText(BUSY_TURN.prompt);
    const samples: Sample[] = [];
    const started = Date.now();
    await page.pressEnter();
    await sampleWhile(page, started, MOMENTS.sent, samples);
    await page.screenshot(join(WORK, "before-sent.png"));
    await sampleWhile(page, started, MOMENTS.working, samples);
    await page.screenshot(join(WORK, "before-working.png"));
    await sampleWhile(page, started, MOMENTS.minute, samples);
    await until(started, MOMENTS.minute);
    await page.screenshot(join(WORK, "before-minute.png"));
    const rowsBefore = await page.evaluate<RowBox[]>(ROWS);
    const scrollBefore = (await page.evaluate<Omit<Sample, "t">>(SAMPLE)).scrollTop;
    await page.evaluate("(window.__wlBefore = new Set(document.getAnimations()), true)");
    writeFileSync(gate, "go");
    await page.waitFor(
      `[...document.querySelectorAll('[role="log"] [data-chat-bubble]')].some((node) => node.textContent.includes(${JSON.stringify(`reply to: ${BUSY_TURN.prompt}`)}))`,
      30_000,
    );
    await page.evaluate(
      `(document.getAnimations().filter((a) => !window.__wlBefore.has(a)).forEach((a) => a.pause()), true)`,
    );
    const frames: Array<{ t: number; rows: RowBox[] }> = [];
    for (const t of FRAME_TIMES) {
      await page.evaluate(
        `(document.getAnimations().filter((a) => !window.__wlBefore.has(a)).forEach((a) => { a.pause(); a.currentTime = ${t}; }), true)`,
      );
      await page.frames(1);
      frames.push({ t, rows: await page.evaluate<RowBox[]>(ROWS) });
      await page.screenshot(
        join(WORK, "frames", `before-landing-${String(t).padStart(3, "0")}.png`),
      );
    }
    await page.evaluate(
      "(document.getAnimations().forEach((a) => { if (a.effect && a.effect.getTiming().iterations !== Infinity) a.finish(); }), true)",
    );
    const landedAt = Date.now();
    const later: Array<{ t: number; rows: RowBox[]; scrollTop: number }> = [];
    for (const wait of [0, 300, 1_000, 2_500]) {
      await until(landedAt, wait);
      later.push({
        t: wait,
        rows: await page.evaluate<RowBox[]>(ROWS),
        scrollTop: (await page.evaluate<Omit<Sample, "t">>(SAMPLE)).scrollTop,
      });
    }
    await until(landedAt, 600);
    await page.screenshot(join(WORK, "before-landed.png"));
    const after = later.at(-1)!;
    const reply = await page.evaluate<string>(
      `(() => { const node = [...document.querySelectorAll('[role="log"] [data-chat-bubble]')].find((candidate) => candidate.textContent.includes(${JSON.stringify(`reply to: ${BUSY_TURN.prompt}`)})); return node ? node.textContent.trim() : ""; })()`,
    );
    const lineHeights = [...new Set(samples.map((sample) => sample.workLineHeight ?? 0))];
    const lineTexts = [
      ...new Set(
        samples.map((sample) => sample.workLine).filter((text): text is string => Boolean(text)),
      ),
    ];
    const result = {
      texts: {
        greeting,
        prompt: BUSY_TURN.prompt,
        reply,
        history,
        fold: (await page.evaluate<Omit<Sample, "t">>(SAMPLE)).foldLine,
      },
      surfaces: {
        workLineTexts: lineTexts,
        workLineHeights: lineHeights,
        headerDotSeen: samples.some((sample) => sample.headerDot),
        sidebarDots: [...new Set(samples.map((sample) => sample.sidebarDot))],
        receipts: [...new Set(samples.map((sample) => sample.receipt))],
        sendingTrackSeen: samples.some((sample) => sample.sending),
        promptTops: [...new Set(samples.map((sample) => sample.promptTop))],
      },
      landing: {
        rowsChecked: moved(rowsBefore, after.rows).rows,
        maxRowShift: Math.max(
          ...frames.map((frame) => moved(rowsBefore, frame.rows).max),
          ...later.map((entry) => moved(rowsBefore, entry.rows).max),
        ),
        scrollTopShift: Math.round((after.scrollTop - scrollBefore) * 100) / 100,
        foldLineAfter: (await page.evaluate<Omit<Sample, "t">>(SAMPLE)).foldLine,
        settling: later.map((entry) => ({
          t: entry.t,
          maxRowShift: moved(rowsBefore, entry.rows).max,
          scrollTop: entry.scrollTop,
        })),
      },
      samples,
    };
    writeFileSync(join(WORK, "before.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(
      JSON.stringify(
        { texts: result.texts, surfaces: result.surfaces, landing: { ...result.landing } },
        null,
        2,
      ),
    );
  } finally {
    await browser?.close();
    await preview?.close();
    await fixture?.close();
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
