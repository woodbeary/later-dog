import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mountPreview, REPO_ROOT } from "./preview-fixture.ts";

const output = join(REPO_ROOT, ".laterdog-evidence/parity-panel");
mkdirSync(output, { recursive: true });
const ui = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, {
  entry: "/scripts/testing/parity-panel-preview.tsx", route: "/__parity-panel.html", title: "Work panel preview", logLevel: "warn",
});
const { chromium } = await import(process.env.LATERDOG_PANEL_PLAYWRIGHT || "playwright");
const browser = await chromium.launch({ headless: true, executablePath: process.env.LATERDOG_PANEL_CHROME || undefined });
try {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2, timezoneId: "America/Los_Angeles" });
  const page = await context.newPage();
  for (const skin of ["daylight", "midnight"]) {
    for (const [name, query] of [["steps", "page=work&hover=s3"], ["side-jobs", "page=side-jobs"], ["step", "page=step"], ["side-job", "page=side-job"]] as const) {
      await page.goto(`${ui.previewUrl}?skin=${skin}&${query}`);
      await page.waitForSelector("[data-work-panel]");
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(output, `${name}-1100-${skin}.png`) });
    }
    await page.goto(`${ui.previewUrl}?skin=${skin}&page=work`);
    await page.waitForSelector("[data-step-id='s3']");
    const row = page.locator("[data-step-id='s3']");
    const timeBefore = await row.locator("[data-step-time]").boundingBox();
    await row.hover();
    await page.waitForTimeout(100);
    const timeAfter = await row.locator("[data-step-time]").boundingBox();
    const chevron = await row.locator("[data-step-chevron]").evaluate(node => getComputedStyle(node).visibility);
    assert.deepEqual(timeAfter, timeBefore, "the time moved on hover");
    assert.equal(chevron, "visible");
    const panel = await page.locator("[data-work-panel]").boundingBox();
    console.log(JSON.stringify({ skin, panelWidth: panel?.width, timeX: timeBefore?.x, chevron, controls: await page.locator("[data-work-panel] button").count() }));
  }
} finally {
  await browser.close();
  await ui.close();
}
