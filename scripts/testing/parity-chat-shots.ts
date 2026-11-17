import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlLaterDog } from "../control-laterdog.ts";
import { fixtureApi, mountPreview, REPO_ROOT } from "./preview-fixture.ts";

const output = join(REPO_ROOT, ".laterdog-evidence/parity-chat");
mkdirSync(output, { recursive: true });

const done = [
  { name: "Read", input: { file_path: "notes/plan.md" }, ok: true, output: "plan" },
  { name: "Edit", input: { file_path: "notes/plan.md", old_string: "a", new_string: "b" }, ok: true, output: "edited" },
  { name: "Bash", input: { command: "false", description: "Check the build" }, ok: false, output: "exit 1" },
];
const slow = { name: "Bash", input: { command: "sleep 600", description: "Run the tests" }, ok: true };
const phases = [
  { phase: "during", calls: [...done, { ...slow, pending: true }], env: { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: join(output, "never") } },
  { phase: "after", calls: [...done, { ...slow, output: "passed" }], env: {} },
] as const;

const playwright = await import(process.env.LATERDOG_CHAT_PLAYWRIGHT || "playwright");
const chromium = playwright.chromium ?? playwright.default.chromium;
const browser = await chromium.launch({ headless: true, executablePath: process.env.LATERDOG_CHAT_CHROME || undefined });
try {
  for (const { phase, calls, env } of phases) {
    const fixture = await launchVerificationServer({ ...process.env, ...env, FAKE_CLAUDE_TOOL_CALLS: JSON.stringify(calls) });
    const preview = await mountPreview(fixture, { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Isolated later.dog Chat", logLevel: "warn" });
    try {
      await fixtureApi(fixture.info.url)("PATCH", "/api/config", { language: "en" });
      for (const [skin, name] of [["daylight", "Pepper"], ["midnight", "Juniper"]] as const) {
        const created = await runControlLaterDog(["new-bot", "--name", name, "--url", fixture.info.url]) as { bot: { id: string } };
        const context = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2, timezoneId: "America/Los_Angeles" });
        await context.addInitScript((id: string) => localStorage.setItem("laterdog-skin", id), skin);
        const page = await context.newPage();
        page.on("pageerror", (error: Error) => console.log(`pageerror ${error.message}`));
        page.on("console", (message: { type(): string; text(): string }) => { if (message.type() === "error") console.log(`console ${message.text().slice(0, 300)}`); });
        await page.goto(preview.previewUrl);
        await page.waitForSelector("[data-launch-splash='shown']", { state: "detached", timeout: 30_000 }).catch(() => undefined);
        await page.locator(`[data-sidebar-bot-row="${created.bot.id}"]`).click();
        const composer = page.locator(`textarea[aria-label='Message ${name}']`);
        await composer.waitFor();
        await composer.fill(phase === "during" ? "Tidy the plan and run the tests" : "Tidy the plan and run the tests, then tell me");
        await composer.press("Enter");
        const opener = phase === "during" ? page.locator("[data-work-line] button").first() : page.locator("[data-fold-line]").first();
        await opener.waitFor({ timeout: 60_000 });
        await page.mouse.move(1, 1);
        await page.waitForTimeout(600);
        const stats = await page.evaluate(() => ({
          phrase: document.querySelector("[data-work-line-phrase]")?.textContent ?? null,
          fold: document.querySelector("[data-fold-line]")?.textContent ?? null,
          pills: document.querySelectorAll("[data-tool-activity], [data-activity-run]").length,
        }));
        console.log(JSON.stringify({ phase, skin, ...stats }));
        await page.screenshot({ path: join(output, `${phase}-1100-${skin}.png`) });
        if (phase === "during") assert.ok(stats.phrase, "no working line");
        else assert.ok(stats.fold, "no folded line");
        assert.equal(stats.pills, 0, "a tool pill or card rendered");
        await opener.click();
        await page.waitForSelector("[data-work-panel]", { state: "attached" });
        await page.waitForTimeout(400);
        await page.screenshot({ path: join(output, `${phase}-panel-1100-${skin}.png`) });
        await context.close();
      }
    } finally {
      await preview.close();
      await fixture.close();
    }
  }
} finally {
  await browser.close();
}
