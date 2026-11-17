import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchVerificationServer } from "../control-laterdog.ts";
import { ensureUiBrowser } from "./control-laterdog-ui.ts";
import { mountPreview, REPO_ROOT, type MountedPreview } from "./preview-fixture.ts";

const OUT = join(REPO_ROOT, ".laterdog-evidence", "parity-chrome");
const SIZES = [[1100, 800], [1440, 900]] as const;
const PROFILE = mkdtempSync(join(tmpdir(), "parity-chrome-"));
const SKINS = [["daylight", "light"], ["midnight", "dark"]] as const;

function shoot(chrome: string, url: string, file: string, width: number, height: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      "--headless=new", "--no-sandbox", "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      `--user-data-dir=${PROFILE}`, `--window-size=${width},${height}`, "--force-device-scale-factor=2",
      "--virtual-time-budget=6000", `--screenshot=${file}`, url,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`chrome exited ${code}: ${errors.slice(-400)}`)));
  });
}

mkdirSync(OUT, { recursive: true });
const { chrome } = await ensureUiBrowser(process.env, (line) => console.error(line));
if (!chrome) throw new Error("the pinned headless browser is not installed");
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/parity-chrome-preview.tsx", route: "/__parity-chrome.html", title: "Sidebar and menus, invented dogs", logLevel: "warn",
  });
  for (const [width, height] of SIZES) {
    for (const [skin, look] of SKINS) {
      const file = join(OUT, `sidebar-${width}-${look}.png`);
      await shoot(chrome, `${ui.previewUrl}?skin=${skin}`, file, width, height);
      console.log(file);
    }
  }
} finally {
  await ui?.close();
  await fixture.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
