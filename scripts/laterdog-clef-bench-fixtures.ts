import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { CLEF_IMAGE_MAX_BYTES } from "../server/laterdog/clef-images.ts";
import { SCREEN_CASES } from "./testing/clef-bench/cases.ts";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "testing", "clef-bench", "screens");
const CHROME = process.env.LATERDOG_BENCH_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const WIDTH = 1024;
const HEIGHT = 640;

function capture(url: string, file: string, waitMs: number, profile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(CHROME, [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
      `--user-data-dir=${profile}`, `--window-size=${WIDTH},${HEIGHT}`, `--virtual-time-budget=${waitMs}`, `--screenshot=${file}`, url,
    ], { stdio: "ignore" });
    let finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(limit);
      child.kill("SIGKILL");
      if (error) reject(error); else resolve();
    };
    const limit = setTimeout(() => finish(new Error(`timed out capturing ${url}`)), 120_000);
    let seen = -1;
    const poll = setInterval(() => {
      let size = -1;
      try { size = statSync(file).size; } catch { return; }
      if (size > 0 && size === seen) finish();
      seen = size;
    }, 700);
    child.once("error", (error) => finish(error));
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "laterdog-clef-bench-"));
  const sourcesFile = join(HERE, "testing", "clef-bench", "sources.json");
  const only = process.env.LATERDOG_BENCH_ONLY?.split(",").filter(Boolean);
  const sources: Record<string, { source: string; capturedAt: string; bytes: number }> =
    only && existsSync(sourcesFile) ? JSON.parse(readFileSync(sourcesFile, "utf8")) : {};
  try {
    for (const testCase of SCREEN_CASES) {
      if (only && !only.includes(testCase.id)) continue;
      const profile = mkdtempSync(join(work, "profile-"));
      const png = join(work, `${testCase.id}.png`);
      let url: string;
      let waitMs: number;
      if ("url" in testCase.source) {
        url = testCase.source.url;
        waitMs = testCase.source.waitMs ?? 5_000;
      } else {
        const html = join(work, `${testCase.id}.html`);
        writeFileSync(html, testCase.source.html);
        url = `file://${html}`;
        waitMs = 800;
      }
      await capture(url, png, waitMs, profile);
      const jpeg = join(OUT, `${testCase.id}.jpg`);
      let bytes = Infinity;
      for (const quality of [60, 45, 35, 25]) {
        await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), png, "--out", jpeg]);
        bytes = statSync(jpeg).size;
        if (bytes <= CLEF_IMAGE_MAX_BYTES) break;
      }
      if (bytes > CLEF_IMAGE_MAX_BYTES) throw new Error(`${testCase.id} is ${bytes} bytes, over the ${CLEF_IMAGE_MAX_BYTES} cap`);
      sources[testCase.id] = { source: "url" in testCase.source ? testCase.source.url : "generated locally from HTML in cases.ts", capturedAt: new Date().toISOString(), bytes };
      console.log(`${testCase.id}: ${bytes} bytes`);
    }
    writeFileSync(sourcesFile, JSON.stringify(sources, null, 2) + "\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
