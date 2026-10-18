import { app, clipboard, ipcMain } from "electron";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
  HAND_OFF_PACKAGE_TYPES,
  linuxPackageType,
  packageInstallCommand,
  stagedInstallFile,
} from "./package-install-command.mjs";
import { startReleaseCheck } from "./release-check.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { updateFeedUrl } from "./update-feed.mjs";
import { clearUpdateReceipt, takeUpdateReceipt, writeUpdateReceipt } from "./update-receipt.mjs";
import { variant } from "./app-variant.mjs";
import { createUpdaterCoordinator } from "./updater-coordinator.mjs";

const require = createRequire(import.meta.url);

let autoUpdater = null;
let win = null;
let state = { status: "idle" };
let updaterCoordinator = null;
let releaseCheck = null;
let pageAllowed = () => false;
let cloudPage = () => false;
let receiptTaken = false;

function updaterLogger() {
  const directory = app.getPath("logs");
  const file = join(directory, "updater.log");
  const write = (level, values) => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const message = values
        .map((value) => (value instanceof Error ? value.stack ?? value.message : String(value)))
        .join(" ");
      appendFileSync(file, `[${new Date().toISOString()}] [${level}] ${message}\n`, { mode: 0o600 });
    } catch {}
  };
  return Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (...values) => write(level, values)]));
}

const HAND_OFF_TYPES = new Set(HAND_OFF_PACKAGE_TYPES);

export function handOffDownloadedPackage(packageType) {
  return async (files) => {
    const target = stagedInstallFile(files);
    const command = packageInstallCommand(packageType, target);
    clipboard.writeText(command);
    return { command, terminalOpened: await openBlankTerminal() };
  };
}

function pageState(event) {
  return { ...state, cloudPage: cloudPage(event) === true };
}

function setState(patch) {
  state = { ...state, ...patch };
  try {
    const contents = win?.webContents;
    const event = { sender: contents, senderFrame: contents?.mainFrame };
    if (contents && pageAllowed(event)) contents.send("update:state", pageState(event));
  } catch {}
}

export function setUpdaterMacInUse(inUse) {
  if (Boolean(state.macInUse) !== Boolean(inUse)) setState({ macInUse: Boolean(inUse) });
}

export function sendUpdaterState() {
  setState({});
}

export function registerUpdaterIpc({ pageAllowed: allowed, cloudPage: showsCloud = () => false }) {
  pageAllowed = allowed;
  cloudPage = showsCloud;
  const guarded = (channel, handler) => (event, ...args) => {
    if (!pageAllowed(event)) throw new Error(`${channel} is only available in this app's window`);
    return handler(event, ...args);
  };
  ipcMain.handle("update:get-state", guarded("update:get-state", (event) => pageState(event)));
  ipcMain.handle("update:check", guarded("update:check", () => updaterCoordinator?.check(true) ?? releaseCheck?.check(true)));
  ipcMain.handle("update:install", guarded("update:install", (_event, version) => updaterCoordinator?.install(typeof version === "string" ? version : undefined)));
}

export function setReleaseCheckEnabled(enabled) {
  return releaseCheck ? releaseCheck.setEnabled(enabled === true) : false;
}

export function attachUpdaterWindow(mainWindow) {
  win = mainWindow;
}

function packagedUpdateFeed() {
  let packageJson = null;
  try {
    packageJson = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
  } catch {
    packageJson = null;
  }
  return updateFeedUrl({ env: process.env, packageJson });
}

function updateReceipt() {
  const userData = app.getPath("userData");
  return {
    write: (target) => writeUpdateReceipt(userData, { from: app.getVersion(), target }),
    clear: () => clearUpdateReceipt(userData),
  };
}

function showUpdateReceipt() {
  if (receiptTaken) return;
  receiptTaken = true;
  const outcome = takeUpdateReceipt(app.getPath("userData"), { currentVersion: app.getVersion() });
  if (outcome) setState({ receipt: outcome });
}

export function startUpdater() {
  const feed = app.isPackaged ? packagedUpdateFeed() : null;
  if (!feed) {
    updaterCoordinator = null;
    setState({ status: "idle" });
    if (app.isPackaged && !releaseCheck && variant.updates.releaseCheck) {
      const logger = updaterLogger();
      releaseCheck = startReleaseCheck({ userData: app.getPath("userData"), currentVersion: app.getVersion(), setState, log: (line) => logger.info(line) });
    }
    return;
  }
  try {
    ({ autoUpdater } = require("./vendor/electron-updater.cjs"));
  } catch {
    updaterCoordinator = null;
    setState({ status: "error", message: "updater unavailable" });
    return;
  }
  autoUpdater.autoDownload = false;
  autoUpdater.disableDifferentialDownload = true;
  if (feed.error) {
    setState({ status: "error", message: feed.error });
    return;
  }
  autoUpdater.setFeedURL({ provider: "generic", url: feed.url, ...(variant.updates.channel ? { channel: variant.updates.channel } : {}) });
  autoUpdater.logger = updaterLogger();

  const packageType = linuxPackageType({ readMarker: (file) => (existsSync(file) ? readFileSync(file, "utf8") : null) });
  const handOff = HAND_OFF_TYPES.has(packageType);
  autoUpdater.autoInstallOnAppQuit = false;
  setState({ installMode: handOff ? "handoff" : "restart" });
  showUpdateReceipt();
  updaterCoordinator = createUpdaterCoordinator(autoUpdater, setState, {
    handOffInstall: handOff ? handOffDownloadedPackage(packageType) : null,
    nativeStaging: process.platform === "darwin",
    receipt: handOff ? null : updateReceipt(),
  });

  setTimeout(() => void updaterCoordinator?.check(), 15_000).unref?.();
  setInterval(() => void updaterCoordinator?.check(), 60 * 60 * 1000).unref?.();
}
