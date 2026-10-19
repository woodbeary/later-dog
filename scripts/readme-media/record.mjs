import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";

const [siteDir, sceneName, variant, outDir] = process.argv.slice(2);
const require = createRequire(siteDir + "/package.json");
const { chromium } = require("playwright-core");

const STEP = 40;
const DSF = 2;
const MAX_MS = 70000;

const DAYLIGHT_INSIDE = `
.app-ui[data-skin="midnight"] .vg-screen, .app-ui[data-skin="midnight"] .app-screen {
  --ui-app: #fcfcfc; --ui-panel: #f7f7f7; --ui-raised: #e1e1e1; --ui-card: #eeeeee; --ui-inset: #e6e6e6;
  --ui-control: #dedede; --ui-hairline: #d0d0d0; --ui-ink: #0d0d0d; --ui-ink-2: #575757; --ui-ink-3: #5c5c5c;
  --ui-accent: #111111; --ui-success: #1f7a4d; --ui-pill: #fcfcfc; color: var(--ui-ink);
}
.app-ui[data-skin="midnight"] .ph-status, .app-ui[data-skin="midnight"] .ph-title { color: #fcfcfc; }
.app-ui[data-skin="midnight"] .ph-round, .app-ui[data-skin="midnight"] .ph-pill { background: rgb(47 47 47 / 0.9); box-shadow: 0 0 0 0.5px rgb(255 255 255 / 0.08); }
.app-ui[data-skin="midnight"] .ph-presence { border-color: #070707; }
.app-ui[data-skin="midnight"] .vg-switch { background: #3a3a3a; }
.app-ui[data-skin="midnight"] .vg-switch[data-on] { background: #ededed; }
.app-ui[data-skin="midnight"] .vg-switch[data-on]::after { background: #070707; }
.ph-frame { box-shadow: inset 0 0 0 2px #3b3b3b, inset 0 0 0 5px #101010, 0 0 0 1px rgb(255 255 255 / 0.10); }
`;

const THEMES = {
  light: { page: "#ffffff", card: "#f9f8f6", skin: null },
  dark: { page: "#0d1117", card: "#161b22", skin: "midnight" },
};

const BASE_CSS = (theme) => `
html { scroll-behavior: auto !important; }
.site-header { display: none !important; }
html, body, main, section { background: ${theme.page} !important; }
.bg-surface { background: ${theme.card} !important; }
`;

const SCENES = {
  hero: {
    viewport: { width: 1000, height: 900 },
    css: () => "",
    target: "main > section:first-child .app-window",
    scene: "main > section:first-child .scene",
    margin: 24,
  },
  phone: {
    viewport: { width: 1000, height: 900 },
    css: () => `
#iphone .grid { grid-template-columns: 1fr !important; width: 460px; margin: 0 auto; }
#iphone .grid > div:first-child { display: none !important; }
#iphone .grid > div:last-child { padding-top: 36px !important; }
`,
    target: "#iphone .grid",
    scene: "#iphone .scene",
    margin: 24,
  },
  ...Object.fromEntries(
    ["computer", "schedule", "helpers", "memory"].map((name, index) => [
      name,
      {
        viewport: { width: 1000, height: 900 },
        css: () => `
#dogs .grid { grid-template-columns: 1fr !important; justify-items: center; row-gap: 96px !important; }
#dogs article { width: 520px; padding: 18px 28px !important; }
#dogs article h3, #dogs article > p { display: none !important; }
#dogs .vg-slot { margin-top: 0 !important; }
`,
        target: `#dogs article:nth-of-type(${index + 1})`,
        scene: `#dogs article:nth-of-type(${index + 1}) .scene`,
        margin: 24,
      },
    ]),
  ),
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".webp": "image/webp", ".json": "application/json" };

function serve(root) {
  const server = createServer(async (request, response) => {
    let file = join(root, decodeURIComponent(new URL(request.url, "http://site").pathname));
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      file += ".html";
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const config = SCENES[sceneName];
if (!config || !THEMES[variant]) {
  process.stderr.write(`usage: node scripts/readme-media/record.mjs <site dir> <${Object.keys(SCENES).join("|")}> <light|dark> <frames dir>\n`);
  process.exit(1);
}
const theme = THEMES[variant];
const frames = join(outDir, `${sceneName}-${variant}`);
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });

const server = await serve(join(siteDir, "out"));
const origin = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: config.viewport, deviceScaleFactor: DSF, reducedMotion: "no-preference" });
  const page = await context.newPage();
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.goto(origin, { waitUntil: "load" });
  await page.addStyleTag({ content: BASE_CSS(theme) + config.css() + (theme.skin ? DAYLIGHT_INSIDE : "") });
  if (theme.skin) await page.evaluate((skin) => document.querySelectorAll(".app-ui").forEach((el) => el.setAttribute("data-skin", skin)), theme.skin);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((selector) => {
    const element = document.querySelector(selector);
    const box = element.getBoundingClientRect();
    window.scrollTo(0, box.top + scrollY - (innerHeight - box.height) / 2);
  }, config.target);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    document.querySelectorAll("[data-reveal]").forEach((el) => el.setAttribute("data-shown", ""));
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
    }
    window.__born = new WeakMap();
  });
  await page.waitForTimeout(300);
  const box = await page.evaluate((selector) => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, config.target);
  const clip = {
    x: Math.max(0, Math.round(box.x - config.margin)),
    y: Math.max(0, Math.round(box.y - config.margin)),
    width: Math.round(box.width + config.margin * 2),
    height: Math.round(box.height + config.margin * 2),
  };
  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          let left = 3;
          channel.port1.onmessage = () => (--left ? channel.port2.postMessage(0) : resolve());
          channel.port2.postMessage(0);
        }),
    );
  const drive = (now) =>
    page.evaluate((now) => {
      for (const animation of document.getAnimations()) {
        if (!window.__born.has(animation)) window.__born.set(animation, now - Math.max(0, Math.min(animation.currentTime ?? 0, 40)));
        animation.pause();
        const timing = animation.effect?.getComputedTiming();
        const end = timing && Number.isFinite(timing.endTime) ? timing.endTime : Infinity;
        const age = now - window.__born.get(animation);
        animation.currentTime = end === Infinity ? Math.floor(age / 80) * 80 : Math.min(age, end);
      }
    }, now);

  let now = 0;
  let seenReset = false;
  const list = [];
  let previous = null;
  await drive(now);
  await page.waitForTimeout(60);
  while (now < MAX_MS) {
    const phase = await page.getAttribute(config.scene, "data-phase");
    if (phase === "reset") seenReset = true;
    if (seenReset && phase === "play") break;
    const shot = await page.screenshot({ clip, type: "png", animations: "allow", caret: "initial" });
    if (previous && shot.equals(previous)) list[list.length - 1].ms += STEP;
    else {
      const file = join(frames, `f${String(list.length).padStart(5, "0")}.png`);
      writeFileSync(file, shot);
      list.push({ file, ms: STEP });
      previous = shot;
    }
    await page.clock.runFor(STEP);
    now += STEP;
    await settle();
    await drive(now);
    await page.waitForTimeout(45);
  }
  writeFileSync(join(frames, "frames.json"), JSON.stringify({ scene: sceneName, variant, clip, dsf: DSF, total: now, frames: list }, null, 1));
  process.stdout.write(`${sceneName}-${variant}: ${list.length} frames, ${now} ms, clip ${clip.width}x${clip.height}\n`);
} finally {
  await browser.close();
  server.close();
}
