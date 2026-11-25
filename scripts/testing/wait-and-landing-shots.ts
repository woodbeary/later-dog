import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ensureUiBrowser } from "./control-laterdog-ui.ts";
import { mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";
import { openBrowser, type Clip, type Page } from "./wait-and-landing-cdp.ts";
import { BUSY_TURN, busyTimeline, visibleChanges } from "./wait-and-landing-model.ts";

export const ASSETS = join(REPO_ROOT, "docs", "verification", "assets", "wait-and-landing");
export const WORK = join(REPO_ROOT, ".laterdog-evidence", "wait-and-landing");
const WORK_URL = "/.laterdog-evidence/wait-and-landing";
const NO_SERVER = { info: { url: "http://127.0.0.1:9" } };
const SKINS = [
  ["daylight", "light"],
  ["midnight", "dark"],
] as const;
const READY = "window.__wl && window.__wl.ready === true";
const FRAME_TIMES = [0, 50, 100, 150, 200, 250, 300, 400];
const CASES = ["fold", "plain", "long", "reading", "batch", "split", "asks-away"] as const;
const WINDOWS = { mac: { width: 1148, height: 808 }, phone: { width: 460, height: 920 } } as const;
export const MOMENTS = {
  sent: 600,
  working: 5_000,
  minute: 65_000,
  landed: BUSY_TURN.landsAt + 600,
} as const;

export async function browserPath(): Promise<string> {
  const explicit = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit) return explicit;
  const { chrome } = await ensureUiBrowser(process.env, (line) => console.error(line));
  if (!chrome)
    throw new Error(
      "no headless browser; set AGENT_BROWSER_EXECUTABLE_PATH to a Chrome or Chromium",
    );
  return chrome;
}

export async function settle(page: Page): Promise<void> {
  await page.frames(2);
  await page.evaluate(
    "Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).map((a) => { a.finish(); return a.finished; })).then(() => true)",
  );
  await page.frames(1);
}

const seekNew = (t: number) =>
  `(document.getAnimations().filter((a) => !window.__wlBefore.has(a)).forEach((a) => { a.pause(); a.currentTime = ${t}; }), true)`;

interface Box {
  id: string;
  top: number;
  height: number;
}
interface Snapshot {
  rows: Box[];
  scrollTop: number;
  scrollHeight: number;
  slotTop: number | null;
  slotHeight: number | null;
  firstReplyTop: number | null;
}

const SNAPSHOT = `(() => {
  const scroller = document.querySelector('[data-scroller]');
  const round = (value) => Math.round(value * 100) / 100;
  const rows = [...document.querySelectorAll('[data-row]')].filter((node) => !node.closest('[data-arriving]')).map((node) => { const box = node.getBoundingClientRect(); return { id: node.getAttribute('data-row'), top: round(box.top), height: round(box.height) }; });
  const slot = document.querySelector('[data-turn-slot]');
  const reply = document.querySelector('[data-arriving] > [data-row]');
  return { rows, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, slotTop: slot ? round(slot.getBoundingClientRect().top) : null, slotHeight: slot ? round(slot.getBoundingClientRect().height) : null, firstReplyTop: reply ? round(reply.getBoundingClientRect().top) : null };
})()`;

function shift(
  before: Snapshot,
  later: Snapshot,
  skip: ReadonlySet<string>,
): { max: number; checked: number } {
  let max = 0;
  let checked = 0;
  for (const row of before.rows) {
    if (skip.has(row.id)) continue;
    const now = later.rows.find((candidate) => candidate.id === row.id);
    if (!now) continue;
    checked += 1;
    max = Math.max(max, Math.abs(now.top - row.top));
  }
  return { max: Math.round(max * 100) / 100, checked };
}

async function landNow(
  page: Page,
  onFrame?: (t: number) => Promise<void>,
  times: readonly number[] = FRAME_TIMES,
): Promise<{ before: Snapshot; frames: Snapshot[]; after: Snapshot }> {
  const before = await page.evaluate<Snapshot>(SNAPSHOT);
  await page.evaluate("(window.__wlBefore = new Set(document.getAnimations()), true)");
  await page.evaluate("(window.__wl.land(), true)");
  await page.frames(2);
  const frames: Snapshot[] = [];
  for (const t of times) {
    await page.evaluate(seekNew(t));
    await page.frames(1);
    frames.push(await page.evaluate<Snapshot>(SNAPSHOT));
    if (onFrame) await onFrame(t);
  }
  await settle(page);
  return { before, frames, after: await page.evaluate<Snapshot>(SNAPSHOT) };
}

export interface GridCheck {
  skin: string;
  part: string;
  states: number;
  macSlots: number;
  phoneSlots: number;
  mac: number[];
  phone: number[];
}

async function gridShots(page: Page, url: string): Promise<GridCheck[]> {
  const checks: GridCheck[] = [];
  await page.viewport(1530, 1000, 2);
  for (const [skin, look] of SKINS) {
    for (const part of ["1", "2"]) {
      await page.goto(`${url}?view=grid&skin=${skin}&part=${part}`, READY);
      await settle(page);
      const sizes = await page.evaluate<{
        states: number;
        macSlots: number;
        phoneSlots: number;
        mac: number[];
        phone: number[];
        width: number;
        height: number;
      }>(`(() => {
        const heights = (where) => [...new Set([...document.querySelectorAll('[data-turn-slot="' + where + '"]')].map((node) => Math.round(node.getBoundingClientRect().height * 100) / 100))];
        const main = document.querySelector('[data-view="grid"]').getBoundingClientRect();
        return { states: document.querySelectorAll('[data-state]').length, macSlots: document.querySelectorAll('[data-turn-slot="mac"]').length, phoneSlots: document.querySelectorAll('[data-turn-slot="phone"]').length, mac: heights("mac"), phone: heights("phone"), width: Math.ceil(main.width), height: Math.ceil(main.height) };
      })()`);
      await page.screenshot(join(ASSETS, `states-${part}-${look}.png`), {
        x: 0,
        y: 0,
        width: sizes.width,
        height: sizes.height,
      });
      checks.push({
        skin: look,
        part,
        states: sizes.states,
        macSlots: sizes.macSlots,
        phoneSlots: sizes.phoneSlots,
        mac: sizes.mac,
        phone: sizes.phone,
      });
      console.log(
        `states-${part}-${look}.png  ${sizes.states} states  ${sizes.macSlots} mac slots of ${sizes.mac.join("/")} px  ${sizes.phoneSlots} phone slots of ${sizes.phone.join("/")} pt`,
      );
    }
  }
  return checks;
}

async function turnRegion(page: Page, fromRow: string): Promise<Clip> {
  const region = await page.evaluate<Clip | null>(`(() => {
    const column = document.querySelector('.wl-column, .wl-phone-column');
    const from = document.querySelector('[data-row="${fromRow}"]');
    const block = document.querySelector('[data-turn-block]');
    const scroller = document.querySelector('[data-scroller]');
    if (!column || !from || !block || !scroller) return null;
    const box = column.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const top = Math.max(view.top, from.getBoundingClientRect().top - 16);
    const bottom = Math.min(view.bottom, block.getBoundingClientRect().bottom + 16);
    return { x: box.left + scrollX, y: top + scrollY, width: box.width, height: bottom - top };
  })()`);
  if (!region) throw new Error(`could not find the turn below ${fromRow}`);
  return region;
}

async function sheet(
  page: Page,
  url: string,
  out: string,
  files: string[],
  labels: string[],
  options: { cols: number; width: number; title: string; note: string },
): Promise<void> {
  const query = new URLSearchParams({
    view: "sheet",
    skin: "daylight",
    base: WORK_URL,
    files: files.join(","),
    labels: labels.join("|"),
    cols: String(options.cols),
    title: options.title,
    note: options.note,
  });
  await page.viewport(options.width, 900, 2);
  await page.goto(`${url}?${query}`, READY);
  await settle(page);
  await page.screenshot(join(ASSETS, out), await page.clip('[data-view="sheet"]'));
  console.log(out);
}

function quantize(): void {
  const magick = spawnSync("convert", ["-version"], { stdio: "ignore" });
  if (magick.status !== 0) return;
  for (const file of readdirSync(ASSETS).filter((name) => name.endsWith(".png"))) {
    spawnSync(
      "convert",
      [join(ASSETS, file), "+dither", "-colors", "256", `PNG8:${join(ASSETS, file)}`],
      { stdio: "inherit" },
    );
  }
}

function gif(out: string, frames: string[], delays: number[]): boolean {
  const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (ffmpeg.status !== 0) return false;
  const work = mkdtempSync(join(tmpdir(), "wait-and-landing-gif-"));
  try {
    const list = frames
      .map((file, index) => `file '${file}'\nduration ${(delays[index]! / 1000).toFixed(3)}`)
      .join("\n");
    writeFileSync(join(work, "list.txt"), `${list}\nfile '${frames.at(-1)!}'\n`);
    const filter =
      "scale=iw/2:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4";
    const result = spawnSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        join(work, "list.txt"),
        "-filter_complex",
        filter,
        "-loop",
        "0",
        join(ASSETS, out),
      ],
      { stdio: "inherit" },
    );
    return result.status === 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface LandingCheck {
  platform: string;
  case: string;
  reduced: boolean;
  rowsChecked: number;
  maxRowShift: number;
  scrollTopShift: number;
  contentGrowth: number;
  slotHeight: number | null;
  answerTopMinusSlotTop: number | null;
}

async function landingShots(page: Page, url: string): Promise<LandingCheck[]> {
  const checks: LandingCheck[] = [];
  for (const where of ["mac", "phone"] as const) {
    for (const reduced of [false, true]) {
      for (const kind of reduced ? (["fold"] as const) : CASES) {
        await page.viewport(WINDOWS[where].width, WINDOWS[where].height, 2);
        await page.reducedMotion(reduced);
        await page.goto(`${url}?view=landing&platform=${where}&case=${kind}&skin=daylight`, READY);
        await settle(page);
        const window = await page.clip(`[data-window="${where}"]`);
        const tag = `${where}-${kind}${reduced ? "-reduced" : ""}`;
        const wantsFrames = kind === "fold" || kind === "split" || kind === "batch";
        const region = wantsFrames ? await turnRegion(page, "prompt") : window;
        const gifFrames: string[] = [];
        if (!reduced && kind !== "asks-away")
          await page.screenshot(join(WORK, `landing-${tag}-waiting.png`), window);
        const framesDir = join(WORK, "frames");
        mkdirSync(framesDir, { recursive: true });
        const gifTimes = Array.from({ length: 21 }, (_, index) => index * 20);
        const times =
          wantsFrames && !reduced && kind === "fold"
            ? [...new Set([...gifTimes, ...FRAME_TIMES])].sort((a, b) => a - b)
            : FRAME_TIMES;
        if (kind === "asks-away") {
          await page.screenshot(
            join(where === "mac" ? ASSETS : WORK, `landing-${tag}.png`),
            window,
          );
          console.log(`landing-${tag}.png`);
          continue;
        }
        const result = await landNow(
          page,
          async (t) => {
            if (!wantsFrames) return;
            const file = join(framesDir, `landing-${tag}-${String(t).padStart(3, "0")}.png`);
            await page.screenshot(file, region);
            if (t % 20 === 0) gifFrames.push(file);
          },
          times,
        );
        await page.screenshot(join(WORK, `landing-${tag}-landed.png`), window);
        const skip = new Set(kind === "plain" ? ["slot"] : []);
        const shifts = [...result.frames, result.after].map((snapshot) =>
          shift(result.before, snapshot, skip),
        );
        const check: LandingCheck = {
          platform: where,
          case: kind,
          reduced,
          rowsChecked: shifts[0]?.checked ?? 0,
          maxRowShift: Math.max(...shifts.map((value) => value.max)),
          scrollTopShift:
            Math.round((result.after.scrollTop - result.before.scrollTop) * 100) / 100,
          contentGrowth:
            Math.round((result.after.scrollHeight - result.before.scrollHeight) * 100) / 100,
          slotHeight: result.before.slotHeight,
          answerTopMinusSlotTop:
            kind === "plain" &&
            result.after.firstReplyTop !== null &&
            result.before.slotTop !== null
              ? Math.round((result.after.firstReplyTop - result.before.slotTop) * 100) / 100
              : null,
        };
        checks.push(check);
        console.log(
          `landing ${tag}: ${check.rowsChecked} rows, max shift ${check.maxRowShift} px, scroll moved ${check.scrollTopShift} px, content grew ${check.contentGrowth} px`,
        );
        if (wantsFrames && !reduced && kind === "fold") {
          const delays = gifFrames.map((_, index) =>
            index === 0 ? 700 : index === gifFrames.length - 1 ? 1_600 : 20,
          );
          if (gif(`landing-${where}.gif`, gifFrames, delays)) console.log(`landing-${where}.gif`);
        }
      }
    }
  }
  await page.reducedMotion(false);
  for (const where of ["mac", "phone"] as const) {
    const pick = FRAME_TIMES.map(
      (t) => `frames/landing-${where}-fold-${String(t).padStart(3, "0")}.png`,
    );
    await sheet(
      page,
      url,
      `landing-${where}-sheet.png`,
      pick,
      FRAME_TIMES.map((t) => `${t} ms`),
      {
        cols: 4,
        width: where === "mac" ? 2300 : 1700,
        title: `The landing, ${where === "mac" ? "Mac" : "phone mock"}`,
        note: "The working line hands over in place: its words and face leave over 100 ms, the fold line fades in over 200 ms, the reply arrives like any message over 200 ms. Nothing above moves.",
      },
    );
    const reducedPick = FRAME_TIMES.map(
      (t) => `frames/landing-${where}-fold-reduced-${String(t).padStart(3, "0")}.png`,
    );
    if (reducedPick.every((file) => existsSync(join(WORK, file)))) {
      await sheet(
        page,
        url,
        `landing-${where}-reduced-sheet.png`,
        reducedPick,
        FRAME_TIMES.map((t) => `${t} ms`),
        {
          cols: 4,
          width: where === "mac" ? 2300 : 1700,
          title: `The landing with Reduce Motion, ${where === "mac" ? "Mac" : "phone mock"}`,
          note: "Only fades of 150 ms; what leaves goes at once.",
        },
      );
    }
  }
  return checks;
}

export interface BusyCheck {
  at: number;
  words: string;
  slotHeight: number | null;
  promptTop: number | null;
  greetingTop: number | null;
}

export interface BeforeTexts {
  greeting?: string;
  prompt?: string;
  reply?: string;
  fold?: string | null;
  history?: Array<{ user: string; reply: string; fold: string | null }>;
}

async function busyShots(
  page: Page,
  url: string,
  texts: BeforeTexts,
): Promise<{ checks: BusyCheck[]; changes: Array<{ at: number; words: string }> }> {
  const checks: BusyCheck[] = [];
  const query = new URLSearchParams({
    view: "busy",
    platform: "mac",
    skin: "daylight",
    at: "0",
    ...(texts.greeting ? { greeting: texts.greeting } : {}),
    ...(texts.prompt ? { prompt: texts.prompt } : {}),
    ...(texts.reply ? { reply: texts.reply } : {}),
    ...(texts.fold ? { fold: texts.fold } : {}),
    ...(texts.history?.length ? { history: JSON.stringify(texts.history) } : {}),
  });
  await page.viewport(1328, 848, 2);
  await page.goto(`${url}?${query}`, READY);
  await settle(page);
  const window = await page.clip('[data-window="mac"]');
  const changes = visibleChanges(busyTimeline());
  const times = [
    400,
    1_200,
    2_200,
    3_000,
    4_000,
    10_000,
    40_000,
    62_000,
    64_000,
    76_500,
    77_200,
    BUSY_TURN.landsAt + 600,
  ];
  const files: string[] = [];
  const labels: string[] = [];
  mkdirSync(join(WORK, "frames"), { recursive: true });
  for (const at of times) {
    await page.evaluate(`(window.__wl.at(${at}), true)`);
    await settle(page);
    const state = await page.evaluate<{
      words: string;
      slotHeight: number | null;
      promptTop: number | null;
      greetingTop: number | null;
    }>(`(() => {
      const slot = document.querySelector('[data-turn-slot]');
      const top = (id) => { const node = document.querySelector('[data-row="' + id + '"]'); return node ? Math.round(node.getBoundingClientRect().top * 100) / 100 : null; };
      const shown = slot ? slot.querySelector('.wl-fold') ?? slot.querySelector('.wl-line:not([data-leaving]) .wl-text:not([data-old])') : null;
      return { words: shown ? shown.textContent.replace(/\\s+/g, " ").trim() : "", slotHeight: slot ? slot.getBoundingClientRect().height : null, promptTop: top("prompt"), greetingTop: top("greeting") };
    })()`);
    checks.push({ at, ...state });
    const file = `frames/busy-mac-${String(at).padStart(5, "0")}.png`;
    await page.screenshot(join(WORK, file), await turnRegion(page, "prompt"));
    files.push(file);
    labels.push(
      `${(at / 1000).toFixed(1)} s · ${at >= BUSY_TURN.landsAt ? "landed" : state.words || "slot reserved"}`,
    );
  }
  for (const [moment, at] of Object.entries(MOMENTS)) {
    await page.evaluate(`(window.__wl.at(${at}), true)`);
    await settle(page);
    await page.screenshot(join(WORK, `after-${moment}.png`), window);
  }
  await sheet(page, url, "busy-mac-sheet.png", files, labels, {
    cols: 4,
    width: 2300,
    title: "One busy turn, 77 seconds, Mac",
    note: "Read two files, change one, run the tests for a minute and more, write back. The line changes four times; the rows above never move.",
  });
  await page.goto(
    `${url}?${new URLSearchParams({ ...Object.fromEntries(query), at: "3850" })}`,
    READY,
  );
  await settle(page);
  await page.evaluate(
    "(window.__wlBefore = new Set(document.getAnimations()), window.__wl.at(3950), true)",
  );
  await page.frames(2);
  const swapFiles: string[] = [];
  const slotBox = await page.clip("[data-turn-slot]");
  const swapRegion = {
    x: slotBox.x - 8,
    y: slotBox.y - 10,
    width: 420,
    height: slotBox.height + 20,
  };
  for (const t of [0, 50, 100, 150, 200, 300]) {
    await page.evaluate(seekNew(t));
    await page.frames(1);
    const file = `frames/swap-mac-${String(t).padStart(3, "0")}.png`;
    await page.screenshot(join(WORK, file), swapRegion);
    swapFiles.push(file);
  }
  await sheet(
    page,
    url,
    "swap-mac-sheet.png",
    swapFiles,
    [0, 50, 100, 150, 200, 300].map((t) => `${t} ms`),
    {
      cols: 6,
      width: 1900,
      title: "A phrase changing in place",
      note: "The old words fade out over 100 ms, then the new words rise 4 px and fade in over 200 ms. The face changes pose on its own beat. The slot never changes height.",
    },
  );
  return { checks, changes };
}

async function bubblesShots(page: Page, url: string): Promise<void> {
  for (const where of ["mac", "phone"] as const) {
    await page.viewport(where === "mac" ? 2400 : 1000, where === "mac" ? 900 : 1000, 2);
    await page.goto(`${url}?view=bubbles&platform=${where}&skin=daylight`, READY);
    await settle(page);
    await page.screenshot(
      join(ASSETS, `bubbles-${where}.png`),
      await page.clip('[data-view="bubbles"]'),
    );
    console.log(`bubbles-${where}.png`);
  }
}

async function compareShot(page: Page, url: string): Promise<void> {
  const files = ["sent", "working", "minute", "landed"].flatMap((moment) => [
    `before-${moment}.png`,
    `after-${moment}.png`,
  ]);
  if (!files.every((file) => existsSync(join(WORK, file)))) {
    console.log("before-after.png skipped: run scripts/testing/wait-and-landing-before.ts first");
    return;
  }
  await page.viewport(1700, 1000, 2);
  await page.goto(`${url}?view=compare&skin=daylight&base=${encodeURIComponent(WORK_URL)}`, READY);
  await settle(page);
  await page.screenshot(join(ASSETS, "before-after.png"), await page.clip('[data-view="compare"]'));
  console.log("before-after.png");
}

interface BeforeRun {
  texts?: BeforeTexts;
  surfaces?: unknown;
  landing?: unknown;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { only: { type: "string" } } });
  const only = values.only;
  mkdirSync(ASSETS, { recursive: true });
  mkdirSync(join(WORK, "frames"), { recursive: true });
  const before: BeforeRun = existsSync(join(WORK, "before.json"))
    ? (JSON.parse(readFileSync(join(WORK, "before.json"), "utf8")) as BeforeRun)
    : {};
  const browser = await openBrowser(await browserPath());
  let preview: MountedPreview | undefined;
  const results: Record<string, unknown> = {};
  try {
    preview = await mountPreview(NO_SERVER, {
      entry: "/scripts/testing/wait-and-landing-preview.tsx",
      route: "/__wait-and-landing.html",
      title: "The wait and the landing",
      logLevel: "warn",
    });
    const url = preview.previewUrl;
    if (!only || only === "grid") results.grid = await gridShots(browser.page, url);
    if (!only || only === "landing") results.landing = await landingShots(browser.page, url);
    if (!only || only === "busy")
      results.busy = await busyShots(browser.page, url, before.texts ?? {});
    if (!only || only === "bubbles") await bubblesShots(browser.page, url);
    if (!only || only === "compare") await compareShot(browser.page, url);
  } finally {
    await browser.close();
    await preview?.close();
  }
  if (!only && before.landing)
    results.today = { surfaces: before.surfaces, landing: before.landing };
  const out = only ? join(WORK, `checks-${only}.json`) : join(ASSETS, "checks.json");
  writeFileSync(out, `${JSON.stringify(results, null, 2)}\n`);
  if (!only) quantize();
  console.log(out);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
