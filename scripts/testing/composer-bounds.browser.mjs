import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright-core");
const { mountPreview } = await import(`${process.cwd()}/scripts/testing/preview-fixture.ts`);
const label = process.argv[2] ?? "after";
const out = join(process.env.COMPOSER_EVIDENCE_DIR ?? "/tmp/composer-bounds-evidence", label);
mkdirSync(out, { recursive: true });
const preview = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, {
  entry: "/scripts/testing/composer-bounds-preview.tsx", route: "/__composer-bounds.html", title: "Isolated example composer", logLevel: "error",
});
const browser = await chromium.launch({
  headless: true, executablePath: process.env.CHROME_BINARY,
  args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
});
const measurements = [];
const errors = [];

try {
  for (const theme of ["light", "dark"]) {
    for (const long of [false, true]) {
      for (const [width, zoom] of [[1100, 1], [375, 1], [375, 2]]) {
        const name = `${theme}-${width}-${zoom}x${long ? "-long" : ""}`;
        const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 3, reducedMotion: "reduce" });
        const page = await context.newPage();
        page.on("pageerror", error => errors.push({ name, error: error.message }));
        try {
          await page.goto(`${preview.previewUrl}?theme=${theme}${long ? "&long=1" : ""}`);
          const field = page.locator("textarea");
          const model = page.locator("[data-chat-ai]");
          const send = page.locator("[data-composer-send]");
          await send.waitFor();
          await page.evaluate(scale => {
            document.documentElement.style.zoom = String(scale);
            document.querySelector("main").style.height = `${800 / scale}px`;
          }, zoom);
          await page.evaluate(async () => {
            await document.fonts.ready;
            await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          });
          const geometry = await page.evaluate(() => {
            const bounds = element => {
              const rect = element.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
            };
            const surface = document.querySelector("[data-composer-surface]");
            const controls = [...surface.querySelectorAll("[data-composer-row] button")].filter(element => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            }).map(element => {
              const rect = bounds(element);
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              return { ...rect, label: element.getAttribute("aria-label"), role: element.hasAttribute("data-composer-send") ? "send" : element.hasAttribute("data-chat-ai") ? "model" : "tool", hit: hit?.closest("button") === element };
            });
            return { surface: bounds(surface), controls, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight };
          });
          await page.screenshot({ path: join(out, `${name}.png`) });
          const x = Math.max(0, geometry.surface.x);
          const y = Math.max(0, geometry.surface.y);
          await page.screenshot({
            path: join(out, `${name}-composer-3x.png`),
            clip: { x, y, width: Math.min(width, geometry.surface.right) - x, height: Math.min(800, geometry.surface.bottom) - y },
          });
          const inside = control => control.x >= geometry.surface.x - 1 && control.right <= geometry.surface.right + 1 && control.y >= geometry.surface.y - 1 && control.bottom <= geometry.surface.bottom + 1 && control.x >= -1 && control.right <= width + 1 && control.bottom <= 801 && control.hit;
          const sendBounds = geometry.controls.find(control => control.role === "send");
          const modelBounds = geometry.controls.find(control => control.role === "model");
          const expectedLabel = await page.locator("[data-composer-bounds-preview]").getAttribute("data-model-label");
          const modelLabel = await model.getAttribute("aria-label");
          let modelOpens = false;
          let sendClearsDraft = false;
          if (modelBounds && inside(modelBounds)) {
            await model.click({ timeout: 2000 });
            await page.locator("[data-model-picker-content]").waitFor({ timeout: 2000 });
            modelOpens = await page.locator("[data-model-picker-content]").isVisible();
            await page.keyboard.press("Escape");
            await page.locator("[data-model-picker-content]").waitFor({ state: "hidden", timeout: 2000 });
          }
          if (sendBounds && inside(sendBounds)) {
            await send.click({ timeout: 2000 });
            await field.waitFor();
            sendClearsDraft = await field.inputValue() === "" && await send.count() === 0;
          }
          const checks = {
            noHorizontalOverflow: geometry.scrollWidth <= geometry.clientWidth,
            composerWithinViewport: geometry.surface.x >= -1 && geometry.surface.right <= width + 1 && geometry.surface.y >= -1 && geometry.surface.bottom <= 801,
            allControlsVisibleAndReachable: geometry.controls.length >= 3 && geometry.controls.every(inside),
            controlsDoNotOverlap: geometry.controls.every((control, index) => geometry.controls.slice(index + 1).every(other => Math.min(control.right, other.right) - Math.max(control.x, other.x) <= 1 || Math.min(control.bottom, other.bottom) - Math.max(control.y, other.y) <= 1)),
            sendTargetPreserved: Boolean(sendBounds && sendBounds.width >= 27 * zoom && sendBounds.height >= 27 * zoom),
            fullModelLabelAccessible: Boolean(expectedLabel && modelLabel?.includes(expectedLabel)),
            modelOpens,
            sendClearsDraft,
          };
          measurements.push({ name, renderer: "Chromium on Linux", theme, width, zoom, long, deviceScaleFactor: 3, reducedMotion: "reduce", ...geometry, modelLabel, checks });
        } catch (error) {
          errors.push({ name, error: String(error) });
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser.close();
  await preview.close();
}
writeFileSync(join(out, "measurements.json"), JSON.stringify({ measurements, errors }, null, 2));
console.log(JSON.stringify({ out, errors, cases: measurements.map(({ name, checks }) => ({ name, checks })), failed: measurements.filter(result => Object.values(result.checks).some(passed => !passed)).length }, null, 2));
if (errors.length || measurements.length !== 12 || measurements.some(result => Object.values(result.checks).some(passed => !passed))) process.exitCode = 1;
