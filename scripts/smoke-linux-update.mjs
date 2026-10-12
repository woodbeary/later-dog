import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { app } = require("electron");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.join(root, "release");

const PRETEND_VERSION = "0.0.1";

function fail(message) {
  console.error(`[smoke-linux-update] ${message}`);
  app.exit(1);
}

function sha512(file) {
  try {
    return createHash("sha512").update(readFileSync(file)).digest("base64");
  } catch {
    return null;
  }
}

function onlyAppImage() {
  const matches = readdirSync(releaseDir).filter((name) => name.endsWith(".AppImage"));
  if (matches.length !== 1) throw new Error(`expected one packaged AppImage, found ${matches.length}`);
  return path.join(releaseDir, matches[0]);
}

async function main() {
  const packaged = onlyAppImage();
  const workspace = mkdtempSync(path.join(tmpdir(), "laterdog-update-smoke-"));
  const installDir = path.join(workspace, "opt");
  const applications = path.join(workspace, "applications");
  mkdirSync(installDir);
  mkdirSync(applications);

  const launched = path.join(installDir, "laterdog-0.0.1-x86_64.AppImage");
  copyFileSync(packaged, launched);
  const desktopEntry = path.join(applications, "dog.later.app.desktop");
  writeFileSync(
    desktopEntry,
    `[Desktop Entry]\nName=later.dog\nExec=${launched} %U\nType=Application\n`,
  );

  process.env.XDG_CACHE_HOME = path.join(workspace, "cache");
  process.env.APPIMAGE = launched;
  app.setPath("userData", path.join(workspace, "userdata"));

  const bundle =
    process.argv.find((argument) => argument.startsWith("--updater="))?.slice("--updater=".length) ??
    path.join(root, "release/linux-unpacked/resources/app.asar/electron/vendor/electron-updater.cjs");
  console.log(`[smoke-linux-update] updater under test: ${bundle}`);
  const { AppImageUpdater } = require(bundle);

  const updateConfig = path.join(workspace, "app-update.yml");
  copyFileSync(path.join(root, "release/linux-unpacked/resources/app-update.yml"), updateConfig);

  app.getVersion = () => PRETEND_VERSION;

  const updater = new AppImageUpdater();
  updater.updateConfigPath = updateConfig;
  updater.forceDevUpdateConfig = true;
  updater.autoDownload = false;
  updater.logger = { info: log, warn: log, error: log, debug: () => {} };

  function log(...values) {
    console.log("   ", ...values.map(String));
  }

  console.log("[smoke-linux-update] checking the real release feed…");
  const result = await updater.checkForUpdates();
  if (!result?.updateInfo?.version) throw new Error("the feed returned no update");
  if (result.isUpdateAvailable !== true) {
    throw new Error(
      `the feed's ${result.updateInfo.version} was not treated as an update over ${PRETEND_VERSION}`,
    );
  }
  const offered = result.updateInfo.version;
  console.log(`[smoke-linux-update] feed offers ${offered}`);

  const expected = result.updateInfo.files?.find((file) => file.url.endsWith(".AppImage"));
  if (!expected?.sha512) throw new Error("the feed declares no AppImage checksum");

  console.log("[smoke-linux-update] downloading…");
  await updater.downloadUpdate(result.cancellationToken);

  let relaunched = null;
  app.relaunch = (options) => {
    relaunched = options.execPath;
    return true;
  };
  updater.spawnLog = () => { throw new Error("AppImage relaunch bypassed Electron's exit ordering"); };
  updater.quitAndInstall(true, true);

  const survivors = readdirSync(installDir);
  const desktop = readFileSync(desktopEntry, "utf8");
  const execTarget = desktop.match(/^Exec=(.*?) %U$/m)?.[1];
  console.log(`[smoke-linux-update] files left in the install directory: ${survivors.join(", ")}`);

  const checks = [
    ["the update stayed on the launched path", survivors.includes(path.basename(launched))],
    ["no second AppImage appeared", survivors.length === 1],
    [
      "the launcher still points at a real file",
      execTarget === launched && existsSync(launched),
    ],
    ["the file now holds the published build", sha512(launched) === expected.sha512],
    ["the relaunch uses the launched path", relaunched === launched],
  ];

  let failed = 0;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "✔" : "✖"} ${label}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) {
    console.error(`[smoke-linux-update] ${failed} check(s) failed; workspace kept at ${workspace}`);
    app.exit(1);
    return;
  }

  rmSync(workspace, { recursive: true, force: true });
  console.log(`[smoke-linux-update] OK — updated 0.0.1 → ${offered} in place`);
  app.exit(0);
}

app.whenReady().then(main).catch((error) => fail(error.stack ?? String(error)));
