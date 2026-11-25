import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ensureUiBrowser } from "./control-laterdog-ui.ts";
import { mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";
import { openBrowser, type Page } from "./wait-and-landing-cdp.ts";

export const ASSETS = join(REPO_ROOT, "docs", "verification", "assets", "wait-and-landing");
const NO_SERVER = { info: { url: "http://127.0.0.1:9" } };
const SKINS = [["daylight", "light"], ["midnight", "dark"]] as const;

export async function browserPath(): Promise<string> {
  const explicit = process.env.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit) return explicit;
  const { chrome } = await ensureUiBrowser(process.env, (line) => console.error(line));
  if (!chrome) throw new Error("no headless browser; set AGENT_BROWSER_EXECUTABLE_PATH to a Chrome or Chromium");
  return chrome;
}

const READY = "window.__wl && window.__wl.ready === true";

async function settle(page: Page): Promise<void> {
  await page.frames(2);
  await page.evaluate("Promise.all(document.getAnimations().filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity).map((a) => { a.finish(); return a.finished; })).then(() => true)");
  await page.frames(1);
}

export interface GridCheck { skin: string; part: string; states: number; mac: number[]; phone: number[] }

async function gridShots(page: Page, url: string): Promise<GridCheck[]> {
  const checks: GridCheck[] = [];
  await page.viewport(1530, 1000, 2);
  for (const [skin, look] of SKINS) {
    for (const part of ["1", "2"]) {
      await page.goto(`${url}?view=grid&skin=${skin}&part=${part}`, READY);
      await settle(page);
      const sizes = await page.evaluate<{ states: number; mac: number[]; phone: number[]; width: number; height: number }>(`(() => {
        const heights = (where) => [...new Set([...document.querySelectorAll('[data-turn-slot="' + where + '"]')].map((node) => Math.round(node.getBoundingClientRect().height * 100) / 100))];
        const main = document.querySelector('[data-view="grid"]').getBoundingClientRect();
        return { states: document.querySelectorAll('[data-state]').length, mac: heights("mac"), phone: heights("phone"), width: Math.ceil(main.width), height: Math.ceil(main.height) };
      })()`);
      await page.screenshot(join(ASSETS, `states-${part}-${look}.png`), { x: 0, y: 0, width: sizes.width, height: sizes.height });
      checks.push({ skin: look, part, states: sizes.states, mac: sizes.mac, phone: sizes.phone });
      console.log(`states-${part}-${look}.png  ${sizes.states} states  mac slot ${sizes.mac.join("/")} px  phone slot ${sizes.phone.join("/")} pt`);
    }
  }
  return checks;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { only: { type: "string" } } });
  mkdirSync(ASSETS, { recursive: true });
  const browser = await openBrowser(await browserPath());
  let preview: MountedPreview | undefined;
  const results: Record<string, unknown> = {};
  try {
    preview = await mountPreview(NO_SERVER, { entry: "/scripts/testing/wait-and-landing-preview.tsx", route: "/__wait-and-landing.html", title: "The wait and the landing", logLevel: "warn" });
    const url = preview.previewUrl;
    if (!values.only || values.only === "grid") results.grid = await gridShots(browser.page, url);
  } finally {
    await browser.close();
    await preview?.close();
  }
  writeFileSync(join(ASSETS, `checks${values.only ? `-${values.only}` : ""}.json`), `${JSON.stringify(results, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
