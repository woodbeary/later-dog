import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlLaterDog } from "../control-laterdog.ts";
import { fixtureApi, mountPreview, REPO_ROOT } from "./preview-fixture.ts";

const phase = process.argv[2];
assert.ok(phase === "before" || phase === "after", "choose before or after");
const capture = process.env.LATERDOG_PANEL_CAPTURE || phase;
assert.match(capture, /^[a-z][a-z0-9-]*$/);
const output = join(REPO_ROOT, ".laterdog-evidence/sidebar-panel", capture);
mkdirSync(output, { recursive: true });
const playwright = await import(process.env.LATERDOG_PANEL_PLAYWRIGHT || "playwright");
const chromium = playwright.chromium ?? playwright.default.chromium;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.LATERDOG_PANEL_CHROME || undefined,
  args: ["--no-first-run", "--no-default-browser-check", "--use-mock-keychain"],
});
const calls = [
  { name: "Read", input: { file_path: "notes/plan.md" }, ok: true, output: "plan" },
  { name: "Edit", input: { file_path: "notes/plan.md", old_string: "a", new_string: "b" }, ok: true, output: "edited" },
];
const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(calls) });
const preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Isolated later.dog Chat", logLevel: "warn" });
const measurements: Array<Record<string, unknown>> = [];
const errors: string[] = [];
const cases = [
  { width: 1100, zoom: 1 }, { width: 1279, zoom: 1 }, { width: 1280, zoom: 1 },
  { width: 1281, zoom: 1 }, { width: 375, zoom: 1 }, { width: 1100, zoom: 2 }, { width: 375, zoom: 2 },
];
const epsilon = 1;
try {
  await fixtureApi(fixture.info.url)("PATCH", "/api/config", { language: "en" });
  const created = await runControlLaterDog(["new-bot", "--name", "Pepper", "--url", fixture.info.url]) as { bot: { id: string } };
  const selectDog = async (page: any) => {
    await page.goto(preview.previewUrl);
    await page.waitForSelector("[data-launch-splash='shown']", { state: "detached", timeout: 30_000 });
    await page.locator(`[data-sidebar-bot-row="${created.bot.id}"]`).waitFor({ state: "attached" });
    await page.locator(`[data-sidebar-bot-row="${created.bot.id}"]`).evaluate((node: HTMLElement) => node.click());
    await page.locator("textarea[aria-label='Message Pepper']").waitFor();
  };
  const seed = await browser.newContext({ viewport: { width: 1100, height: 800 }, reducedMotion: "reduce" });
  try {
    const page = await seed.newPage();
    await selectDog(page);
    await page.locator("textarea[aria-label='Message Pepper']").fill("Tidy the plan and check it");
    await page.locator("textarea[aria-label='Message Pepper']").press("Enter");
    await page.locator("[data-fold-line]").first().waitFor({ timeout: 60_000 });
  } finally {
    await seed.close();
  }
  for (const skin of ["daylight", "midnight"]) {
    for (const { width, zoom } of cases) {
      const viewport = { width: Math.floor(width / zoom), height: Math.floor(800 / zoom) };
      const context = await browser.newContext({
        viewport, deviceScaleFactor: 3 * zoom, reducedMotion: "reduce",
        colorScheme: skin === "midnight" ? "dark" : "light", timezoneId: "America/Los_Angeles",
      });
      await context.addInitScript((id: string) => localStorage.setItem("laterdog-skin", id), skin);
      try {
        const page = await context.newPage();
        page.on("pageerror", (error: Error) => errors.push(error.message));
        await selectDog(page);
        const name = `${skin}-${width}-${zoom}x`;
        const geometry = () => page.evaluate(() => {
          const box = (node: Element | null) => {
            if (!node) return null;
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
          };
          const painted = (node: Element) => {
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.y >= innerHeight) return false;
            for (let parent: Element | null = node; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
            }
            return true;
          };
          const sidebar = document.querySelector("[data-sidebar]");
          const panel = document.querySelector("[data-work-panel]");
          const main = document.querySelector("main");
          const outside = [...document.querySelectorAll("main button, main textarea, [data-work-panel] button")]
            .filter(painted).flatMap(node => {
              const scope = node.closest("[data-work-panel]") || node.closest("main");
              const scopeBox = scope!.getBoundingClientRect();
              const rect = node.getBoundingClientRect();
              if (rect.x >= Math.max(0, scopeBox.x) - 1 && rect.right <= Math.min(innerWidth, scopeBox.right) + 1) return [];
              return [{ label: node.getAttribute("aria-label") || node.textContent?.trim() || node.tagName, scope: scope === panel ? "panel" : "chat", ...box(node) }];
            });
          const clippedText: Array<{ text: string; scope: string }> = [];
          for (const region of document.querySelectorAll("[data-work-panel], [data-chathead], [data-composer-surface]")) {
            if (!painted(region)) continue;
            const bounds = region.getBoundingClientRect();
            const nodes = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
            for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
              if (!node.textContent?.trim() || !node.parentElement || !painted(node.parentElement)) continue;
              const range = document.createRange();
              range.selectNodeContents(node);
              const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.y < innerHeight);
              if (rects.some(rect => rect.x < Math.max(0, bounds.x) - 1 || rect.right > Math.min(innerWidth, bounds.right) + 1)) {
                clippedText.push({ text: node.textContent.trim(), scope: region === panel ? "panel" : "chat" });
              }
            }
          }
          const overlappingSteps = [...document.querySelectorAll("[data-work-panel] .work-panel-step")].filter(painted).flatMap(step => {
            const label = step.querySelector(".work-panel-step-text");
            const time = step.querySelector(".work-panel-time");
            if (!label || !time || !painted(time)) return [];
            const range = document.createRange();
            range.selectNodeContents(label);
            const timeBox = time.getBoundingClientRect();
            return [...range.getClientRects()].some(rect => rect.bottom > timeBox.y && rect.y < timeBox.bottom && rect.right + 4 > timeBox.x) ? [label.textContent?.trim()] : [];
          });
          const splitWords: string[] = [];
          for (const label of document.querySelectorAll("[data-work-panel] .work-panel-step-text")) {
            if (!painted(label)) continue;
            const nodes = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
            for (let node = nodes.nextNode(); node; node = nodes.nextNode()) {
              for (const match of (node.textContent ?? "").matchAll(/\b[A-Za-z]{2,8}\b/g)) {
                const range = document.createRange();
                range.setStart(node, match.index!);
                range.setEnd(node, match.index! + match[0].length);
                const lines = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.y)));
                if (lines.size > 1) splitWords.push(match[0]);
              }
            }
          }
          return {
            viewport: { width: innerWidth, height: innerHeight }, sidebar: box(sidebar), panel: box(panel),
            chat: box(main), documentWidth: document.documentElement.scrollWidth, outside, clippedText, overlappingSteps, splitWords,
            panelControlsBounded: outside.every(node => node.scope !== "panel"),
            visibleChatControls: [...document.querySelectorAll("[data-chathead] button, [data-composer-surface] button, [data-composer-surface] textarea")].filter(painted).length,
            drawerVisible: [...document.querySelectorAll("[data-sidebar-drawer-toggle]")].some(painted),
            active: document.activeElement?.getAttribute("aria-label") || document.activeElement?.tagName,
          };
        });
        const closed = await geometry();
        await page.locator("[data-fold-line]").first().click();
        await page.locator("[data-work-panel]").waitFor();
        await page.waitForTimeout(300);
        const opened = await geometry();
        const expected = viewport.width < 768 ? 0 : viewport.width < 1280 ? 80 : 320;
        const policyMatches = Math.abs(opened.sidebar.width - expected) <= epsilon;
        const fullWindow = viewport.width >= 768 || (Math.abs(opened.panel.width - viewport.width) <= epsilon && opened.chat.width === 0 && opened.visibleChatControls === 0 && !opened.drawerVisible);
        let stepStable = true;
        const step = page.locator("[data-work-panel] button[data-step-id]").first();
        if (await step.count()) {
          await step.click();
          await page.locator("[data-work-panel][data-page='step']").waitFor();
          const detail = await geometry();
          stepStable = Math.abs(detail.sidebar.width - opened.sidebar.width) <= epsilon;
          await page.locator("[data-work-panel] .work-panel-close").click();
          await page.locator("[data-work-panel][data-page='work']").waitFor();
        }
        await page.screenshot({ path: join(output, `${name}-open-3x.png`) });
        await page.screenshot({ path: join(output, `${name}-top-3x.png`), clip: { x: 0, y: 0, width: viewport.width, height: Math.min(250, viewport.height) } });
        await page.locator("[data-work-panel] .work-panel-close").click();
        await page.locator("[data-work-panel]").waitFor({ state: "detached" });
        await page.waitForTimeout(300);
        const reopened = await geometry();
        const closedStable = Math.abs(reopened.sidebar.width - closed.sidebar.width) <= epsilon && Math.abs(reopened.chat.width - closed.chat.width) <= epsilon;
        await page.locator("[data-chathead-pill]").click();
        await page.locator("[role='dialog'][aria-labelledby='bot-settings-title']").waitFor();
        await page.waitForTimeout(300);
        const settings = await geometry();
        const settingsPolicyMatches = Math.abs(settings.sidebar.width - (viewport.width < 1280 ? 80 : 320)) <= epsilon;
        await page.keyboard.press("Escape");
        await page.locator("[role='dialog'][aria-labelledby='bot-settings-title']").waitFor({ state: "detached" });
        const result = { phase, skin, width, zoom, viewport, closed, opened, reopened, settings, policyMatches, closedStable, settingsPolicyMatches, stepStable, fullWindow };
        measurements.push(result);
        console.log(JSON.stringify({ phase, skin, width, zoom, sidebar: opened.sidebar.width, chat: opened.chat.width, panel: opened.panel.width, policyMatches, closedStable, settingsPolicyMatches, outside: opened.outside, clippedText: opened.clippedText, overlappingSteps: opened.overlappingSteps, splitWords: opened.splitWords, fullWindow }));
      } finally {
        await context.close();
      }
    }
  }
  if (phase === "after") {
    const chrome = await mountPreview(fixture, { entry: "/scripts/testing/parity-chrome-preview.tsx", route: "/__chrome.html", title: "Isolated chrome", logLevel: "warn" });
    try {
      for (const skin of ["daylight", "midnight"]) {
        const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 3, reducedMotion: "reduce" });
        try {
          const page = await context.newPage();
          page.on("pageerror", (error: Error) => errors.push(error.message));
          await page.goto(`${chrome.previewUrl}?view=menus&skin=${skin}`);
          await page.locator("[data-preview='chat-header-menu'] [role='menu']").waitFor();
          await page.screenshot({ path: join(output, `chrome-menus-${skin}-3x.png`) });
        } finally {
          await context.close();
        }
      }
    } finally {
      await chrome.close();
    }
  }
  writeFileSync(join(output, "measurements.json"), JSON.stringify({ phase, source: "isolated real App and fake local engine", zoomMethod: "half CSS viewport and doubled pixel density for 2x", measurements, errors }, null, 2) + "\n");
  assert.deepEqual(errors, []);
  if (phase === "after") {
    assert.ok(measurements.every(result => result.policyMatches && result.closedStable && result.settingsPolicyMatches && result.stepStable && result.fullWindow), "sidebar policy or close/settings behavior differed");
    assert.ok(measurements.every(result => {
      const opened = result.opened as { outside: unknown[]; clippedText: unknown[]; overlappingSteps: unknown[]; splitWords: unknown[] };
      return opened.outside.length === 0 && opened.clippedText.length === 0 && opened.overlappingSteps.length === 0 && opened.splitWords.length === 0;
    }), "panel or chat controls and text left their own bounds, overlapped, or split ordinary words");
  } else {
    assert.ok(measurements.some(result => !result.policyMatches), "baseline did not reproduce the missing sidebar fold");
  }
} finally {
  await preview.close();
  await fixture.close();
  await browser.close();
}
