import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { mountPreview, REPO_ROOT } from "./preview-fixture.ts";

const SCENES = ["idle", "draft", "working", "working-draft", "usage-weekly-75", "usage-weekly-90", "usage-five-hour", "question", "permission", "settled"];
const OUT = join(REPO_ROOT, ".laterdog-evidence", "parity-composer");
mkdirSync(OUT, { recursive: true });

const ui = await mountPreview({ info: { url: "http://127.0.0.1:9" } }, {
  entry: "/scripts/testing/parity-composer-preview.tsx",
  route: "/__parity-composer.html",
  title: "Composer parity preview",
  logLevel: "warn",
});
const { chromium } = await import(process.env.LATERDOG_DESKTOP_VERIFY_PLAYWRIGHT || "playwright");
const browser = await chromium.launch({ headless: true, executablePath: process.env.LATERDOG_DESKTOP_VERIFY_BROWSER_CHROME || undefined });
const errors: string[] = [];
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on("pageerror", (error: Error) => errors.push(`${theme}: ${error.message}`));
    const shoot = async (scene: string, file = scene, after?: () => Promise<void>) => {
      await page.goto(`${ui.previewUrl}?scene=${scene}&theme=${theme}`);
      await page.locator("[data-composer-surface]").waitFor();
      await page.waitForTimeout(600);
      if (after) await after();
      await page.screenshot({ path: join(OUT, `${file}-${theme}.png`) });
      console.log(`${file}-${theme}.png`);
    };
    for (const scene of SCENES) await shoot(scene);
    await shoot("question", "question-picked", async () => {
      await page.keyboard.press("1");
      await page.locator("[data-question-check]").waitFor({ timeout: 500 });
    });
    await shoot("permission", "permission-covers", async () => {
      await page.locator("[data-approval-command]").click();
    });
    await context.close();
  }
} finally {
  await browser.close();
  await ui.close();
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
