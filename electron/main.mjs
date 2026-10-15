import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, Tray, WebContentsView, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, powerMonitor, powerSaveBlocker, safeStorage, screen, session, shell, systemPreferences, utilityProcess } from "electron";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyVariantEnvironment, dataDirFor, deepLinkPattern, desktopUserDataDirFor, logsDirFor, serverPortRange, tempName, variant } from "./app-variant.mjs";
applyVariantEnvironment(variant);
app.setName(variant.productName);
const desktopUserData = desktopUserDataDirFor(variant, app.getPath("appData"), { packaged: app.isPackaged });
fs.mkdirSync(desktopUserData, { recursive: true, mode: 0o700 });
app.setPath("userData", desktopUserData);
const variantLogsDir = logsDirFor(variant, { home: app.getPath("home"), userData: app.getPath("userData") });
if (variantLogsDir) app.setAppLogsPath(variantLogsDir);
import { startCua, stopCua, registerCuaIpc, setCuaStateListener } from "./cua.mjs";
import { startLaterDogSupervisor } from "./laterdog-supervisor.mjs";
import { removeLocalControlToken, startLocalControlToken } from "./local-control-token.mjs";
import { createAndroidDeviceController } from "./android-device.mjs";
import { finishSpeech, startSpeech, stopSpeech, voiceNoteAudio } from "./speech.mjs";
import { openBlankTerminal } from "./terminal-launch.mjs";
import { pasteMenuItem } from "./paste-menu-item.mjs";
import { attachUpdaterWindow, startUpdater, registerUpdaterIpc, sendUpdaterState, setReleaseCheckEnabled } from "./updater.mjs";
import {
  buildDiagnosticsReport,
  diagnosticsFileName,
  formatDesktopCrashRecord,
  installDesktopCrashListeners,
  readSafeLogTail,
} from "./diagnostics.mjs";
import { migrateWorkspaceCredentials, workspaceCredentialEnv } from "./workspace-credentials.mjs";
import { evictStartupCacheOnce } from "./startup-cache-eviction.mjs";
import { activateExistingWindow, releaseSingleInstanceLock } from "./single-instance.mjs";
import { pollServerIdentity } from "./server-boot-probe.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";
import { createServerLiveness } from "./laterdog-server-liveness.mjs";
import { serverChildLaunch } from "./server-child-launch.mjs";
import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import { createOrganizationEntry, ORGANIZATION_DEEP_LINK, isOrganizationDeepLink, takeOrganizationDeepLink, organizationRestartIntent, withOrganizationRestartIntent, withoutOrganizationRestartIntent } from "./organization-entry.mjs";
import { windowChromeOptions } from "./window-chrome.mjs";
import { createAllWindowsClosedQuit } from "./window-all-closed.mjs";
import { offerMoveToApplications } from "./move-to-applications.mjs";
import { createStartupScreen } from "./startup-screen.mjs";
import { createSystemTray } from "./system-tray.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";
let startupScreen = null;
let desktopTray = null;
import { collisionFreeDownloadPath, defaultSaveName, revealDownloadWhenDone, revealInFolder, withSavableFile } from "./save-file.mjs";
import { desktopViewerPermissionAllowed } from "./desktop-viewer-permissions.mjs";
import { appPermissionHandlers, externalWebUrl } from "./app-permissions.mjs";
import { permissionChecklist, requestPermission } from "./mac-permissions.mjs";
import { cuaStartsAfterGrant } from "./cua-grant.mjs";
import { writeClipboardText } from "./clipboard-write.mjs";
import {
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
} from "./managed-composio.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import {
  desktopCompanionAccess,
  desktopCompanionRendererArguments,
  pairDesktopCompanion,
  startDesktopCompanionRelay,
  withDesktopCompanionAccess,
  withoutDesktopCompanionAccess,
} from "./desktop-companion-client.mjs";
import { isKnownSkin, skinChrome } from "./skin-overlay.cjs";
import { readSecureCredentials } from "./secure-credentials.mjs";
import capabilitiesModule from "./capabilities.cjs";
import environmentsModule from "./environments.cjs";
import localOriginModule from "./local-origin.cjs";
import { buildApplicationMenu } from "./menu.mjs";
import { createComputerSharing, validateSharedFolders } from "./computer-sharing.mjs";
import { primeHomeFolders } from "./shared-computer-access.mjs";
import { acquireDataDirLease } from "./data-dir-lease.mjs";
import { createManagedDesktopClient, createManagedDesktopRelay, createManagedDesktopStore, managedPortalOrigin } from "./managed-desktop.mjs";
import { cloudOrigin, cloudPlanSnapshot, configuredCloudOrigin, createCloudAccountClient, createCloudAccountStore } from "./cloud-account.mjs";
import { CloudSignInError, createCloudSignIn } from "./cloud-sign-in.mjs";
import { createCloudAutoMove } from "./cloud-auto-move.mjs";
import { createMacHold } from "./cloud-hold.mjs";
import { createCloudWindow } from "./cloud-window.mjs";
import { createCloudAiAccounts, createMacKeychain, MAC_ACCOUNT_ROUTES } from "./cloud-ai-accounts.mjs";
import { createCloudOffer, leaveHomeNow } from "./cloud-default-home.mjs";
import { CLOUD_HOME_NAME, cloudHomeConnectUrl, cloudPlanDisk, isCloudHomeEntry, myCloudOrigin, rememberedCloudHome, savedCloudHomeOrigin, withCloudHome } from "./cloud-home.mjs";
import { createCloudEntry } from "./cloud-entry.mjs";
import { CLOUD_MOVE_LOCAL_ROUTES, cloudPageSenderAllowed, createCloudMove, mintOwnerCode, moveBlocked, moveFit, moveRefusal, moveSenderDestination, parseCloudMoveStatus } from "./cloud-move.mjs";
import { createOrgLibrary } from "./org-library.mjs";
import { createCompanyBackups } from "./company-backups.mjs";
import { createCompanyBackupSchedule } from "./company-backup-schedule.mjs";
import { createProfileRunner } from "./laterdog-profiles.mjs";
import { registerProfileIpc } from "./laterdog-profile-ipc.mjs";

const { desktopCapabilities, nativeDesktopActions } = capabilitiesModule;
const nativeActions = nativeDesktopActions(process.platform);
const require = createRequire(import.meta.url);
const { createDisplayMediaGuard, invokeDisplayMediaCallback, selectCaptureSource } = require(
  "./screen-preview.cjs",
);
const { STAGE_PREFIX: APPIMAGE_CUA_STAGE_PREFIX } = require("./cua-linux-bundle.cjs");
const { desktopViewerUrl, sameDesktopViewerOrigin } = require("./desktop-viewer.cjs");
const { attachDesktopViewerPill, desktopViewerPill } = require("./desktop-viewer-pill.cjs");
const { createDesktopWorkspaceManager } = require("./desktop-workspace.cjs");
const { createTrustedApprovalModeCoordinator } = require("./approval-trusted-mode.cjs");
const { DESKTOP_MUTATION_HEADER, desktopServerHeaders } = require("./desktop-server-auth.cjs");
const { MIN_BOUNDS, normalizeUnreadCount, parseWindowState, resolveWindowState } = require("./window-state.cjs");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.ELECTRON_START_URL ?? "http://127.0.0.1:5199";
let SERVER_PORT = variant.ports.server[0];
const APP_ICON = path.join(__dirname, variant.iconPath);
let desktopViewerWindow = null;
let desktopViewerOwner = null;
let desktopViewerContextId = null;
let desktopWorkspaceManager = null;
let desktopWorkspaceOwner = null;
let pendingOrganizationEntry = takeOrganizationDeepLink(process.argv);
const cloudEntry = createCloudEntry({
  reveal: () => { if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows()); },
  open: async () => {
    let delivered = false;
    await workspaceMenuAction(async () => { delivered = await openCloudEntry(); });
    return delivered;
  },
});
cloudEntry.fromLaunch(process.argv);
let pendingPackageInstallUrl = pendingOrganizationEntry ? null : packageUrlFromCommandLine(process.argv);
let organizationEntryReady = false;
let mainWindow = null;
const serverUnavailableWindows = new WeakSet();
let unreadCount = 0;
let unreadOverlayIcon = null;

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowState() {
  try {
    return parseWindowState(fs.readFileSync(windowStateFile(), "utf8"));
  } catch {
    return null;
  }
}

function writeWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const file = windowStateFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      temporary,
      JSON.stringify({ bounds: win.getNormalBounds(), maximized: win.isMaximized() }),
      { mode: 0o600 },
    );
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    slog(`window state save failed: ${error?.message ?? error}`);
  }
}

function installWindowStatePersistence(win) {
  let timer = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    writeWindowState(win);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 250);
    timer.unref?.();
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  const pushMaximized = () => {
    try {
      if (!win.isDestroyed()) win.webContents.send("window:maximized-changed", win.isMaximized());
    } catch {}
  };
  win.on("maximize", pushMaximized);
  win.on("unmaximize", pushMaximized);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("close", flush);
}

function applyUnreadBadge(win = mainWindow) {
  const count = normalizeUnreadCount(unreadCount);
  if (process.platform === "win32") {
    if (!win || win.isDestroyed()) return;
    unreadOverlayIcon ??= nativeImage.createFromPath(APP_ICON).resize({ width: 16, height: 16 });
    win.setOverlayIcon(
      count > 0 && !unreadOverlayIcon.isEmpty() ? unreadOverlayIcon : null,
      count > 0 ? `${count} unread conversation${count === 1 ? "" : "s"}` : "No unread conversations",
    );
    return;
  }
  if (process.platform === "darwin" || process.platform === "linux") app.setBadgeCount(count);
}

if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.setDesktopName(variant.desktopEntry);
}

if (!app.requestSingleInstanceLock()) {
  console.log("[desktop] later.dog is already running — focusing that window");
  process.exit(0);
}

nativeAutoUpdater.on("before-quit-for-update", () => releaseSingleInstanceLock(app));

function deliverPackageInstall(win) {
  if (!pendingPackageInstallUrl || !win || win.isDestroyed()) return;
  if (win.webContents.isLoadingMainFrame()) return;
  let showingLocal = false;
  try {
    showingLocal = new URL(win.webContents.getURL()).origin === localPageOrigin();
  } catch {}
  if (!showingLocal) {
    if (activeEnvironment(environmentsState)) void workspaceMenuAction(() => switchEnvironment(LOCAL_ID));
    return;
  }
  win.webContents.send("package:install", pendingPackageInstallUrl);
  pendingPackageInstallUrl = null;
}

function queuePackageInstall(rawLink) {
  const packageUrl = packageUrlFromDeepLink(rawLink);
  if (!packageUrl) return false;
  pendingPackageInstallUrl = packageUrl;
  if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows());
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
  return true;
}

function focusFromTrialLink(url) {
  if (!deepLinkPattern(variant, ["trial", "plan"]).test(String(url))) return false;
  if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows());
  return true;
}

app.on("open-url", (event, url) => {
  if (!queueOrganizationEntry(url) && !cloudEntry.fromUrl(url) && !queuePackageInstall(url) && !focusFromTrialLink(url)) return;
  event.preventDefault();
});

app.on("second-instance", (_event, commandLine) => {
  if (takeOrganizationDeepLink(commandLine)) {
    queueOrganizationEntry(ORGANIZATION_DEEP_LINK);
    return;
  }
  if (cloudEntry.fromArgs(commandLine)) return;
  const packageUrl = packageUrlFromCommandLine(commandLine);
  if (packageUrl) pendingPackageInstallUrl = packageUrl;
  if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows());
  const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
  deliverPackageInstall(target);
});

let serverProc = null;
let serverReady = !app.isPackaged;
let secureCredentials = {};
let secureCredentialState = null;
let desktopDataDirLease = null;
let profiles = null;
let managedDesktop = null;
let cloudAccount = null;
let cloudSignIn = null;
let cloudAutoMove = null;
let cloudWindow = null;
let macHold = null;
let cloudAiAccounts = null;
let accountsNote = null;
let cloudOffer = null;
let homeFellBack = false;
let cloudAccountStarted = Promise.resolve();
let cloudAccountRestoring = false;
let cloudSignInRestored = false;
function cloudAccountRestored() {
  return Promise.race([cloudAccountStarted, new Promise(resolve => setTimeout(resolve, 5_000).unref?.())]);
}
let orgLibrary = null;
let companyBackupController = null;
let companyBackupState = { busy: false };
let preparedCompanyRestore = null;
let companyBackupSchedule = null;
let companyBackupClientStateRequest = null;
let companyRestoreCommitting = false;
let companyBackupConfigurationRevision = 0;
const managedDesktopRelay = createManagedDesktopRelay();
const utilityServerExits = new WeakMap();
const UTILITY_SERVER_STOP_TIMEOUT_MS = 6_500;
const trustedApprovalMode = createTrustedApprovalModeCoordinator({ randomId: randomUUID });
const desktopMutationToken = randomBytes(32).toString("base64url");
const localControl = startLocalControlToken(app.getPath("userData"), (line) => slog(line));
const serverLiveness = createServerLiveness({ port: () => SERVER_PORT, log: slog });
const serverSupervisor = createServerSupervisor({
  restart: () => startServerOn(SERVER_PORT),
  stop: stopUtilityServer,
  onReady(proc) {
    serverProc = proc;
    serverReady = true;
    serverStartConflictOnly = false;
    slog(`server ready pid=${proc.pid} port=${SERVER_PORT}`);
    serverLiveness.start(proc);
    syncManagedComposioCredentials();
    orgLibrary?.runtimeReady();
    void macHold?.flush();
    if (managedDesktop) void managedDesktop.refresh().catch(() => {});
    routineWake.start();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!serverUnavailableWindows.has(win) || activeEnvironment(environmentsState) || profiles?.activeOrigin()) continue;
      void win.loadURL(`http://127.0.0.1:${SERVER_PORT}`).then(() => {
        serverUnavailableWindows.delete(win);
      }).catch((error) => {
        slog(`recovered server window failed to load: ${error?.message ?? error}`);
      });
    }
  },
  onUnavailable() {
    serverLiveness.stop();
    serverReady = false;
    serverProc = null;
    companyBackupSchedule?.reconcile();
    routineWake.stop();
  },
  onExhausted() {
    slog("server recovery paused after repeated failures; quit and reopen to retry");
    dialog.showErrorBox(
      "The bot server stopped",
      "Automatic recovery could not restart the background server. Quit and reopen later.dog to try again. Interrupted chat turns were not resent.\n\n" +
        `Server log: ${path.join(LOG_DIR, "server.log")}`,
    );
  },
  log: slog,
});

function desktopDataDir() {
  return dataDirFor(variant, { env: process.env, home: app.getPath("home") });
}

async function stopUtilityServer(proc, timeoutMs = UTILITY_SERVER_STOP_TIMEOUT_MS) {
  if (!proc) return true;
  const exited = utilityServerExits.get(proc);
  if (!exited) return false;
  try {
    proc.kill();
  } catch {}
  let timer;
  return Promise.race([
    exited.then(() => true),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}
let desktopRemoteAccess = null;
let desktopCompanionRelay = null;

const CREDENTIALS_FILE = path.join(app.getPath("userData"), "credentials.bin");

let credentialStoreUnavailable = false;
let credentialStoreWasReset = false;
const credentialStoreCapability = () => (credentialStoreUnavailable ? "unavailable" : credentialStoreWasReset ? "reset" : "ok");
let credentialStoreUsesFallback = false;

function credentialFallbackAvailable() {
  return process.platform === "darwin" && typeof safeStorage.isEncryptionAvailable === "function" && safeStorage.isEncryptionAvailable();
}

function decryptCredentialFallback(buffer) {
  if (!credentialFallbackAvailable()) throw new Error("The operating-system credential store is unavailable");
  return safeStorage.decryptString(buffer);
}

function encryptCredentialFallback(value) {
  if (!credentialFallbackAvailable()) throw new Error("The operating-system credential store is unavailable");
  return safeStorage.encryptString(value);
}

async function readCredentialStore() {
  const result = await readSecureCredentials({
    exists: () => fs.existsSync(CREDENTIALS_FILE),
    isAvailable: () => safeStorage.isAsyncEncryptionAvailable(),
    readFile: () => fs.readFileSync(CREDENTIALS_FILE),
    decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
    decryptFallback: process.platform === "darwin" ? decryptCredentialFallback : undefined,
    probe: async () => {
      const sample = randomBytes(16).toString("hex");
      return (await safeStorage.decryptStringAsync(await safeStorage.encryptStringAsync(sample))).result === sample;
    },
    setAside: (name) => fs.renameSync(CREDENTIALS_FILE, path.join(path.dirname(CREDENTIALS_FILE), name)),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  if (result.status !== "unavailable") credentialStoreUsesFallback = result.usedFallback === true;
  return result;
}

async function loadSecureCredentials() {
  const result = await readCredentialStore();
  credentialStoreUnavailable = result.status === "unavailable";
  if (result.status === "reset") {
    credentialStoreWasReset = true;
    slog(`credential store reset: the saved file was written with another key and was set aside as ${result.setAsideAs}`);
  }
  if (credentialStoreUnavailable) {
    slog(`credential store unreadable after retries (${result.error}); saved keys are not loaded this launch`);
  }
  return result.credentials;
}

async function saveSecureCredentials(credentials) {
  if (credentialStoreUnavailable) {
    throw new Error("The operating-system credential store could not be read this launch");
  }
  if (!credentialStoreUsesFallback && !(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The operating-system credential store is unavailable");
  }
  fs.mkdirSync(path.dirname(CREDENTIALS_FILE), { recursive: true });
  const encrypted = credentialStoreUsesFallback
    ? encryptCredentialFallback(JSON.stringify(credentials))
    : await safeStorage.encryptStringAsync(JSON.stringify(credentials));
  const temporary = `${CREDENTIALS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
  fs.renameSync(temporary, CREDENTIALS_FILE);
}

async function secureComposioConfig() {
  const dataDir = desktopDataDir();
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config?.composio || typeof config.composio !== "object") return;
    let changed = false;
    const apiKey = config?.composio?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim().startsWith("ak_")) {
      if (!secureCredentials.composioApiKey) {
        secureCredentials.composioApiKey = apiKey.trim();
        await saveSecureCredentials(secureCredentials);
      }
      config.composio.apiKey = "";
      changed = true;
    } else if (typeof apiKey === "string" && apiKey.trim()) {
      config.composio.apiKey = "";
      changed = true;
    }
    for (const field of ["key", "url"]) {
      if (Object.hasOwn(config.composio, field)) {
        delete config.composio[field];
        changed = true;
      }
    }
    if (!changed) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

async function secureWorkspaceConfig() {
  const dataDir = desktopDataDir();
  const configPath = path.join(dataDir, "config.json");
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const migrated = migrateWorkspaceCredentials(config, secureCredentials);
    if (migrated.credentialsChanged) await saveSecureCredentials(migrated.credentials);
    secureCredentials = migrated.credentials;
    if (!migrated.configChanged) return;
    const temporary = `${configPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(migrated.config, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") slog(`credential migration failed: ${error?.message ?? error}`);
  }
}

function composioBrokerUrl() {
  const configured = process.env.LATERDOG_COMPOSIO_BROKER_URL?.trim();
  return normalizeManagedComposioBrokerUrl(configured || "");
}

function adminPortalOrigin() {
  const configured = (process.env.LATERDOG_ADMIN_ORIGIN ?? "").trim();
  if (!configured) return "";
  try {
    return managedPortalOrigin(configured);
  } catch {
    return "";
  }
}

const LOG_DIR = app.getPath("logs");
const DESKTOP_CRASH_LOG = path.join(LOG_DIR, "desktop-crashes.log");
const DESKTOP_CRASH_LOG_MAX_BYTES = 512 * 1024;
let logStream = null;
let desktopShutdownStarted = false;
import { createRoutineWakeHold, rememberRoutineWake, routineWakeSettings } from "./routine-wake.mjs";

const { isLocalSender: senderIsLocal, isProfileSender, localOnly, localOnlySync, setLocalOrigin, setProfileOrigin } = localOriginModule;

const routineWake = createRoutineWakeHold({
  fetchStatus: () => (serverReady
    ? fetch(`http://127.0.0.1:${SERVER_PORT}/api/routines/wake`, { signal: AbortSignal.timeout(5_000), redirect: "error", credentials: "omit" })
      .then((response) => (response.ok ? response.json() : null))
    : Promise.resolve(null)),
  isOnBattery: () => {
    try {
      return powerMonitor.isOnBatteryPower();
    } catch {
      return false;
    }
  },
  blocker: powerSaveBlocker,
  settings: () => routineWakeSettings(app.getPath("userData")),
  log: (line) => slog(line),
});

function slog(line) {
  try {
    if (!logStream) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      logStream = fs.createWriteStream(path.join(LOG_DIR, "server.log"), { flags: "a" });
    }
    logStream.write(`[${new Date().toISOString()}] ${line}\n`);
  } catch {}
}

function recordDesktopCrash(event) {
  let handle = null;
  try {
    const record = formatDesktopCrashRecord(event);
    if (!record) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });

    const flags =
      fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW);
    let before = null;
    try {
      before = fs.lstatSync(DESKTOP_CRASH_LOG);
      if (!before.isFile() || before.nlink !== 1) return;
      handle = fs.openSync(DESKTOP_CRASH_LOG, flags);
    } catch (error) {
      if (error?.code !== "ENOENT") return;
      try {
        handle = fs.openSync(
          DESKTOP_CRASH_LOG,
          flags | fs.constants.O_CREAT | fs.constants.O_EXCL,
          0o600,
        );
      } catch {
        return;
      }
    }

    const stats = fs.fstatSync(handle);
    if (!stats.isFile() || stats.nlink !== 1) return;
    if (before && (before.dev !== stats.dev || before.ino !== stats.ino)) return;
    if (stats.size >= DESKTOP_CRASH_LOG_MAX_BYTES) fs.ftruncateSync(handle, 0);
    if (process.platform !== "win32") fs.fchmodSync(handle, 0o600);
    fs.writeFileSync(handle, `[${new Date().toISOString()}] ${record}\n`, "utf8");
  } catch {} finally {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {}
    }
  }
}

installDesktopCrashListeners({
  appTarget: app,
  processTarget: process,
  record: recordDesktopCrash,
  isShuttingDown: () => desktopShutdownStarted,
  mainWebContents: () => mainWindow?.webContents ?? null,
});

export async function updateSecureCredentialDocument(derive, afterPersist) {
  if (!secureCredentialState) throw new Error("Secure credentials are not ready");
  try {
    return await secureCredentialState.update(derive, afterPersist);
  } finally {
    secureCredentials = secureCredentialState.read();
  }
}

function installationDisplayName() {
  const hostname = [...os.hostname()]
    .filter((character) => character.codePointAt(0) >= 32 && character.codePointAt(0) !== 127)
    .join("")
    .trim();
  return hostname.slice(0, 80) || "This computer";
}

async function gatherDiagnostics() {
  const serverStatus = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, {
    signal: AbortSignal.timeout(3_000),
  })
    .then((res) => (res.ok ? res.json() : null))
    .catch(() => null);
  const logPath = path.join(LOG_DIR, "server.log");
  const log = readSafeLogTail(logPath);
  const desktopLog = readSafeLogTail(DESKTOP_CRASH_LOG);
  const updaterLog = readSafeLogTail(path.join(LOG_DIR, "updater.log"));
  return buildDiagnosticsReport({
    appInfo: {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      packaged: app.isPackaged,
      uptimeSeconds: Math.round(process.uptime()),
    },
    configSummary: serverStatus ?? {},
    desktopLogTail: desktopLog?.tail ?? "",
    updaterLogTail: updaterLog?.tail ?? "",
    logTail: log?.tail ?? "",
  });
}

let serverStartConflictOnly = false;







function ensureCloudAccount() {
  if (cloudAccount) return cloudAccount;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("later.dog Cloud sign-in requires the local desktop app.");
  if (!configuredCloudOrigin()) throw new Error("later.dog Cloud is not configured in this build (LATERDOG_CLOUD_ORIGIN).");
  cloudAccount = createCloudAccountClient({
    store: createCloudAccountStore({ file: path.join(app.getPath("userData"), "cloud-account.bin"), encryption: {
      available: async () => (await safeStorage.isAsyncEncryptionAvailable()) &&
        (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
      encrypt: value => safeStorage.encryptStringAsync(value), decrypt: value => safeStorage.decryptStringAsync(value),
    } }),
    platform: process.platform, deviceName: os.hostname().slice(0, 100) || "My computer", appVersion: app.getVersion(),
    openBrowser: url => shell.openExternal(url),
    onState: state => {
      rememberCloudHome(state);
      rememberedHome = rememberedCloudHome(rememberedHome, state);
      sendUpdaterState();
      computerSharing?.cloudChanged();
      pushCloudAccountState(state);
      refreshApplicationMenu();
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(currentWindowTitle());
      observeCloudHome(state);
    },
  });
  return cloudAccount;
}

const cloudAccountView = state => (homeFellBack ? { ...state, fellBack: true } : state);
function pushCloudAccountState(state) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`) &&
    !activeEnvironment(environmentsState) && !desktopRemoteAccess) mainWindow.webContents.send("cloud-account:state-changed", cloudAccountView(state));
}

function ensureCloudSignIn() {
  if (cloudSignIn) return cloudSignIn;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("later.dog Cloud sign-in requires the local desktop app.");
  cloudSignIn = createCloudSignIn({ origin: cloudOrigin(), deviceName: os.hostname().slice(0, 100) || "My computer", platform: process.platform, appVersion: app.getVersion() });
  return cloudSignIn;
}

const userDataFile = name => path.join(app.getPath("userData"), name);
function readUserData(name) {
  try { return fs.readFileSync(userDataFile(name), "utf8"); } catch { return null; }
}
function writeUserData(name, contents) {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(userDataFile(name), contents, { mode: 0o600 });
}
function cloudOfferState() {
  cloudOffer ??= createCloudOffer({ read: () => readUserData("cloud-offer.json"), write: contents => writeUserData("cloud-offer.json", contents) });
  return cloudOffer;
}

async function cloudSignInOutcome(work) {
  try { return { ok: true, ...(await work()) }; } catch (error) {
    if (!(error instanceof CloudSignInError)) slog(`cloud sign-in: ${error?.message ?? error}`);
    return { ok: false, code: error instanceof CloudSignInError ? error.code : "unavailable" };
  }
}

function observeCloudHome(state) {
  try {
    if (state.status === "connected") cloudOfferState().signedIn();
    const homeEntry = environmentsState.environments.find(entry => entry.name === CLOUD_HOME_NAME) ?? null;
    if (leaveHomeNow({ state, homeEntry })) { void leaveCloudHome(homeEntry); return; }
    if (state.status === "signed-out") { homeFellBack = false; cloudAutoMove?.stop(); }
    void syncCloudWindow(state);
  } catch (error) {
    slog(`cloud home: ${error?.message ?? error}`);
  }
}

async function leaveCloudHome(entry) {
  homeFellBack = false;
  cloudAutoMove?.stop();
  sharingController().forget(entry);
  const wasActive = environmentsState.activeId === entry.id;
  persistEnvironments(withoutEnvironment(environmentsState, entry.id));
  if (wasActive) navigateMainWindow(activeOrigin());
  try {
    await session.defaultSession.fetch(`${entry.origin}/api/auth/logout`, { method: "POST", credentials: "include", headers: { origin: entry.origin }, signal: AbortSignal.timeout(5_000) });
  } catch (error) { slog(`cloud home: sign-out of the home was not confirmed (${error?.message ?? error})`); }
  try {
    await session.defaultSession.clearStorageData({ origin: entry.origin, storages: ["localstorage", "indexdb", "serviceworkers", "cachestorage"] });
  } catch (error) { slog(`cloud home: storage clear failed (${error?.message ?? error})`); }
}

function ensureManagedDesktop() {
  if (managedDesktop) return managedDesktop;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("Organization sign-in requires the installed desktop app running on this computer.");
  const encryption = {
    available: async () => (await safeStorage.isAsyncEncryptionAvailable()) &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text"),
    encrypt: value => safeStorage.encryptStringAsync(value),
    decrypt: value => safeStorage.decryptStringAsync(value),
  };
  const store = createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-connection.bin"), encryption });
  orgLibrary = createOrgLibrary({
    dataDir: path.join(desktopDataDir(), "org-library"),
    store: createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-library.bin"), encryption }),
    fetchBytes: (route, maxBytes, options) => managedDesktop.fetchLibraryBytes(route, maxBytes, options),
    relay: library => managedDesktopRelay.sendLibrary(serverProc, library),
    appVersion: app.getVersion(),
    log: message => slog(message),
  });
  managedDesktop = createManagedDesktopClient({
    store, platform: process.platform, deviceName: os.hostname().slice(0, 100) || "My computer",
    applyConnection: connection => managedDesktopRelay.send(serverProc, connection),
    applyPolicy: policy => managedDesktopRelay.sendPolicy(serverProc, policy),
    migrateIdentity: identity => managedDesktopRelay.sendIdentity(serverProc, identity),
    library: orgLibrary,
    appVersion: app.getVersion(),
    openBrowser: url => shell.openExternal(url),
    onState: state => {
      if (state.status === "license-expired") companyBackupController?.abort();
      const lost = ["signed-out", "reauth-required"].includes(state.status), withoutStorage = state.status === "connected" && !state.cloudBackups;
      if (lost || withoutStorage) {
        companyBackupConfigurationRevision++;
        companyBackupController?.abort();
        preparedCompanyRestore = null;
        if (withoutStorage) void companyBackupSchedule?.forget().catch(() => {});
        publishCompanyBackupState({ busy: Boolean(companyBackupController) });
      }
      companyBackupSchedule?.reconcile();
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`) &&
          !activeEnvironment(environmentsState) && !desktopRemoteAccess) {
        mainWindow.webContents.send("organization:state-changed", state);
      }
    },
  });
  companyBackupSchedule = createCompanyBackupSchedule({
    store: createManagedDesktopStore({ file: path.join(app.getPath("userData"), "company-backup-schedule.bin"), encryption }),
    scope: companyBackupScope,
    run: async (signal, scope) => {
      if (companyBackupController || preparedCompanyRestore || companyRestoreCommitting || desktopShutdownStarted) throw companyBackupDeferred();
      const proc = serverProc;
      const status = await localBackupStatus(proc);
      if (status.busy || status.pendingRestore) throw companyBackupDeferred();
      const clientState = await collectCompanyBackupClientState(signal, scope, proc);
      signal.throwIfAborted();
      const current = companyBackupScope();
      if (!current || current.key !== scope.key || current.generation !== scope.generation || proc !== serverProc || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
      return runCompanyBackup("backup", { clientState }, { signal, scope });
    },
    onState: schedule => publishCompanyBackupState({ ...companyBackupState, schedule }),
  });
  return managedDesktop;
}

function companyBackupScope() {
  if (desktopShutdownStarted || desktopRemoteAccess || !serverReady || !serverProc || activeEnvironment(environmentsState)) return null;
  const client = managedDesktop, connection = client?.connection(), state = client?.state();
  if (!connection || state?.status !== "connected" || !state.cloudBackups || connection.expiresAt <= Date.now()) return null;
  const dataDir = path.resolve(desktopDataDir());
  return { key: JSON.stringify([connection.portalOrigin, connection.organizationId, connection.email, dataDir]),
    adopts: saved => {
      try {
        const value = JSON.parse(saved);
        return Array.isArray(value) && value.length === 5 && typeof value[3] === "string" && value[0] === connection.portalOrigin &&
          value[1] === connection.organizationId && value[2] === connection.email && value[4] === dataDir;
      } catch { return false; }
    },
    generation: client.backupGeneration() };
}

function companyBackupDeferred() {
  return Object.assign(new Error("Wait for this installation to be available for its daily backup."), { code: "workspace_busy" });
}

function collectCompanyBackupClientState(signal, scope, proc) {
  const win = mainWindow, contents = win?.webContents, frame = contents?.mainFrame;
  if (companyBackupClientStateRequest || !win || win.isDestroyed() || desktopRemoteAccess || activeEnvironment(environmentsState) ||
      !frame?.url.startsWith(`${rendererOrigin()}/`)) return Promise.reject(companyBackupDeferred());
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (error, value) => {
      if (companyBackupClientStateRequest?.requestId !== requestId) return;
      companyBackupClientStateRequest = null;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(companyBackupDeferred());
    const timer = setTimeout(abort, 10_000); timer.unref?.();
    companyBackupClientStateRequest = { requestId, win, contents, frame, url: frame.url, scope, proc, finish };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    try { contents.send("company-backups:collect-client-state", { requestId }); }
    catch { abort(); }
  });
}

function receiveCompanyBackupClientState(event, input) {
  const pending = companyBackupClientStateRequest;
  if (!pending || input?.requestId !== pending.requestId || event.sender !== pending.contents || event.senderFrame !== pending.frame) return;
  const scope = companyBackupScope();
  if (pending.win !== mainWindow || mainWindow.isDestroyed() || pending.url !== pending.frame.url ||
      !workspaceSenderAllowed(event, mainWindow.webContents, environmentsState, rendererOrigin()) ||
      procUnavailable() || !scope || scope.key !== pending.scope.key || scope.generation !== pending.scope.generation) {
    pending.finish(companyBackupDeferred()); return;
  }
  function procUnavailable() { return pending.proc !== serverProc || !serverReady || desktopRemoteAccess || desktopShutdownStarted; }
  const value = input.clientState;
  if (input.unavailable || !value || typeof value !== "object" || Array.isArray(value) ||
      Object.values(value).some(entry => typeof entry !== "string") || Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 ** 2) {
    pending.finish(companyBackupDeferred()); return;
  }
  pending.finish(null, Object.fromEntries(Object.entries(value)));
}

function publishCompanyBackupState(value) {
  companyBackupState = { ...value, ...(companyBackupSchedule ? { schedule: companyBackupSchedule.state() } : {}) };
  if (mainWindow && !mainWindow.isDestroyed() && !activeEnvironment(environmentsState) && !desktopRemoteAccess &&
      mainWindow.webContents.mainFrame.url.startsWith(`${rendererOrigin()}/`)) mainWindow.webContents.send("company-backups:state-changed", companyBackupState);
}

function localBackupRequest(proc, route, init = {}) {
  if (!proc || proc !== serverProc || !serverReady || !/^\/api\/workspace-backup\/(?:status|export|upload|preview|restore|download\/[A-Za-z0-9_-]+)$/.test(route)) {
    throw new Error("This installation changed. Start this backup operation again.");
  }
  return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit",
    headers: { ...Object.fromEntries(new Headers(init.headers)), [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
}

async function localBackupStatus(proc) {
  const response = await localBackupRequest(proc, "/api/workspace-backup/status", { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Local backup status is unavailable. Try again when this installation is ready.");
  const status = await response.json();
  if (proc !== serverProc || typeof status.busy !== "boolean" || typeof status.pendingRestore !== "boolean") throw new Error("This installation changed. Check backup status again.");
  return status;
}

async function runCompanyBackup(kind, input, scheduled = null) {
  if (companyBackupController || companyRestoreCommitting || desktopShutdownStarted || (scheduled && preparedCompanyRestore)) throw companyBackupDeferred();
  const client = ensureManagedDesktop(), connection = client.connection();
  if (!connection || !client.state().cloudBackups) throw new Error("Connect your organization and ask its administrator to enable cloud backups first.");
  const generation = client.backupGeneration();
  if (scheduled) {
    scheduled.signal.throwIfAborted();
    const scope = companyBackupScope();
    if (!scope || scope.key !== scheduled.scope.key || scope.generation !== scheduled.scope.generation) throw companyBackupDeferred();
  }
  const proc = serverProc, controller = new AbortController();
  const cancelScheduled = () => controller.abort();
  scheduled?.signal.addEventListener("abort", cancelScheduled, { once: true });
  const deadline = setTimeout(() => controller.abort(), 2 * 60 * 60_000); deadline.unref?.();
  companyBackupController = controller;
  preparedCompanyRestore = null;
  publishCompanyBackupState({ busy: true, kind });
  const progress = progress => publishCompanyBackupState({ busy: true, kind, progress });
  try {
    const status = await localBackupStatus(proc);
    if (status.pendingRestore) {
      publishCompanyBackupState({ busy: false, pendingRestore: true });
      throw new Error("Restart later.dog to finish the pending restore before starting another backup operation.");
    }
    if (status.busy) throw companyBackupDeferred();
    const transfers = createCompanyBackups({
      tempRoot: path.join(app.getPath("temp"), tempName(variant, "company-backups")),
      localRequest: (route, init) => localBackupRequest(proc, route, init),
      portalRequest: (route, options) => client.requestBackup(route, { ...options, generation }),
      availableBytes: async temporary => {
        const volumes = await Promise.all([fs.promises.statfs(temporary), fs.promises.statfs(desktopDataDir())]);
        return Math.min(...volumes.map(volume => volume.bavail * volume.bsize));
      },
    });
    const result = kind === "backup" ? await transfers.backup({ ...input, appVersion: app.getVersion() }, controller.signal, progress)
      : await transfers.prepareRestore(input, controller.signal, progress);
    controller.signal.throwIfAborted();
    if (proc !== serverProc || client.backupGeneration() !== generation || client.connection()?.deviceId !== connection.deviceId) throw new Error("This installation or its organization connection changed.");
    if (kind === "restore") preparedCompanyRestore = { id: result.id, proc, deviceId: connection.deviceId };
    publishCompanyBackupState({ busy: false, ...(kind === "backup" ? { lastBackupAt: Date.now() } : {}) });
    return result;
  } catch (error) {
    const message = controller.signal.aborted ? "Cloud backup cancelled. This installation has not been replaced."
      : error?.name === "CompanyBackupError" ? error.message : "Cloud backup could not complete. Check your organization connection and available disk space, then try again.";
    publishCompanyBackupState({ busy: false, pendingRestore: companyBackupState.pendingRestore, message });
    throw Object.assign(new Error(message), error?.code === "workspace_busy" ? { code: "workspace_busy" } : {});
  } finally {
    clearTimeout(deadline);
    scheduled?.signal.removeEventListener("abort", cancelScheduled);
    if (companyBackupController === controller) companyBackupController = null;
  }
}

function syncDesktopMutationToken(proc) {
  try {
    proc.postMessage({
      type: "laterdog:desktop-mutation-token",
      token: desktopMutationToken,
      ...(localControl ? { localToolsToken: localControl.token } : {}),
    });
  } catch (error) {
    slog(`desktop mutation capability sync failed: ${error?.message ?? error}`);
  }
}

function installDesktopMutationHeader() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    let ownsTarget = false;
    try {
      const target = new URL(details.url);
      const port = Number(target.port || 80);
      ownsTarget = target.protocol === "http:" && target.hostname === "127.0.0.1" &&
        ((serverReady && port === SERVER_PORT) || profiles?.ownsPort(port) === true);
    } catch {}
    if (!ownsTarget) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        [DESKTOP_MUTATION_HEADER]: desktopMutationToken,
      },
    });
  });
}

async function startServerOn(port) {
  if (desktopShutdownStarted) return { proc: null, abort: true };
  const { entry, compileCacheDir } = serverChildLaunch({
    resourcesPath: process.resourcesPath,
    userData: app.getPath("userData"),
  });
  const childEnv = managedComposioChildEnvironment(composioBrokerUrl(), secureCredentials, {
    ...process.env,
    ...desktopDataDirLease.utilityServerLeaseEnvironment(),
    LATERDOG_HOME: desktopDataDir(),
    LATERDOG_DESKTOP_PARENT: "1",
    LATERDOG_STATIC_DIR: path.join(process.resourcesPath, "ui"),
    LATERDOG_RESOURCES_PATH: process.resourcesPath,
    LATERDOG_SKILLS_DIR: path.join(process.resourcesPath, "skills"),
    LATERDOG_SERVER_PORT: String(port),
    LATERDOG_APP_VERSION: app.getVersion(),
    LATERDOG_USER_DATA: app.getPath("userData"),
    ...(secureCredentials.composioApiKey
      ? { COMPOSIO_API_KEY: secureCredentials.composioApiKey }
      : {}),
    LATERDOG_CREDENTIAL_STORE: credentialStoreUnavailable ? "unavailable" : "ok",
    ...workspaceCredentialEnv(secureCredentials),
  });
  delete childEnv.LATERDOG_BROWSER_CONNECTION;
  delete childEnv.LATERDOG_DESKTOP_PROFILE;
  delete childEnv.LATERDOG_SERVER_COMPILE_CACHE;
  if (compileCacheDir) childEnv.LATERDOG_SERVER_COMPILE_CACHE = compileCacheDir;
  slog(`fork ${entry} port=${port}`);
  const proc = utilityProcess.fork(entry, [], {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let resolveServerExit;
  utilityServerExits.set(proc, new Promise((resolve) => {
    resolveServerExit = resolve;
  }));
  proc.stdout?.on("data", (d) => slog(`[out] ${String(d).trimEnd()}`));
  proc.stderr?.on("data", (d) => slog(`[err] ${String(d).trimEnd()}`));
  proc.on("message", (message) => {
    if (!serverSupervisor.isCurrent(proc)) return;
    try {
      if (trustedApprovalMode.receive(proc, message)) return;
      if (managedDesktopRelay.receive(proc, message)) return;
      if (orgLibrary?.receive(message)) return;
    } catch (error) {
      slog(`desktop private sync rejected: ${error?.message ?? error}`);
    }
  });
  proc.once("spawn", () => {
    slog(`spawned pid=${proc.pid}`);
    if (!serverSupervisor.isCurrent(proc)) return;
    syncDesktopMutationToken(proc);
  });
  let exited = false;
  proc.once("exit", (code) => {
    exited = true;
    trustedApprovalMode.rejectProcess(proc);
    managedDesktopRelay.rejectProcess(proc);
    resolveServerExit();
    slog(`exited code=${code}`);
  });
  serverSupervisor.watch(proc);
  const identity = await pollServerIdentity({
    port,
    pid: () => proc.pid,
    bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS,
    isExited: () => exited || desktopShutdownStarted,
  });
  if (identity.outcome === "ready" && serverSupervisor.isCurrent(proc)) return { proc };
  if (identity.outcome === "exited") {
    slog(`child on port ${port} exited before answering /api/health`);
  } else {
    slog(
      identity.outcome === "foreign-owner"
        ? `port ${port} answered health checks from another process`
        : `child on port ${port} did not answer /api/health within ${SERVER_BOOT_TIMEOUT_MS / 1000}s`,
    );
  }
  const stopped = await stopUtilityServer(proc);
  if (!stopped) {
    slog(`child on port ${port} did not exit after termination; refusing to start a sibling server`);
  }
  return { proc: null, reason: stopped ? identity.outcome : "stuck-child", abort: !stopped };
}

async function startServerPackaged() {
  let everyPortForeignOwned = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const port of variant.ports.server) {
      if (desktopShutdownStarted) return false;
      const started = await startServerOn(port);
      if (started.proc) {
        SERVER_PORT = port;
        if (serverSupervisor.ready(started.proc)) return true;
      }
      if (started.abort) return false;
      if (started.reason !== "foreign-owner") everyPortForeignOwned = false;
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  serverStartConflictOnly = everyPortForeignOwned;
  return false;
}

function syncManagedComposioCredentials() {
  if (!serverProc) return;
  try {
    serverProc.postMessage({
      type: "laterdog:managed-composio",
      access: managedComposioAccess(composioBrokerUrl(), secureCredentials),
      credentialStore: credentialStoreUnavailable ? "unavailable" : "ok",
    });
  } catch (error) {
    slog(`connected-apps credential sync failed: ${error?.message ?? error}`);
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function buildErrorPage({ allPortsOccupied }) {
  const serverLogPath = path.join(LOG_DIR, "server.log");
  const serverLogHref = pathToFileURL(serverLogPath).href;
  const reason = allPortsOccupied
    ? `Every ${variant.productName} port answered health checks from another process — likely a second copy of the app, or another program on ports ${serverPortRange(variant)}. Quit that program, then quit and reopen ${variant.productName}.`
    : "The background server didn't come up in time — this is usually slow startup, not a port conflict. Quit and reopen later.dog.";
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(
      `<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#070707;color:#fcfcfc;font:15px -apple-system,system-ui"><div style="text-align:center;max-width:360px"><div style="font-size:40px">🐭</div><h2 style="font-weight:600;margin:12px 0 6px">Couldn't start the bot server</h2><p style="color:#fcfcfc99;line-height:1.5">${escapeHtml(reason)} If it keeps happening, check <a target="_blank" rel="noopener" href="${serverLogHref}" style="color:#fcfcfc">${escapeHtml(serverLogPath)}</a>.</p></div></body>`,
    )
  );
}

const SERVER_BOOT_TIMEOUT_MS = 60_000;

let cuaReady = Promise.resolve({ mode: "unavailable", reason: "not-started" });
const androidDevice = createAndroidDeviceController({ resourcesPath: process.resourcesPath });
const displayMediaGuard = createDisplayMediaGuard();
let displayMediaRequestCount = 0;

function rendererOrigin() {
  return new URL(app.isPackaged || desktopRemoteAccess ? `http://127.0.0.1:${SERVER_PORT}` : DEV_URL).origin;
}

function respondToDisplayMediaRequest(callback, response) {
  const error = invokeDisplayMediaCallback(callback, response);
  if (error && response.video) {
    console.error("[screen-preview] failed to deliver selected source:", error);
  }
}

function notifyDesktopViewer(open) {
  if (!desktopViewerOwner?.isDestroyed()) {
    desktopViewerOwner.send("desktop-viewer:state", {
      open,
      contextId: desktopViewerContextId,
    });
  }
}

function desktopViewerErrorPage(message, retryUrl) {
  const escape = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  return (
    "data:text/html;charset=utf-8," +
    encodeURIComponent(`<!doctype html><meta name="color-scheme" content="dark"><title>Desktop unavailable</title>
      <body style="margin:0;display:grid;place-items:center;height:100vh;background:#070707;color:#f5f5f5;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
        <main style="max-width:420px;padding:32px;text-align:center"><h2 style="margin:0 0 10px;font-size:18px">Couldn't open the live desktop</h2>
        <p style="margin:0 0 20px;color:#a1a1aa;line-height:1.5">${escape(message)}</p>
        <a href="${escape(retryUrl)}" target="_blank" rel="noreferrer" style="display:inline-block;border-radius:9px;background:#fff;color:#111;padding:9px 14px;text-decoration:none;font-weight:600">Open in browser</a></main>
      </body>`)
  );
}

function openDesktopViewer(owner, rawUrl, rawTitle, contextId, rawPill) {
  if (!owner || owner.isDestroyed()) throw new Error("The later.dog window is unavailable");
  const url = desktopViewerUrl(rawUrl);
  const titleCandidate = Object.prototype.toString.call(rawTitle) === "[object String]" ? rawTitle.trim() : "";
  const title = titleCandidate ? titleCandidate.slice(0, 80) : "Live desktop";

  const nextContextId =
    Object.prototype.toString.call(contextId) === "[object String]" ? contextId.slice(0, 120) : null;

  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) {
    const previous = desktopViewerWindow;
    const previousOwner = desktopViewerOwner;
    const previousContextId = desktopViewerContextId;
    desktopViewerWindow = null;
    previous.close();
    if (previousContextId !== nextContextId && previousOwner && !previousOwner.isDestroyed()) {
      previousOwner.send("desktop-viewer:state", { open: false, contextId: previousContextId });
    }
  }
  desktopViewerOwner = owner.webContents;
  desktopViewerContextId = nextContextId;

  const cover = owner.getBounds();
  const viewer = new BrowserWindow({
    x: cover.x,
    y: cover.y,
    width: Math.max(760, cover.width),
    height: Math.max(520, cover.height),
    minWidth: 760,
    minHeight: 520,
    parent: owner,
    modal: false,
    show: false,
    title,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      partition: "laterdog-desktop-viewer",
    },
  });
  desktopViewerWindow = viewer;
  const viewerOrigin = url.origin;
  const pill = desktopViewerPill(rawPill);
  if (pill) attachDesktopViewerPill({ viewer, pill, createView: (options) => new WebContentsView(options) });

  viewer.webContents.session.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
    desktopViewerPermissionAllowed(permission, requestingOrigin, viewerOrigin),
  );
  viewer.webContents.session.setPermissionRequestHandler((webContents, permission, callback, details) =>
    callback(desktopViewerPermissionAllowed(permission, details?.requestingUrl || webContents.getURL(), viewerOrigin)),
  );

  viewer.once("ready-to-show", () => {
    if (viewer.isDestroyed()) return;
    viewer.show();
    viewer.focus();
    viewer.webContents.focus();
  });
  viewer.on("closed", () => {
    if (desktopViewerWindow !== viewer) return;
    desktopViewerWindow = null;
    notifyDesktopViewer(false);
    desktopViewerOwner = null;
    desktopViewerContextId = null;
  });
  viewer.on("page-title-updated", (event) => {
    event.preventDefault();
    viewer.setTitle(title);
  });
  viewer.webContents.setWindowOpenHandler(({ url: target }) => {
    try {
      const external = desktopViewerUrl(target);
      void shell.openExternal(external.toString());
    } catch {}
    return { action: "deny" };
  });
  viewer.webContents.on("will-navigate", (event, target) => {
    if (sameDesktopViewerOrigin(target, viewerOrigin)) return;
    event.preventDefault();
    try {
      void shell.openExternal(desktopViewerUrl(target).toString());
    } catch {}
  });
  viewer.webContents.on("did-fail-load", (_event, code, description, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 || viewer.isDestroyed() || failedUrl.startsWith("data:")) return;
    void viewer.loadURL(desktopViewerErrorPage(description || "The viewer did not respond.", url.toString()));
  });

  notifyDesktopViewer(true);
  void viewer.loadURL(url.toString()).catch((error) => {
    if (viewer.isDestroyed()) return;
    void viewer.loadURL(desktopViewerErrorPage(error?.message ?? "The viewer did not respond.", url.toString()));
  });
  return true;
}

function ensureDesktopWorkspace(owner) {
  if (!owner || owner.isDestroyed()) throw new Error("The later.dog window is unavailable");
  if (desktopWorkspaceManager) {
    if (desktopWorkspaceOwner !== owner) {
      throw new Error("The two-desktop view belongs to another app window");
    }
    return desktopWorkspaceManager;
  }

  desktopWorkspaceOwner = owner;
  const manager = createDesktopWorkspaceManager({
    owner,
    createView: (options) => new WebContentsView(options),
    partitionPrefix: `laterdog-desktop-workspace-${randomUUID()}`,
    notify: (state) => {
      if (!owner.isDestroyed() && !owner.webContents.isDestroyed()) {
        owner.webContents.send("desktop-workspace:state", state);
      }
    },
  });
  desktopWorkspaceManager = manager;

  owner.webContents.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) manager.closeAll();
  });
  owner.webContents.on("render-process-gone", () => manager.closeAll());
  owner.once("closed", () => {
    manager.closeAll();
    if (desktopWorkspaceManager === manager) {
      desktopWorkspaceManager = null;
      desktopWorkspaceOwner = null;
    }
  });
  return manager;
}

function desktopWorkspaceForEvent(event, create = false) {
  const owner = mainWindow;
  if (!owner || owner.isDestroyed() || event.sender !== owner.webContents) {
    throw new Error("The two-desktop view is available only to the main app window");
  }
  if (desktopWorkspaceManager && desktopWorkspaceOwner !== owner) {
    throw new Error("The two-desktop view belongs to another app window");
  }
  return create ? ensureDesktopWorkspace(owner) : desktopWorkspaceManager;
}


ipcMain.on("screen:preview-intent", localOnlySync("screen:preview-intent", (event) => {
  event.returnValue = displayMediaGuard.begin(event.senderFrame);
}));

ipcMain.on("desktop:unread-count", (event, value) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed()) return;
  unreadCount = normalizeUnreadCount(value);
  applyUnreadBadge(sender);
});

const { LOCAL_ID, activeEnvironment, allowedOrigins, parseEnvironments, parseHostedWorkspaceLink, serializeEnvironments, withActive, withEnvironment, withoutEnvironment, workspaceNavigationAllowed, workspaceSenderAllowed, workspaceSummary, workspaceWindowTitle } = environmentsModule;
let environmentsState = { environments: [], activeId: LOCAL_ID };
let computerSharing;
const sharingPrompts = new Set();

let sharedComputersAllowed = false;

async function refreshSharedComputersAllowed() {
  sharedComputersAllowed = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config`, { signal: AbortSignal.timeout(3_000) })
    .then((res) => (res.ok ? res.json() : null))
    .then((status) => status?.features?.sharedComputers === true)
    .catch(() => false);
  return sharedComputersAllowed;
}

async function requireSharedComputers() {
  if (await refreshSharedComputersAllowed()) return;
  throw new Error("Computer sharing is turned off on this server.");
}

function sharingController() {
  computerSharing ??= createComputerSharing({
    file: path.join(app.getPath("userData"), "computer-sharing.json"),
    protectedPaths: [desktopDataDir(), profilesDataRoot()],
    fetch: (...args) => session.defaultSession.fetch(...args),
    environments: () => environmentsState.environments,
    enabled: refreshSharedComputersAllowed,
    cloud: cloudLendingSnapshot,
    pairCloud: async () => cloudAccount?.homeTarget() ? cloudAccount.pairHome() : null,
    primeAccess: () => app.isPackaged ? primeHomeFolders(os.homedir()) : undefined,
    onChange: summary => lendingIndicator().update({ lending: summary.lending.length > 0, busy: Boolean(summary.busy && summary.lending.includes(summary.busy.env)) }),
    cuaConnection: lendingCua,
    hostControl: async (id, signal) => {
      const lease = async action => {
        const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/desktop/shared-computer-control`, {
          method: "POST",
          headers: desktopServerHeaders({ "content-type": "application/json" }, { packaged: app.isPackaged, token: desktopMutationToken }),
          body: JSON.stringify({ id, action }),
          signal: action === "release" ? AbortSignal.timeout(3000) : AbortSignal.any([signal, AbortSignal.timeout(3000)]),
        });
        if (!response.ok) throw new Error("This computer is in use locally or held by a person. Wait, then observe it again before acting.");
      };
      await lease("acquire");
      return { renew: () => lease("acquire"), release: () => lease("release") };
    },
  });
  return computerSharing;
}

let lastCloudHome = null;
function cloudLendingSnapshot() {
  if (!cloudAccount) return null;
  const state = cloudAccount.state();
  const accountId = state.account?.id ?? null;
  const origin = state.status === "connected" ? (state.machine?.origin ?? null) : null;
  if (origin && accountId) lastCloudHome = { accountId, origin };
  else if (!accountId || lastCloudHome?.accountId !== accountId) lastCloudHome = null;
  return { status: state.status, accountId, origin };
}

function cloudLendingEnvironment() {
  const snapshot = cloudLendingSnapshot();
  const origin = snapshot?.origin ?? (lastCloudHome?.accountId === snapshot?.accountId ? lastCloudHome?.origin : null);
  return origin ? environmentsState.environments.find(entry => entry.origin === origin) ?? null : null;
}

function stopLending() {
  void computerSharing?.setHome(false);
}

async function openLendingSettings() {
  if (!app.isPackaged || desktopRemoteAccess || !serverReady) return;
  if (activeEnvironment(environmentsState)) persistEnvironments(withActive(environmentsState, LOCAL_ID));
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: true });
  if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows());
  if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) win.webContents.send("app:open-settings", "cloud-settings");
  else {
    profiles?.usePersonal();
    await win.loadURL(`${rendererOrigin()}/?desktop-settings=cloud-settings`);
  }
}

let lendingTray = null;
function lendingIndicator() {
  lendingTray ??= createLendingIndicator({
    Tray, Menu, nativeImage, iconPath: APP_ICON,
    device: process.platform === "darwin" ? "Mac" : "computer",
    onStop: stopLending,
    onOpen: () => void openLendingSettings().catch(error => slog(`lending settings: ${error?.message ?? error}`)),
  });
  return lendingTray;
}

async function offerComputerSharing(win) {
  const env = activeEnvironment(environmentsState);
  if (!env || sharingPrompts.has(env.id) || win.isDestroyed()) return;
  if (env.origin === cloudAccount?.homeTarget()?.origin) return;
  if (!(await refreshSharedComputersAllowed()) || win.isDestroyed()) return;
  sharingPrompts.add(env.id);
  try {
    const info = await sharingController().observe(env);
    if (!info || win.isDestroyed() || activeEnvironment(environmentsState)?.id !== env.id || new URL(win.webContents.getURL()).origin !== env.origin) return;
    const choice = await dialog.showMessageBox(win, {
      type: "question", message: `Share this computer with ${env.name}?`,
      detail: "Let this server’s bots use folders and capabilities you choose while this desktop app is running. Nothing is shared unless you enable it. You can change this later in Settings → Servers.",
      buttons: ["Choose access", "Not now"], defaultId: 1, cancelId: 1,
    });
    sharingController().decline(env, info);
    if (choice.response === 0) openWorkspaceSettings(env.id);
  } catch {}
  finally { sharingPrompts.delete(env.id); }
}

function environmentsFile() {
  return path.join(app.getPath("userData"), "environments.json");
}

function readEnvironments() {
  try {
    return parseEnvironments(fs.readFileSync(environmentsFile(), "utf8"));
  } catch {
    return { environments: [], activeId: LOCAL_ID };
  }
}

function writeEnvironments(state) {
  const file = environmentsFile();
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, serializeEnvironments(state), { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
    slog(`environments save failed: ${error?.message ?? error}`);
    throw new Error("Could not save server connections on this computer. Please try again.");
  }
}

function activeOrigin() {
  return activeEnvironment(environmentsState)?.origin ?? localPageOrigin();
}

function profilesDataRoot() {
  return `${desktopDataDir()}-profiles`;
}

function localPageOrigin() {
  return profiles?.activeOrigin() ?? rendererOrigin();
}

function askingProfile(event) {
  return Boolean(profiles) && isProfileSender(event);
}

function profilePageSender(event) {
  return askingProfile(event) && workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, localPageOrigin());
}

function profileSwitcherSender(event) {
  return (senderIsLocal(event) || isProfileSender(event)) &&
    workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, localPageOrigin());
}

function showActive() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  let showing = null;
  try {
    showing = new URL(mainWindow.webContents.getURL()).origin;
  } catch {}
  const target = activeOrigin();
  if (showing === target) return;
  if (target === rendererOrigin() && app.isPackaged && !serverReady) {
    serverUnavailableWindows.add(mainWindow);
    void mainWindow.loadURL(buildErrorPage({ allPortsOccupied: serverStartConflictOnly })).catch(() => {});
    return;
  }
  navigateMainWindow(target);
}

function showPersonalInstead(name, message, reason = "") {
  const personal = profiles?.list().profiles.find((profile) => profile.main)?.name || "Personal";
  profiles?.usePersonal();
  showActive();
  void dialog.showMessageBox({
    type: "warning",
    message,
    detail: `${reason}Showing ${personal} instead. Choose ${name} again from the menu under your name to try again.`,
  });
}

function profilesChanged() {
  if (!profiles) return;
  const state = profiles.list();
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  let showing = null;
  try {
    showing = new URL(contents?.getURL() ?? "").origin;
  } catch {}
  if (contents && showing === localPageOrigin()) contents.send("profiles:changed", state);
  const open = state.profiles.find((profile) => profile.id === state.activeId);
  if (open && !open.main && open.status === "failed" && !activeEnvironment(environmentsState)) {
    showPersonalInstead(open.name, `${open.name} stopped`);
  }
}

function syncProfileMutationToken(proc) {
  try {
    proc.postMessage({ type: "laterdog:desktop-mutation-token", token: desktopMutationToken });
  } catch (error) {
    slog(`profile mutation capability sync failed: ${error?.message ?? error}`);
  }
}

async function applyProfileCredential({ port, patch }) {
  const response = await fetch(`http://127.0.0.1:${port}/api/config?secretStorage=external`, {
    method: "PUT",
    headers: desktopServerHeaders({ "content-type": "application/json" }, { packaged: true, token: desktopMutationToken }),
    body: JSON.stringify(patch),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `Could not save credential (HTTP ${response.status})`);
  return body;
}

async function startProfiles() {
  if (!app.isPackaged || desktopRemoteAccess) return;
  const userData = app.getPath("userData");
  try {
    profiles = createProfileRunner({
      file: path.join(userData, "profiles.json"),
      dataRoot: profilesDataRoot(),
      mainDataDir: desktopDataDir(),
      credentialsRoot: path.join(userData, "profiles"),
      launch: () => serverChildLaunch({ resourcesPath: process.resourcesPath, userData }),
      baseEnvironment: () => ({
        ...process.env,
        LATERDOG_STATIC_DIR: path.join(process.resourcesPath, "ui"),
        LATERDOG_RESOURCES_PATH: process.resourcesPath,
        LATERDOG_SKILLS_DIR: path.join(process.resourcesPath, "skills"),
        LATERDOG_APP_VERSION: app.getVersion(),
        LATERDOG_USER_DATA: userData,
      }),
      fork: (entry, args, options) => utilityProcess.fork(entry, args, options),
      probe: pollServerIdentity,
      acquireLease: (dataDir) => acquireDataDirLease(dataDir),
      supervise: createServerSupervisor,
      secrets: {
        available: () => safeStorage.isAsyncEncryptionAvailable(),
        encrypt: (value) => safeStorage.encryptStringAsync(value),
        decrypt: (buffer) => safeStorage.decryptStringAsync(buffer),
        ...(process.platform === "darwin" ? {
          decryptFallback: decryptCredentialFallback,
          encryptFallback: encryptCredentialFallback,
        } : {}),
      },
      applyCredential: applyProfileCredential,
      trash: (target) => shell.trashItem(target),
      onSpawn: syncProfileMutationToken,
      onMessage: (proc, message) => trustedApprovalMode.receive(proc, message),
      onExit: (proc) => trustedApprovalMode.rejectProcess(proc),
      onChange: profilesChanged,
      bootTimeoutMs: SERVER_BOOT_TIMEOUT_MS,
      stopTimeoutMs: UTILITY_SERVER_STOP_TIMEOUT_MS,
      log: slog,
    });
    await profiles.start();
  } catch (error) {
    slog(`profiles unavailable: ${error?.message ?? error}`);
  }
}


function refreshApplicationMenu() {
  Menu.setApplicationMenu(
    buildApplicationMenu({
      onOpenSettings: () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("app:open-settings");
      },
    }),
  );
}

function currentWindowTitle() {
  const home = cloudAccount?.state().account ? savedCloudHomeOrigin(environmentsState) : null;
  return workspaceWindowTitle(environmentsState, desktopRemoteAccess, home);
}

function persistEnvironments(next) {
  writeEnvironments(next);
  environmentsState = next;
  refreshApplicationMenu();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(currentWindowTitle());
}

async function workspaceMenuAction(action) {
  try { await action(); } catch (error) {
    await dialog.showMessageBox({ type: "error", message: "Could not update servers", detail: error.message });
  }
}

function navigateMainWindow(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void mainWindow.loadURL(url).catch(() => {});
}

let rememberedHome = null;

async function switchEnvironment(id) {
  if (id === environmentsState.activeId || (id !== LOCAL_ID && !environmentsState.environments.some((entry) => entry.id === id))) return;
  const entry = environmentsState.environments.find((candidate) => candidate.id === id);
  if (entry && cloudAccount && isCloudHomeEntry(entry, { homeOrigin: cloudAccount.homeTarget()?.origin, remembered: rememberedHome })) {
    try { await connectCloudHome(); return; } catch (error) {
      slog(`cloud home: could not connect (${error?.message ?? error})`);
      if (!(await cloudHomeSignedIn(entry.origin))) { await openLendingSettings(); return; }
    }
  }
  persistEnvironments(withActive(environmentsState, id));
  navigateMainWindow(activeOrigin());
}

const organizationEntry = createOrganizationEntry({
  readState: () => ({ environments: environmentsState, remoteAccess: desktopRemoteAccess,
    restartIntent: organizationRestartIntent(secureCredentialState?.read() ?? secureCredentials) }),
  confirm: async ({ kind, name, origin }) => {
    const { response } = await dialog.showMessageBox({
      type: "question",
      buttons: [kind === "companion" ? "Disconnect and restart locally" : "Use this computer", "Cancel"],
      defaultId: 1, cancelId: 1,
      message: kind === "companion" ? `Disconnect from ${name} to sign in locally?` : `Leave ${name} and sign in on this computer?`,
      detail: `${origin}\n\nOrganization sign-in connects company models to this computer. ${kind === "companion" ? "This disconnects desktop companion access and restarts the app. You can pair again later." : "The hosted connection stays saved."} No remote bots, conversations or provider accounts are moved or deleted.`,
    });
    return response === 0;
  },
  saveEnvironments: persistEnvironments,
  disconnectAndRemember: async expected => {
    await updateSecureCredentialDocument(credentials => {
      const current = desktopCompanionAccess(credentials);
      if (!current || current.endpoint !== expected.endpoint || current.deviceId !== expected.deviceId || current.token !== expected.token) {
        throw new Error("The companion connection changed. Choose organization sign-in again.");
      }
      return withOrganizationRestartIntent(credentials);
    });
    desktopRemoteAccess = null;
  },
  clearRestartIntent: () => updateSecureCredentialDocument(credentials =>
    organizationRestartIntent(credentials) && !desktopCompanionAccess(credentials)
      ? withoutOrganizationRestartIntent(credentials) : credentials),
  openLocalSettings: async () => {
    if (!app.isPackaged) throw new Error("Organization sign-in requires the installed desktop app.");
    if (!serverReady) throw new Error("This installation is unavailable. Restart the app and try organization sign-in again.");
    if (desktopRemoteAccess || activeEnvironment(environmentsState)) throw new Error("Choose this computer before signing in with your organization.");
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: true });
    if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) {
      win.webContents.send("app:open-settings", "organization");
    } else {
      profiles?.usePersonal();
      await win.loadURL(`${rendererOrigin()}/?desktop-settings=organization`);
    }
  },
  relaunch: relaunchAfterDesktopRemoteChange,
});

function queueOrganizationEntry(link) {
  if (!isOrganizationDeepLink(link)) return false;
  pendingOrganizationEntry = true;
  if (!desktopTray?.show()) activateExistingWindow(BrowserWindow.getAllWindows());
  void deliverOrganizationEntry();
  return true;
}

async function deliverOrganizationEntry() {
  if (!organizationEntryReady || !pendingOrganizationEntry) return false;
  pendingOrganizationEntry = false;
  let delivered = false;
  await workspaceMenuAction(async () => { delivered = await organizationEntry.request(); });
  return delivered;
}

async function openCloudEntry() {
  if (!app.isPackaged) throw new Error("later.dog Cloud requires the installed desktop app.");
  if (desktopRemoteAccess) throw new Error("This app is connected to another computer. Disconnect it to use later.dog Cloud on this computer.");
  if (!serverReady) throw new Error("This installation is unavailable. Restart the app and open My Cloud again.");
  await cloudAccountRestored();
  const active = activeEnvironment(environmentsState);
  const showingCloud = Boolean(active) && active.origin === cloudAccount?.homeTarget()?.origin;
  if (active && !showingCloud) throw new Error("Your current workspace is still open. Return to this computer to manage this Mac's Cloud account.");
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow({ deferNavigation: !showingCloud });
  if (showingCloud) return true;
  if (!win.webContents.isLoadingMainFrame() && senderIsLocal({ sender: win.webContents })) {
    win.webContents.send("app:open-settings", "cloud");
  } else {
    profiles?.usePersonal();
    await win.loadURL(`${rendererOrigin()}/?desktop-settings=cloud`);
  }
  return true;
}

function openWorkspaceSettings(computerId, panel = "computer") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const id = typeof computerId === "string" ? computerId : null, copy = panel === "copy";
  if (senderIsLocal({ sender: mainWindow.webContents })) {
    mainWindow.webContents.send("workspaces:open-settings", id, ...(copy ? ["copy"] : []));
  } else {
    profiles?.usePersonal();
    persistEnvironments(withActive(environmentsState, LOCAL_ID));
    navigateMainWindow(`${rendererOrigin()}/?desktop-settings=workspaces${id ? `&${copy ? "copy-to" : "share-computer"}=${encodeURIComponent(id)}` : ""}`);
  }
}

async function connectHostedWorkspace(input, name) {
  const link = parseHostedWorkspaceLink(input);
  if (!link) {
    throw new Error("Enter an HTTPS server address or a full pairing link. Keep the pairing code after #, not in the URL query.");
  }
  const host = new URL(link.origin).host;
  const { response } = await dialog.showMessageBox({
    type: "question",
    buttons: ["Connect", "Cancel"],
    defaultId: 0,
    cancelId: 1,
    message: `Connect to ${host}?`,
    detail: link.code
      ? "The pairing code in the link is used once, then this app stays signed in to that server."
      : "The link has no pairing code; the server will ask for one.",
  });
  if (response !== 0) return false;
  let next = withEnvironment(environmentsState, { origin: link.origin, name }, () => randomUUID());
  const added = next.environments.find((e) => e.origin === link.origin);
  next = withActive(next, added.id);
  persistEnvironments(next);
  navigateMainWindow(link.url);
  return true;
}

function rememberCloudHome(state) {
  try {
    const next = withCloudHome(environmentsState, state?.status === "connected" ? state.machine : null, () => randomUUID());
    if (next !== environmentsState) persistEnvironments(next);
  } catch (error) {
    slog(`cloud home: could not list the Cloud machine under Servers (${error?.message ?? error})`);
  }
}

async function connectCloudHome(open = null) {
  const client = ensureCloudAccount();
  const target = client.homeTarget();
  if (!target) throw new Error("My Cloud is not ready to connect yet.");
  const grant = (await cloudHomeSignedIn(target.origin)) ? null : await client.pairHome();
  let next = withCloudHome(environmentsState, { status: "ready", origin: target.origin }, () => randomUUID());
  const entry = next.environments.find((candidate) => candidate.origin === target.origin);
  if (!entry) throw new Error("My Cloud could not be added to Servers.");
  next = withActive(next, entry.id);
  persistEnvironments(next);
  navigateMainWindow(cloudHomeConnectUrl({ origin: target.origin, grant }, Date.now(), open));
  homeFellBack = false;
  return client.state();
}

async function cloudHomeSignedIn(origin) {
  try {
    const response = await session.defaultSession.fetch(`${origin}/api/auth/session`, { credentials: "include", signal: AbortSignal.timeout(5_000) });
    return response.ok && (await response.json())?.kind === "session";
  } catch {
    return false;
  }
}

function showContextMenu(win, params) {
  if (!params.isEditable && !params.linkURL && !params.misspelledWord && !params.selectionText) return;
  const menuItems = [];
  if (params.misspelledWord) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
      menuItems.push({
        label: suggestion,
        click: () => win.webContents.replaceMisspelling(suggestion),
      });
    }
    if (menuItems.length) menuItems.push({ type: "separator" });
  }
  if (params.linkURL) {
    menuItems.push(
      { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
      { type: "separator" },
    );
  }
  menuItems.push(
    { label: "Undo", role: "undo", enabled: params.editFlags.canUndo },
    { label: "Redo", role: "redo", enabled: params.editFlags.canRedo },
    { type: "separator" },
    { label: "Cut", role: "cut", enabled: params.editFlags.canCut },
    { label: "Copy", role: "copy", enabled: params.editFlags.canCopy },
    pasteMenuItem(params, clipboard, win.webContents),
    { label: "Paste and Match Style", role: "pasteAndMatchStyle", enabled: params.editFlags.canPaste },
    { type: "separator" },
    { label: "Select All", role: "selectAll", enabled: params.editFlags.canSelectAll },
  );
  Menu.buildFromTemplate(menuItems).popup({ window: win, frame: params.frame });
}

function createWindow({ deferNavigation = false } = {}) {
  const waitsForSkinSync = process.platform === "win32";
  const primary = screen.getPrimaryDisplay();
  const displays = [primary, ...screen.getAllDisplays().filter((display) => display.id !== primary.id)];
  const restored = resolveWindowState(readWindowState(), displays.map((display) => display.workArea));
  const win = new BrowserWindow({
    ...restored.bounds,
    minWidth: MIN_BOUNDS.width,
    minHeight: MIN_BOUNDS.height,
    show: !waitsForSkinSync && !startupScreen,
    icon: APP_ICON,
    backgroundColor: "#070707",
    autoHideMenuBar: process.platform !== "darwin",
    ...windowChromeOptions(process.platform),
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs"),
      additionalArguments: [...desktopCompanionRendererArguments(rendererOrigin(), desktopRemoteAccess),
        ...(app.isPackaged && !desktopRemoteAccess ? ["--laterdog-company-desktop=1"] : []),
        ...(profiles ? ["--laterdog-profiles=1"] : []),
        ...(app.isPackaged && !desktopRemoteAccess && configuredCloudOrigin() ? ["--laterdog-cloud-account=1"] : []),
        ...(adminPortalOrigin() ? [`--laterdog-admin-origin=${adminPortalOrigin()}`] : [])],
    },
  });
  mainWindow = win;
  win.on("show", () => desktopTray?.windowShown(win));
  win.on("close", (event) => {
    if (process.platform === "win32" && !desktopShutdownStarted && desktopTray) {
      event.preventDefault();
      desktopTray.hide(win);
    }
  });
  win.setTitle(currentWindowTitle());
  win.webContents.on("page-title-updated", event => {
    if (!desktopRemoteAccess && !activeEnvironment(environmentsState)) return;
    event.preventDefault();
    win.setTitle(currentWindowTitle());
  });
  attachUpdaterWindow(win);
  if (startupScreen) startupScreen.attach(win, { maximized: restored.maximized });
  else if (waitsForSkinSync) {
    const skinSyncFallback = setTimeout(() => {
      if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 5_000);
    skinSyncFallback.unref?.();
    const clearSkinSyncFallback = () => clearTimeout(skinSyncFallback);
    win.once("show", clearSkinSyncFallback);
    win.once("closed", clearSkinSyncFallback);
  }
  installWindowStatePersistence(win);
  applyUnreadBadge(win);
  if (restored.maximized && !startupScreen) win.maximize();
  win.once("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      void shell.openExternal(externalWebUrl(url)).catch(() => {
        console.warn("The external web link could not be opened");
      });
    } catch {}
    return { action: "deny" };
  });
  const guardNavigation = (event, url) => {
    let origin = null;
    try {
      origin = new URL(url).origin;
    } catch {}
    if (workspaceNavigationAllowed(url, environmentsState, localPageOrigin())) return;
    event.preventDefault();
    slog(`blocked navigation to ${origin ?? "an invalid address"}`);
  };
  win.webContents.on("will-navigate", guardNavigation);
  win.webContents.on("will-redirect", guardNavigation);
  win.webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    let target = null;
    let page = null;
    try {
      target = new URL(details.url).origin;
      page = new URL(win.webContents.getURL()).origin;
    } catch {}
    if (!target || !page || target === page) return;
    if (target === rendererOrigin() || allowedOrigins(environmentsState, rendererOrigin()).has(target) || profiles?.isProfileOrigin(target) === true) {
      details.preventDefault();
      slog(`blocked subframe navigation to ${details.url}`);
    }
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    const remote = activeEnvironment(environmentsState);
    if (!remote) return;
    let origin = null;
    try {
      origin = new URL(validatedURL).origin;
    } catch {}
    if (origin !== remote.origin) return;
    if (cloudAccount?.state().account && remote.origin === savedCloudHomeOrigin(environmentsState)) {
      slog(`cloud home unreachable (${errorDescription}); showing this computer`);
      homeFellBack = true;
      void workspaceMenuAction(() => switchEnvironment(LOCAL_ID));
      return;
    }
    slog(`remote server unreachable (${errorDescription}); back to Local`);
    void dialog.showMessageBox({
      type: "warning",
      message: `${remote.name} is not reachable`,
      detail: `${errorDescription}. Showing the local server instead.`,
    });
    void workspaceMenuAction(() => switchEnvironment(LOCAL_ID));
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || !profiles || activeEnvironment(environmentsState)) return;
    const open = profiles.list().profiles.find((profile) => profile.id === profiles.activeId() && !profile.main);
    let origin = null;
    try {
      origin = new URL(validatedURL).origin;
    } catch {}
    if (!open || origin !== profiles.activeOrigin()) return;
    slog(`profile ${open.id} page did not load (${errorDescription}); back to Personal`);
    showPersonalInstead(open.name, `${open.name} is not reachable`, `${errorDescription}. `);
  });
  win.webContents.on("did-finish-load", () => deliverPackageInstall(win));
  win.webContents.on("did-finish-load", () => void offerComputerSharing(win));

  win.webContents.on("context-menu", (_event, params) => {
    showContextMenu(win, params);
  });

  if (process.env.LATERDOG_SMOKE_TEST === "1") {
    win.webContents.once("did-finish-load", async () => {
      try {
        const result = await win.webContents.executeJavaScript(`
          (async () => {
            if (!window.laterdog?.getCapabilities) throw new Error("desktop preload bridge is unavailable");
            let crashPromise = null;
            if (${JSON.stringify(process.env.LATERDOG_SMOKE_CUA === "1")}) {
              crashPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                  unsubscribe?.();
                  reject(new Error("timed out waiting for CUA crash invalidation"));
                }, 10000);
                const unsubscribe = window.laterdog.onCapabilitiesChanged((next) => {
                  if (next.localComputer.reasonCode !== "daemon-exited") return;
                  clearTimeout(timeout);
                  unsubscribe();
                  resolve(next.localComputer.reasonCode);
                });
              });
            }
            const [initialCapabilities, healthResponse, ownerMutationResponse] = await Promise.all([
              window.laterdog.getCapabilities(),
              fetch("/api/health"),
              fetch("/api/auth/stream-ticket", { method: "POST" }),
            ]);
            if (!healthResponse.ok) {
              throw new Error(\`health request failed: \${healthResponse.status} \${healthResponse.statusText}\`);
            }
            const health = await healthResponse.json();
            if (!ownerMutationResponse.ok) {
              throw new Error(
                \`desktop mutation capability failed: \${ownerMutationResponse.status} \${ownerMutationResponse.statusText}\`,
              );
            }
            let capabilities = initialCapabilities;
            let cuaCrashReason = null;
            let cuaRetryStatus = null;
            if (crashPromise) {
              if (!initialCapabilities.localComputer.available) {
                throw new Error("CUA was not ready before the simulated crash");
              }
              cuaCrashReason = await crashPromise;
              cuaRetryStatus = await window.laterdog.localControl.retry();
              capabilities = await window.laterdog.getCapabilities();
            }
            return {
              initialCapabilities,
              capabilities,
              cuaCrashReason,
              cuaRetryStatus,
              health,
              location: window.location.href,
              title: document.title,
            };
          })()
        `);
        const expectedLocation = `http://127.0.0.1:${SERVER_PORT}/`;
        if (result.location !== expectedLocation) {
          throw new Error(
            `unexpected packaged renderer URL: ${result.location} (expected ${expectedLocation})`,
          );
        }
        if (process.env.LATERDOG_SMOKE_BUNDLED_CUA === "1") {
          const connection = await cuaReady;
          const expectedDriver = path.join(
            process.resourcesPath,
            "cua-linux-x64",
            "cua-driver",
          );
          let exactBundledPath = false;
          try {
            exactBundledPath =
              Boolean(connection?.driver?.path) &&
              fs.realpathSync(connection.driver.path) === fs.realpathSync(expectedDriver);
          } catch {}
          result.cuaRuntime = {
            driverSource: connection?.driver?.source,
            exactBundledPath,
            appImagePrivateStage:
              Boolean(process.env.APPIMAGE) &&
              connection?.driver?.path !== expectedDriver &&
              path.basename(path.dirname(connection?.driver?.path ?? "")).startsWith(
                APPIMAGE_CUA_STAGE_PREFIX,
              ),
            driverPath: connection?.driver?.path,
            driverVersion: connection?.driver?.version,
            daemonPid: connection?.daemon?.pid,
            socketPath: connection?.daemon?.socketPath,
            pidFile: connection?.daemon?.socketPath
              ? path.join(path.dirname(connection.daemon.socketPath), "driver.pid")
              : undefined,
            mcpEnv: connection?.mcp?.env,
          };
        }
        result.hardwareAccelerationEnabled = app.isHardwareAccelerationEnabled();
        result.displayMediaRequests = displayMediaRequestCount;
        console.log(`[smoke] renderer-ready ${JSON.stringify(result)}`);
      } catch (error) {
        console.error(`[smoke] renderer-failed ${error?.stack ?? error}`);
      } finally {
        if (process.env.LATERDOG_SMOKE_KEEP_OPEN !== "1") win.close();
      }
    });
  }

  const remote = activeEnvironment(environmentsState);
  const openProfile = remote ? null : profiles?.activeOrigin() ?? null;
  if (!serverReady && (desktopRemoteAccess || (app.isPackaged && !remote && !openProfile))) serverUnavailableWindows.add(win);
  if (deferNavigation) return win;
  if (desktopRemoteAccess) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: serverStartConflictOnly }));
  } else if (remote) {
    void win.loadURL(remote.origin).catch(() => {});
  } else if (openProfile) {
    void win.loadURL(openProfile).catch(() => {});
  } else if (app.isPackaged) {
    win.loadURL(serverReady ? `http://127.0.0.1:${SERVER_PORT}` : buildErrorPage({ allPortsOccupied: serverStartConflictOnly }));
  } else {
    win.loadURL(DEV_URL);
  }
  return win;
}

ipcMain.handle("screen:frame", localOnly("screen:frame", async () => {
  if (process.platform !== "darwin") return null;
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1280, height: 800 },
  });
  return sources[0]?.thumbnail.toDataURL() ?? null;
}));

ipcMain.handle("engine:open-terminal", localOnly("engine:open-terminal", async (_event, command) => {
  if (typeof command !== "string" || !command.trim()) return false;
  clipboard.writeText(command);
  return openBlankTerminal();
}));

ipcMain.handle("clipboard:write-text", localOnly("clipboard:write-text", (_event, text) => writeClipboardText(clipboard, text)));

ipcMain.handle("desktop:pick-folder", localOnly("desktop:pick-folder", async (event, current) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const result = await dialog.showOpenDialog(win, {
    title: "Choose a working folder",
    properties: ["openDirectory", "createDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}));

ipcMain.handle("desktop:export-diagnostics", localOnly("desktop:export-diagnostics", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const report = await gatherDiagnostics();
  const result = await dialog.showSaveDialog(owner, {
    title: "Export diagnostics",
    defaultPath: diagnosticsFileName(),
    filters: [{ name: "Text", extensions: ["txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  if (process.platform === "win32") {
    fs.writeFileSync(result.filePath, report, { mode: 0o600 });
  } else {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW;
    const handle = fs.openSync(result.filePath, flags, 0o600);
    try {
      fs.fchmodSync(handle, 0o600);
      fs.writeFileSync(handle, report, "utf8");
    } finally {
      fs.closeSync(handle);
    }
  }
  return result.filePath;
}));

ipcMain.handle("desktop:save-file", localOnly("desktop:save-file", async (event, rawPath) => {
  return withSavableFile(rawPath, { home: os.homedir(), root: askingProfile(event) ? profiles.activeDataDir() : variant.id === "release" ? undefined : desktopDataDir() }, async ({ defaultName, copyTo }) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const defaultPath = await defaultSaveName(app.getPath("downloads"), defaultName);
    const choice = await dialog.showSaveDialog(parent ?? undefined, {
      title: "Where do you want to save it?",
      message: "Where do you want to save it?",
      defaultPath,
      buttonLabel: "Save",
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    if (choice.canceled || !choice.filePath) return null;
    await copyTo(choice.filePath);
    shell.showItemInFolder(choice.filePath);
    return choice.filePath;
  });
}));

ipcMain.handle("desktop:reveal-file", localOnly("desktop:reveal-file", async (_event, rawPath) => {
  if (desktopRemoteAccess) throw new Error("That file is on the computer this app is connected to");
  return revealInFolder(rawPath, { reveal: (target) => shell.showItemInFolder(target) });
}));

ipcMain.handle("desktop:skin", (event, skin) => {
  if (!isKnownSkin(skin)) return false;
  try {
    const { color } = skinChrome(skin);
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (win && !win.isDestroyed()) {
      try { win.setBackgroundColor(color); } catch {}
    }
  } catch {}
  return true;
});

for (const [channel, act] of [
  ["window:minimize", (win) => win.minimize()],
  ["window:toggle-maximize", (win) => (win.isMaximized() ? win.unmaximize() : win.maximize())],
  ["window:close", (win) => win.close()],
]) {
  ipcMain.handle(channel, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!win || win.isDestroyed()) return false;
    act(win);
    return true;
  });
}
ipcMain.handle("window:state", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  return { maximized: Boolean(win && !win.isDestroyed() && win.isMaximized()) };
});

ipcMain.handle("desktop:open-external", localOnly("desktop:open-external", async (_event, rawUrl) => {
  await shell.openExternal(externalWebUrl(rawUrl));
  return true;
}));

ipcMain.handle("desktop-viewer:open", localOnly("desktop-viewer:open", (event, rawUrl, title, contextId, pill) => {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return openDesktopViewer(owner, rawUrl, title, contextId, pill);
}));

ipcMain.handle("desktop-workspace:open", localOnly("desktop-workspace:open", (event, input) =>
  desktopWorkspaceForEvent(event, true).open(input),
));
ipcMain.handle("desktop-workspace:layout", localOnly("desktop-workspace:layout", (event, items) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return false;
  return manager.layout(items);
}));
ipcMain.handle("desktop-workspace:set-interactive", localOnly("desktop-workspace:set-interactive", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return contextId == null;
  return manager.setInteractive(contextId);
}));
ipcMain.handle("desktop-workspace:close", localOnly("desktop-workspace:close", (event, contextId) => {
  const manager = desktopWorkspaceForEvent(event);
  if (!manager) return true;
  return manager.close(contextId);
}));

ipcMain.handle("desktop-viewer:close", localOnly("desktop-viewer:close", (_event, contextId) => {
  const scoped = Object.prototype.toString.call(contextId) === "[object String]" ? contextId : null;
  if (scoped !== desktopViewerContextId) return false;
  if (desktopViewerWindow && !desktopViewerWindow.isDestroyed()) desktopViewerWindow.close();
  return true;
}));

ipcMain.handle("desktop-viewer:state-now", localOnly("desktop-viewer:state-now", () => ({
  open: Boolean(desktopViewerWindow && !desktopViewerWindow.isDestroyed()),
  contextId: desktopViewerContextId,
})));

let appPermissions = null;
ipcMain.handle("perm:status", (event) => ({
  mic:
    nativeActions.appleMediaPermissions
      ? systemPreferences.getMediaAccessStatus?.("microphone") ?? "unknown"
      : "unsupported",
  pageMic: appPermissions?.pageMicrophone(event) ?? "refused",
}));
ipcMain.handle("perm:request-mic", localOnly("perm:request-mic", async () => {
  if (!nativeActions.appleMediaPermissions) return false;
  try {
    return await systemPreferences.askForMediaAccess("microphone");
  } catch {
    return false;
  }
}));

const macPermissionHost = () => ({ platform: process.platform, systemPreferences, desktopCapturer });
let cuaGrantStart = null;
function startCuaWhenGranted(checklist) {
  void (async () => {
    if (cuaGrantStart) return;
    const connection = await cuaReady;
    if (cuaGrantStart || !cuaStartsAfterGrant({ platform: process.platform, remote: Boolean(desktopRemoteAccess), checklist, connection })) return;
    cuaGrantStart = startCua()
      .catch((error) => console.error("[cua] start after grant failed:", error))
      .finally(() => { cuaGrantStart = null; });
  })();
  return checklist;
}
async function lendingCua() {
  const connection = await cuaReady.catch(() => null);
  if (connection?.mcpCommand) return connection;
  if (!cuaGrantStart && cuaStartsAfterGrant({ platform: process.platform, remote: Boolean(desktopRemoteAccess), checklist: permissionChecklist(macPermissionHost()), connection })) {
    cuaGrantStart = startCua()
      .catch((error) => console.error("[cua] start after grant failed:", error))
      .finally(() => { cuaGrantStart = null; });
  }
  await cuaGrantStart;
  return cuaReady.catch(() => null);
}
ipcMain.handle("perm:checklist", localOnly("perm:checklist", () => startCuaWhenGranted(permissionChecklist(macPermissionHost()))));
ipcMain.handle("perm:request", localOnly("perm:request", async (_event, permission) => startCuaWhenGranted(await requestPermission(permission, macPermissionHost()))));

ipcMain.handle("perm:open-settings", localOnly("perm:open-settings", (_event, pane) => {
  if (!nativeActions.applePrivacySettings) return false;
  const panes = {
    mic: "Privacy_Microphone",
    microphone: "Privacy_Microphone",
    screen: "Privacy_ScreenCapture",
    speech: "Privacy_SpeechRecognition",
    accessibility: "Privacy_Accessibility",
  };
  const anchor = Object.hasOwn(panes, pane) ? panes[pane] : "Privacy";
  return shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
}));

ipcMain.handle("desktop:relaunch", localOnly("desktop:relaunch", (event) => {
  requireMainWindowSender(event);
  relaunchAfterDesktopRemoteChange();
  return true;
}));

ipcMain.handle("speech:start", localOnly("speech:start", (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  if (!nativeActions.appleSpeech) {
    win.webContents.send("speech:end", { code: 2, reason: "unsupported-platform" });
    return;
  }
  startSpeech(win, options && typeof options === "object"
    ? { endpointMs: options.endpointMs, ...(typeof options.file === "string" ? { file: options.file } : {}) }
    : undefined);
}));
ipcMain.handle("speech:stop", localOnly("speech:stop", () => (nativeActions.appleSpeech ? stopSpeech() : {})));
ipcMain.handle("speech:audio", localOnly("speech:audio", (_event, file) => (nativeActions.appleSpeech ? voiceNoteAudio(file) : null)));
ipcMain.handle("speech:finish", localOnly("speech:finish", () => {
  if (nativeActions.appleSpeech) finishSpeech();
}));

ipcMain.handle("routines:wake-state", localOnly("routines:wake-state", () => routineWake.poll()));
ipcMain.handle("routines:keep-awake", localOnly("routines:keep-awake", async (_event, enabled) => {
  rememberRoutineWake(app.getPath("userData"), Boolean(enabled));
  return routineWake.poll();
}));
ipcMain.handle("release-check:set", localOnly("release-check:set", (_event, enabled) => setReleaseCheckEnabled(enabled === true)));
function publicDesktopRemoteState() {
  return desktopRemoteAccess
    ? {
        active: true,
        endpoint: desktopRemoteAccess.endpoint,
        serverName: desktopRemoteAccess.serverName,
        deviceId: desktopRemoteAccess.deviceId,
      }
    : { active: false };
}

function requireMainWindowSender(event) {
  const sender = BrowserWindow.fromWebContents(event.sender);
  if (!sender || sender !== mainWindow || sender.isDestroyed() ||
      !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("The desktop client window is unavailable");
  }
}

function relaunchAfterDesktopRemoteChange() {
  if (desktopShutdownStarted) return;
  desktopShutdownStarted = true;
  const timer = setTimeout(() => {
    app.relaunch({ args: process.argv.slice(1) });
    app.quit();
  }, 250);
  timer.unref?.();
}

ipcMain.handle("desktop-remote:state", () => publicDesktopRemoteState());
ipcMain.handle("desktop-remote:pair", localOnly("desktop-remote:pair", async (event, endpoint, code) => {
  requireMainWindowSender(event);
  const access = await pairDesktopCompanion({
    endpoint,
    code,
    deviceName: `${installationDisplayName()} desktop`,
  });
  await updateSecureCredentialDocument((credentials) => withoutOrganizationRestartIntent(withDesktopCompanionAccess(credentials, access)));
  desktopRemoteAccess = access;
  relaunchAfterDesktopRemoteChange();
  return publicDesktopRemoteState();
}));
ipcMain.handle("desktop-remote:disconnect", localOnly("desktop-remote:disconnect", async (event) => {
  requireMainWindowSender(event);
  await updateSecureCredentialDocument(withoutDesktopCompanionAccess);
  desktopRemoteAccess = null;
  relaunchAfterDesktopRemoteChange();
  return { active: false };
}));

const workspaceOnly = (handler) => (event, ...args) => {
  if (!workspaceSenderAllowed(event, mainWindow?.webContents, environmentsState, localPageOrigin())) throw new Error("These controls are only available in the main desktop window");
  return handler(event, ...args);
};
const localWorkspaceOnly = (channel, handler) => localOnly(channel, workspaceOnly(handler));
for (const method of ["state", "begin", "signInAgain", "reopen", "cancel", "refresh", "signOut", "openDashboard"]) {
  ipcMain.handle(`cloud-account:${method}`, localWorkspaceOnly(`cloud-account:${method}`, async () => cloudAccountView(await ensureCloudAccount()[method]())));
}
ipcMain.handle("cloud-account:connectHome", localWorkspaceOnly("cloud-account:connectHome", async () => cloudAccountView(await connectCloudHome())));
ipcMain.handle("cloud-account:connectHomeForPhone", localWorkspaceOnly("cloud-account:connectHomeForPhone", async () => cloudAccountView(await connectCloudHome("phone"))));
ipcMain.handle("cloud-account:sendCode", localWorkspaceOnly("cloud-account:sendCode", (_event, email) =>
  cloudSignInOutcome(async () => ({ email: await ensureCloudSignIn().sendCode(email) }))));
ipcMain.handle("cloud-account:verifyCode", localWorkspaceOnly("cloud-account:verifyCode", (_event, email, code) =>
  cloudSignInOutcome(async () => {
    const grant = await ensureCloudSignIn().verifyCode(email, code);
    const state = await ensureCloudAccount().adopt(grant);
    if (!state.account) throw new CloudSignInError("unavailable");
    return { account: cloudAccountView(state) };
  })));
ipcMain.handle("cloud-account:offer", localWorkspaceOnly("cloud-account:offer", () => ({ due: cloudOfferState().due() })));
ipcMain.handle("cloud-account:declineOffer", localWorkspaceOnly("cloud-account:declineOffer", () => {
  cloudOfferState().decline();
  return { due: false };
}));
ipcMain.handle("organization:settings-opened", localWorkspaceOnly("organization:settings-opened", () => organizationEntry.settingsOpened()));
ipcMain.handle("organization:state", localWorkspaceOnly("organization:state", () => ensureManagedDesktop().state()));
ipcMain.handle("organization:begin", localWorkspaceOnly("organization:begin", (_event, input) => ensureManagedDesktop().begin(input)));
ipcMain.handle("organization:reopen", localWorkspaceOnly("organization:reopen", () => ensureManagedDesktop().reopen()));
ipcMain.handle("organization:cancel", localWorkspaceOnly("organization:cancel", () => ensureManagedDesktop().cancelEnrollment()));
ipcMain.handle("organization:refresh", localWorkspaceOnly("organization:refresh", () => ensureManagedDesktop().refresh()));
ipcMain.handle("organization:disconnect", localWorkspaceOnly("organization:disconnect", () => {
  companyBackupConfigurationRevision++;
  companyBackupController?.abort(); preparedCompanyRestore = null;
  const client = ensureManagedDesktop();
  return client.disconnect();
}));
ipcMain.on("company-backups:client-state", receiveCompanyBackupClientState);
ipcMain.handle("company-backups:configure-schedule", localWorkspaceOnly("company-backups:configure-schedule", async (_event, input) => {
  ensureManagedDesktop();
  const revision = ++companyBackupConfigurationRevision;
  if (input?.enabled === true) {
    const scope = companyBackupScope(), proc = serverProc;
    if (!scope || companyBackupController || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
    const status = await localBackupStatus(proc), current = companyBackupScope();
    if (revision !== companyBackupConfigurationRevision || status.busy || status.pendingRestore || !current || scope.key !== current.key || scope.generation !== current.generation ||
        companyBackupController || preparedCompanyRestore || companyRestoreCommitting) throw companyBackupDeferred();
  }
  await companyBackupSchedule.configure(input);
  return { ...companyBackupState, schedule: companyBackupSchedule.state() };
}));
ipcMain.handle("company-backups:state", localWorkspaceOnly("company-backups:state", async () => {
  const status = await localBackupStatus(serverProc);
  return { ...companyBackupState, pendingRestore: status.pendingRestore };
}));
ipcMain.handle("company-backups:list", localWorkspaceOnly("company-backups:list", () => ensureManagedDesktop().requestBackup("/api/desktop/backups")));
ipcMain.handle("company-backups:create", localWorkspaceOnly("company-backups:create", (_event, input) => runCompanyBackup("backup", input)));
ipcMain.handle("company-backups:preview", localWorkspaceOnly("company-backups:preview", (_event, input) => runCompanyBackup("restore", input)));
ipcMain.handle("company-backups:cancel", localWorkspaceOnly("company-backups:cancel", () => { companyBackupController?.abort(); }));
ipcMain.handle("company-backups:delete", localWorkspaceOnly("company-backups:delete", (_event, input) => {
  if (companyBackupController || input?.confirmation !== "DELETE" || !/^[a-f0-9-]{36}$/.test(input?.id)) throw new Error("Confirm the exact backup to delete when no transfer is running.");
  return ensureManagedDesktop().requestBackup(`/api/desktop/backups/${input.id}`, { method: "DELETE" });
}));
ipcMain.handle("company-backups:restore", localWorkspaceOnly("company-backups:restore", async (_event, input) => {
  const client = ensureManagedDesktop(), connection = client.connection();
  if (companyBackupController || companyRestoreCommitting || !preparedCompanyRestore || preparedCompanyRestore.id !== input?.id || input?.confirmation !== "REPLACE" ||
      !connection || client.state().status !== "connected" || !client.state().cloudBackups || connection.expiresAt <= Date.now() ||
      preparedCompanyRestore.proc !== serverProc || preparedCompanyRestore.deviceId !== connection.deviceId) throw new Error("Preview this backup again and type REPLACE to confirm.");
  preparedCompanyRestore = null;
  companyRestoreCommitting = true;
  try {
    const response = await localBackupRequest(serverProc, "/api/workspace-backup/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: input.id, confirmation: "REPLACE" }) });
    if (!response.ok) throw new Error("This installation could not be replaced. Check local backup status before trying again.");
    publishCompanyBackupState({ busy: false, pendingRestore: true });
    return await response.json();
  } finally { companyRestoreCommitting = false; }
}));

let cloudMove = null;

function ensureCloudMove() {
  if (cloudMove) return cloudMove;
  if (!app.isPackaged || desktopRemoteAccess) throw new Error("Copying this computer's bots and chats needs the local desktop app on this computer.");
  cloudMove = createCloudMove({
    localRequest: (route, init) => {
      if (!serverProc || !serverReady || !CLOUD_MOVE_LOCAL_ROUTES.test(route)) throw new Error("This installation changed. Start the copy again.");
      return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit",
        headers: { ...Object.fromEntries(new Headers(init.headers)), [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
    },
    tempRoot: path.join(app.getPath("temp"), tempName(variant, "cloud-move")),
    availableBytes: async directory => { const disk = await fs.promises.statfs(directory); return disk.bavail * disk.bsize; },
    onState: publishCloudMoveState,
    log: slog,
  });
  return cloudMove;
}

function publishCloudMoveState(state) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!contents || desktopRemoteAccess) return;
  const active = activeEnvironment(environmentsState)?.origin;
  let frame = null;
  try { frame = new URL(contents.mainFrame.url).origin; } catch {}
  if ((!active && contents.mainFrame.url.startsWith(`${rendererOrigin()}/`)) || (active && frame === active && state.destination?.origin === active)) {
    contents.send("cloud-move:state-changed", state);
  }
}

async function peekCloudMove(origin) {
  try {
    const response = await session.defaultSession.fetch(`${origin}/api/cloud-move`, { credentials: "include", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      return { status: null, refusal: moveRefusal(response.status, body) };
    }
    const status = parseCloudMoveStatus(await response.json());
    return { status: status && { contents: status.contents, empty: status.empty, freeBytes: status.freeBytes, previous: status.previous, heldBytes: status.heldBytes,
      uploadReceived: status.uploadReceived, volumeBytes: status.volumeBytes, appVersion: status.appVersion, environmentId: status.environmentId }, refusal: status ? null : "unreachable" };
  } catch { return { status: null, refusal: "unreachable" }; }
}

const cloudMoveChoicesFile = () => path.join(app.getPath("userData"), "cloud-move.json");
function cloudMoveDismissed(origin) {
  try { return JSON.parse(fs.readFileSync(cloudMoveChoicesFile(), "utf8"))?.dismissed?.includes(origin) === true; } catch { return false; }
}
function dismissCloudMove(origin) {
  if (accountsNote?.origin === origin) accountsNote = null;
  const move = ensureCloudMove();
  if (!move.running() && move.state().destination?.origin === origin) move.reset();
  if (!origin || cloudMoveDismissed(origin)) return;
  let dismissed = [];
  try { dismissed = JSON.parse(fs.readFileSync(cloudMoveChoicesFile(), "utf8"))?.dismissed ?? []; } catch {}
  fs.writeFileSync(cloudMoveChoicesFile(), JSON.stringify({ dismissed: [...dismissed.filter(entry => typeof entry === "string"), origin].slice(-20) }), { mode: 0o600 });
}

async function cloudMoveOverview(dest, onServerPage) {
  const move = ensureCloudMove(), state = move.state();
  if (!dest) return { ...state, local: null, cloud: null, fit: null, suggest: false, destination: null, blocked: null };
  const [local, peek] = await Promise.all([move.estimate().catch(() => null), dest.origin ? peekCloudMove(dest.origin) : { status: null, refusal: "unreachable" }]);
  const own = !state.destination || state.destination.origin === dest.origin;
  const cloud = peek.status;
  let disk = null;
  if (dest.kind === "cloud") { try { disk = dest.disk(); } catch {} }
  const fit = local && cloud ? moveFit({ localBytes: local.bytes, freeBytes: cloud.freeBytes, uploadReceived: cloud.uploadReceived, volumeBytes: cloud.volumeBytes, disk }) : null;
  const blocked = moveBlocked({ kind: dest.kind, refusal: peek.refusal, local, cloud, busyElsewhere: move.running() && !own });
  const hasWork = Boolean(local && (local.bots > 1 || local.rooms > 0 || local.chats > 0));
  const view = own ? state : { phase: "idle" };
  const automatic = dest.kind === "cloud" && onServerPage === true;
  const suggest = Boolean(!automatic && onServerPage && !blocked && cloud?.empty && hasWork && fit?.fit !== "never" && view.phase === "idle" && !cloudMoveDismissed(dest.origin));
  const shown = value => { if (!value) return null; const { environmentId: _, ...rest } = value; return rest; };
  const accounts = automatic && accountsNote?.origin === dest.origin ? { accounts: accountsNote.accounts } : {};
  return { ...view, ...accounts, local: shown(local), cloud: shown(cloud), fit, suggest, ...(automatic ? { automatic: true } : {}), destination: { id: dest.id, name: dest.name, origin: dest.origin, kind: dest.kind }, blocked,
    ...(blocked === "busy_elsewhere" ? { busyWith: state.destination?.name } : {}) };
}

function ensureCloudAutoMove() {
  cloudAutoMove ??= createCloudAutoMove({
    move: ensureCloudMove(),
    read: () => readUserData("cloud-auto-move.json"),
    write: contents => writeUserData("cloud-auto-move.json", contents),
    log: slog,
  });
  return cloudAutoMove;
}
function ensureMacHold() {
  macHold ??= createMacHold({
    request: (route, init) => {
      if (!serverProc || !serverReady) throw new Error("this Mac's server is not running");
      return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit",
        headers: { ...Object.fromEntries(new Headers(init.headers)), [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
    },
    log: slog,
  });
  return macHold;
}
function ensureCloudWindow() {
  cloudWindow ??= createCloudWindow({
    autoMove: ensureCloudAutoMove(),
    hold: ensureMacHold(),
    destinationFor: choice => {
      const entry = environmentsState.environments.find(candidate => candidate.origin === choice.origin);
      return destinationFor({ id: entry?.id ?? "cloud", name: CLOUD_HOME_NAME, origin: choice.origin, cloud: true });
    },
    showHome: async destination => {
      if (activeEnvironment(environmentsState)?.origin === destination.origin) return;
      await connectCloudHome();
    },
    showLocal: async () => {
      if (!activeEnvironment(environmentsState)) return;
      persistEnvironments(withActive(environmentsState, LOCAL_ID));
      navigateMainWindow(activeOrigin());
    },
    log: slog,
  });
  return cloudWindow;
}
function syncCloudWindow(state, manual = false) {
  if (!app.isPackaged || desktopRemoteAccess || !serverReady) return Promise.resolve(null);
  const controller = ensureCloudWindow();
  return (manual ? controller.retry(state) : controller.sync(state)).then(result => {
    if (result?.kind === "cloud" && (result.move === "moved" || result.move === "nothing")) handOverAccounts(cloudHomeDestination());
    return result;
  }).catch(error => { slog(`cloud window: ${error?.message ?? error}`); return null; });
}
function runCloudAutoMove() {
  return cloudAccount ? syncCloudWindow(cloudAccount.state(), true) : Promise.resolve(null);
}

function ensureCloudAiAccounts() {
  cloudAiAccounts ??= createCloudAiAccounts({
    localRequest: (route, init) => {
      if (!serverProc || !serverReady || !MAC_ACCOUNT_ROUTES.test(route)) throw new Error("This installation changed. Try again.");
      return fetch(`http://127.0.0.1:${SERVER_PORT}${route}`, { ...init, redirect: "error", credentials: "omit",
        headers: { ...Object.fromEntries(new Headers(init.headers)), [DESKTOP_MUTATION_HEADER]: desktopMutationToken } });
    },
    keychain: process.platform === "darwin" ? createMacKeychain() : null,
    read: () => readUserData("cloud-ai-accounts.json"),
    write: contents => writeUserData("cloud-ai-accounts.json", contents),
    log: slog,
    onChange: summary => showAccountsNote(summary),
  });
  return cloudAiAccounts;
}
function handOverAccounts(destination) {
  if (!app.isPackaged || desktopRemoteAccess || !serverReady || destination?.kind !== "cloud" || !destination.origin) return;
  void ensureCloudAiAccounts().handAccountsToCloud({ homeOrigin: destination.origin, session: destination.grant }).catch(error => slog(`cloud accounts: ${error?.message ?? error}`));
}
function showAccountsNote(summary) {
  const destination = cloudHomeDestination();
  const moved = summary.moved.claude + summary.moved.chatgpt;
  if (!destination?.origin || (!moved && !summary.waiting.length && !summary.stayed.some(entry => entry.why !== "chatgpt-plan"))) return;
  accountsNote = { origin: destination.origin, accounts: { moved: summary.moved, stayed: [...summary.stayed.map(entry => entry.name), ...summary.waiting] } };
  publishCloudMoveState({ ...ensureCloudMove().state(), destination: { id: destination.id, name: destination.name, origin: destination.origin, kind: "cloud" }, accounts: accountsNote.accounts });
}
function destinationFor(entry) {
  const homeOrigin = cloudAccount?.homeTarget()?.origin ?? null;
  if (entry.cloud || isCloudHomeEntry(entry, { homeOrigin })) {
    return { id: entry.id, name: entry.name, origin: entry.origin ?? homeOrigin, kind: "cloud",
      grant: () => ensureCloudAccount().pairHome(),
      disk: () => cloudPlanDisk(ensureCloudAccount().state()),
      grow: sizeGb => ensureCloudAccount().growDisk(sizeGb) };
  }
  return { id: entry.id, name: entry.name, origin: entry.origin, kind: "server",
    grant: () => mintOwnerCode((...args) => session.defaultSession.fetch(...args), entry.origin) };
}
function moveSender(channel, event, id, { localOnly = false } = {}) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  const local = senderIsLocal(event) && workspaceSenderAllowed(event, contents, environmentsState, rendererOrigin());
  if (local || (!localOnly && !desktopRemoteAccess)) {
    const asked = moveSenderDestination(event, { contents, environments: environmentsState, localOrigin: rendererOrigin(), cloudHomeOrigin: cloudAccount?.homeTarget()?.origin ?? null, id });
    if (asked && asked.remote === !local) return { remote: asked.remote, dest: asked.entry ? destinationFor(asked.entry) : null };
  }
  throw new Error(`${channel} is only available in this app's window`);
}
const named = dest => { if (!dest) throw new Error("Choose a server to copy this computer's bots and chats to."); return dest; };
const afterCloudMove = dest => async result => {
  if (result.phase !== "done") return result;
  try {
    if (dest.id === environmentsState.activeId) navigateMainWindow(dest.origin);
    else if (environmentsState.environments.some(entry => entry.id === dest.id)) await switchEnvironment(dest.id);
    else if (dest.kind === "cloud") await connectCloudHome();
  } catch (error) { slog(`workspace copy: could not open ${dest.name} (${error?.message ?? error})`); }
  return result;
};
ipcMain.handle("cloud-move:state", (event, id) => { const asked = moveSender("cloud-move:state", event, id); return cloudMoveOverview(asked.dest, asked.remote); });
ipcMain.handle("cloud-move:start", (event, id) => {
  const asked = moveSender("cloud-move:start", event, id), dest = named(asked.dest);
  if (asked.remote) {
    const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
    const verifiedCloud = dest.kind === "cloud" && !desktopRemoteAccess &&
      cloudPageSenderAllowed(event, { contents, homeOrigin: cloudAccount?.homeTarget()?.origin ?? null, activeOrigin: activeEnvironment(environmentsState)?.origin });
    if (!verifiedCloud) { openWorkspaceSettings(dest.id, "copy"); return { phase: "idle" }; }
  }
  if (asked.remote && dest.kind === "cloud") return runCloudAutoMove().then(() => ensureCloudMove().state());
  return ensureCloudMove().move(dest, { requireEmpty: asked.remote }).then(afterCloudMove(dest));
});
ipcMain.handle("cloud-move:cancel", (event) => {
  const asked = moveSender("cloud-move:cancel", event, undefined), move = ensureCloudMove();
  return asked.remote && move.state().destination?.origin !== asked.dest?.origin ? move.state() : move.cancel();
});
ipcMain.handle("cloud-move:dismiss", (event, id) => {
  const asked = moveSender("cloud-move:dismiss", event, id);
  if (asked.dest) dismissCloudMove(asked.dest.origin);
  return cloudMoveOverview(asked.dest, asked.remote);
});
ipcMain.handle("cloud-move:restore-previous", (event, id) => {
  const dest = named(moveSender("cloud-move:restore-previous", event, id, { localOnly: true }).dest);
  return ensureCloudMove().restorePrevious(dest).then(afterCloudMove(dest));
});
function myCloud() {
  return myCloudOrigin({ account: cloudAccount, remembered: rememberedHome, remoteAccess: desktopRemoteAccess });
}
const cloudPageAsking = (event) => {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (senderIsLocal(event) && workspaceSenderAllowed(event, contents, environmentsState, rendererOrigin())) return "local";
  if (cloudPageSenderAllowed(event, { contents, homeOrigin: myCloud(), activeOrigin: activeEnvironment(environmentsState)?.origin })) return "cloud";
  return null;
};
const cloudPageSender = (channel, handler) => (event) => {
  const asking = cloudPageAsking(event);
  if (!asking) throw new Error(`${channel} is only available in this app's window`);
  return handler(asking === "cloud");
};
const updaterPageAllowed = event => cloudPageAsking(event) !== null || profilePageSender(event);
const updaterPageOffered = event => {
  if (updaterPageAllowed(event)) return true;
  if (desktopRemoteAccess || cloudSignInRestored) return false;
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  return cloudPageSenderAllowed(event, { contents, homeOrigin: savedCloudHomeOrigin(environmentsState), activeOrigin: activeEnvironment(environmentsState)?.origin });
};
ipcMain.on("update:offered", event => {
  try { event.returnValue = updaterPageOffered(event) === true; } catch { event.returnValue = false; }
});
ipcMain.handle("cloud-lending:open", cloudPageSender("cloud-lending:open", () => openLendingSettings()));
ipcMain.handle("cloud-plan:state", cloudPageSender("cloud-plan:state", () => cloudPlanSnapshot(cloudAccount?.state())));
ipcMain.handle("cloud-plan:manage", cloudPageSender("cloud-plan:manage", async () => { await ensureCloudAccount().openDashboard(); }));
ipcMain.handle("cloud-plan:signOut", cloudPageSender("cloud-plan:signOut", async () => { await ensureCloudAccount().signOut(); }));

const savedWorkspace = id => {
  const env = environmentsState.environments.find(entry => entry.id === id);
  if (!env) throw new Error("This server is no longer connected");
  return env;
};
ipcMain.handle("sharing:state", localWorkspaceOnly("sharing:state", async (_event, id) => {
  await requireSharedComputers();
  return sharingController().state(savedWorkspace(id).id);
}));
ipcMain.handle("sharing:folder", localWorkspaceOnly("sharing:folder", async () => {
  await requireSharedComputers();
  const picked = await dialog.showOpenDialog(mainWindow, { title: "Choose a folder to share", properties: ["openDirectory"] });
  if (picked.canceled || !picked.filePaths[0]) return null;
  return (await validateSharedFolders([{ id: randomUUID(), path: picked.filePaths[0], write: false }]))[0];
}));
ipcMain.handle("sharing:revoke", localWorkspaceOnly("sharing:revoke", async (_event, id) => {
  await requireSharedComputers();
  return sharingController().revoke(savedWorkspace(id));
}));
ipcMain.handle("sharing:activity", localWorkspaceOnly("sharing:activity", async (_event, id) => {
  await requireSharedComputers();
  return sharingController().activity(savedWorkspace(id).id, 50);
}));
ipcMain.handle("sharing:save", localWorkspaceOnly("sharing:save", async (_event, id, input) => {
  await requireSharedComputers();
  const env = savedWorkspace(id);
  const info = await sharingController().identity(env);
  const folders = await validateSharedFolders(input?.folders);
  const detail = [
    `Server: ${env.origin}`,
    ...folders.map(folder => `${folder.write ? "Read and write" : "Read only"}: ${folder.path}`),
    input?.terminal === true ? "Terminal: UNRESTRICTED commands as your user. Can access files outside the folders above, including credentials." : "Terminal: off",
    input?.computer === true ? "Computer control: can view your screen and operate logged-in apps. Can access information outside the folders above." : "Computer control: off",
    "Shared content is sent to this server and may reach its model provider. Bots on this server can use these permissions until you revoke them. Closing the desktop stops access.",
  ].join("\n\n");
  const confirmation = await dialog.showMessageBox(mainWindow, { type: "warning", message: `Allow computer access for ${env.name}?`, detail, buttons: ["Allow access", "Cancel"], defaultId: 1, cancelId: 1 });
  if (confirmation.response !== 0) return null;
  savedWorkspace(id);
  return sharingController().save(env, { folders, terminal: input?.terminal === true, computer: input?.computer === true }, info);
}));

async function lendingSnapshot() {
  const env = cloudLendingEnvironment();
  const connection = await cuaReady.catch(() => null);
  const sharing = sharingController();
  return {
    available: Boolean(env),
    screenAvailable: Boolean(connection?.mcpCommand),
    state: sharing.cloudState(env),
    ...(env ? { activity: sharing.activity(env.id, 30) } : {}),
  };
}
ipcMain.handle("lending:state", localWorkspaceOnly("lending:state", () => lendingSnapshot()));
ipcMain.handle("lending:home", localWorkspaceOnly("lending:home", async (_event, on) => {
  await sharingController().setHome(on === true);
  return lendingSnapshot();
}));

ipcMain.handle("dialog:confirm", localWorkspaceOnly("dialog:confirm", async (_event, message) => {
  if (typeof message !== "string" || !message.trim() || message.length > 4096 || !mainWindow || mainWindow.isDestroyed()) return false;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "warning",
    message,
    buttons: ["OK", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}));

ipcMain.handle("environments:state", localWorkspaceOnly("environments:state", (event) => ({
  localOrigin: rendererOrigin(),
  remote: !senderIsLocal(event),
  activeId: environmentsState.activeId,
  environments: environmentsState.environments,
})));
ipcMain.handle("environments:switch", localWorkspaceOnly("environments:switch", (_event, id) => switchEnvironment(typeof id === "string" ? id : LOCAL_ID)));
ipcMain.handle("environments:add-from-link", localWorkspaceOnly("environments:add-from-link", (_event, link, name) => {
  return connectHostedWorkspace(link, typeof name === "string" ? name : undefined);
}));

ipcMain.handle("workspaces:state", workspaceOnly(() => workspaceSummary(environmentsState)));
ipcMain.handle("desktop:capabilities", async (event) => {
  const profile = askingProfile(event);
  return desktopCapabilities({
    remote: !senderIsLocal(event) && !profile,
    platform: process.platform,
    env: process.env,
    packaged: app.isPackaged,
    localConnection: await cuaReady,
    credentialStore: profile ? profiles.activeCredentialStore() : credentialStoreCapability(),
  });
});

registerProfileIpc({ ipcMain, runner: () => profiles, isPage: profilePageSender, senderAllowed: profileSwitcherSender, showActive });

const CREDENTIAL_PATCH = {
  composioApiKey: (value) => ({ composio: { apiKey: value } }),
  xaiApiKey: (value) => ({ xai: { key: value } }),
  boxToken: (value) => ({ box: { token: value } }),
  opencodeGoApiKey: (value) => ({ opencodeGo: { apiKey: value } }),
  ttsKey: (value) => ({ tts: { key: value } }),
  fishAudioKey: (value) => ({ tts: { fishKey: value } }),
  jevApiKey: (value) => ({ decider: { key: value } }),
  openaiImageApiKey: (value) => ({ imageGen: { key: value } }),
  customImageApiKey: (value) => ({ imageGen: { customApiKey: value } }),
  cloudflareAiToken: (value) => ({ typing: { token: value } }),
  openaiLiveKey: (value) => ({ live: { key: value } }),
};

async function saveWorkspaceCredential(name, value) {
  const patchFor = CREDENTIAL_PATCH[name];
  if (!patchFor || typeof value !== "string") {
    throw new Error("Unsupported credential");
  }
  if (app.isPackaged && !(await safeStorage.isAsyncEncryptionAvailable()) && !credentialFallbackAvailable()) {
    throw new Error("The operating-system credential store is unavailable");
  }
  const secret = value.trim();
  const applyToHarness = async () => {
    if (app.isPackaged && !serverReady) throw new Error("The embedded bot server is unavailable");
    const secretStorage = app.isPackaged ? "?secretStorage=external" : "";
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/config${secretStorage}`, {
      method: "PUT",
      headers: desktopServerHeaders(
        { "content-type": "application/json" },
        { packaged: app.isPackaged, token: desktopMutationToken },
      ),
      body: JSON.stringify(patchFor(secret)),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `Could not save credential (HTTP ${response.status})`);
    return body;
  };
  if (!app.isPackaged) return applyToHarness();

  return updateSecureCredentialDocument(
    (credentials) => {
      if (secret) credentials[name] = secret;
      else delete credentials[name];
      return credentials;
    },
    applyToHarness,
  );
}

async function saveProfileCredential(id, name, value) {
  const patchFor = CREDENTIAL_PATCH[name];
  if (!patchFor || typeof value !== "string") throw new Error("Unsupported credential");
  if (!(await safeStorage.isAsyncEncryptionAvailable()) && !credentialFallbackAvailable()) throw new Error("The operating-system credential store is unavailable");
  return profiles.saveCredential(id, name, value, patchFor(value.trim()));
}

ipcMain.handle("credential:set", localOnly("credential:set", (event, name, value) =>
  askingProfile(event) ? saveProfileCredential(profiles.activeId(), name, value) : saveWorkspaceCredential(name, value),
));

async function restoreWorkspaceCredentials(credentials) {
  if (app.isPackaged && serverReady && !desktopRemoteAccess) {
    const patch = {};
    for (const [name, patchFor] of Object.entries(CREDENTIAL_PATCH)) {
      if (typeof credentials[name] !== "string" || !credentials[name]) continue;
      for (const [section, values] of Object.entries(patchFor(credentials[name]))) {
        patch[section] = { ...patch[section], ...values };
      }
    }
    await applyProfileCredential({ port: SERVER_PORT, patch });
  }
  secureCredentials = credentials;
  credentialStoreUnavailable = false;
  syncManagedComposioCredentials();
  void broadcastDesktopCapabilities().catch(() => {});
}

ipcMain.handle("credential:retry", localOnly("credential:retry", async (event) => {
  try {
    const available = askingProfile(event)
      ? await profiles.retryCredentials(profiles.activeId())
      : await secureCredentialState?.retry() ?? false;
    return { available };
  } catch {
    return { available: false };
  }
}));

ipcMain.handle("approvals:set-trusted-mode", localOnly("approvals:set-trusted-mode", (event, botId, mode, options) => {
  const proc = askingProfile(event) ? profiles.activeProcess() : serverProc;
  if (!app.isPackaged || !proc) {
    throw new Error("Full and Custom approval modes require the embedded desktop server");
  }
  return trustedApprovalMode.request(proc, botId, mode, options);
}));

async function broadcastDesktopCapabilities() {
  const localConnection = await cuaReady;
  const build = (remote, credentialStore = credentialStoreCapability()) =>
    desktopCapabilities({
      remote,
      platform: process.platform,
      env: process.env,
      packaged: app.isPackaged,
      localConnection,
      credentialStore,
    });
  const local = build(false);
  let redacted = null;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    let isLocal = false;
    let isProfile = false;
    try {
      const origin = new URL(window.webContents.getURL()).origin;
      isLocal = origin === rendererOrigin();
      isProfile = Boolean(profiles) && origin === profiles.activeOrigin();
    } catch {}
    if (isProfile) {
      window.webContents.send("desktop:capabilities-changed", build(false, profiles.activeCredentialStore()));
      continue;
    }
    if (!isLocal) redacted ??= build(true);
    window.webContents.send("desktop:capabilities-changed", isLocal ? local : redacted);
  }
}

setCuaStateListener((connection) => {
  cuaReady = Promise.resolve(connection);
  void broadcastDesktopCapabilities().catch((error) => {
    console.error("[desktop] capability broadcast failed:", error);
  });
});

app.whenReady().then(async () => {
  if (await offerMoveToApplications({ app, dialog, log: slog })) return;
  await evictStartupCacheOnce({
    userData: app.getPath("userData"),
    currentVersion: app.getVersion(),
    clearCache: () => session.defaultSession.clearCache(),
    log: slog,
  });
  if (process.platform === "win32") {
    try {
      desktopTray = createSystemTray({
        Tray, Menu, nativeImage, iconPath: APP_ICON,
        getWindow: () => startupScreen?.window ?? mainWindow,
        onQuit: () => app.quit(),
      });
    } catch (error) {
      slog(`system tray unavailable: ${error?.message ?? error}`);
    }
  }
  startupScreen = createStartupScreen({
    BrowserWindow, iconPath: APP_ICON, isQuitting: () => desktopShutdownStarted,
    onQuit: () => app.quit(),
    onHide: desktopTray ? (win) => desktopTray.hide(win) : undefined,
    isHidden: () => desktopTray?.isHidden() ?? false,
    onShow: (win) => desktopTray?.windowShown(win),
    onFinished: () => { startupScreen = null; },
  });
  await startupScreen.ready;
  if (desktopShutdownStarted) return;
  session.defaultSession.on("will-download", (_event, item) => {
    item.setSavePath(collisionFreeDownloadPath(app.getPath("downloads"), item.getFilename()));
    revealDownloadWhenDone(item, (filePath) => shell.showItemInFolder(filePath));
  });
  if (app.isPackaged) {
    try {
      desktopDataDirLease = acquireDataDirLease(desktopDataDir(), variant.id === "release" ? {
        legacyDataDir: path.join(app.getPath("home"), ".laterdog-v0"),
      } : {});
    } catch (error) {
      dialog.showErrorBox(
        "later.dog could not start safely",
        error?.message ?? "Another process is using this later.dog data folder.",
      );
      app.quit();
      return;
    }
  }
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(variant.scheme);
    installDesktopMutationHeader();
  }
  if (process.platform === "darwin") app.dock.setIcon(APP_ICON);
  secureCredentials = await loadSecureCredentials();
  if (secureCredentials && Object.hasOwn(secureCredentials, "assemblyAiApiKey") && !credentialStoreUnavailable) {
    try {
      const { assemblyAiApiKey: _removed, ...rest } = secureCredentials;
      await saveSecureCredentials(rest);
      secureCredentials = rest;
    } catch (error) {
      slog(`orphaned AssemblyAI key not removed: ${error?.message ?? error}`);
    }
  }
  if (app.isPackaged) {
    await secureComposioConfig();
    await secureWorkspaceConfig();
  }
  secureCredentialState = createSecureCredentialState(secureCredentials, saveSecureCredentials, {
    writable: !credentialStoreUnavailable,
    reload: readCredentialStore,
    afterReload: restoreWorkspaceCredentials,
  });
  secureCredentials = secureCredentialState.read();
  desktopRemoteAccess = desktopCompanionAccess(secureCredentials);
  if (process.platform === "darwin" || process.platform === "linux") {
    session.defaultSession.setDisplayMediaRequestHandler(
      (request, callback) => {
        displayMediaRequestCount += 1;
        if (!displayMediaGuard.consume(request, localPageOrigin())) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        const capabilities = desktopCapabilities({
          platform: process.platform,
          env: process.env,
          packaged: app.isPackaged,
        });
        const captureHost =
          process.platform === "darwin" ? "darwin" : capabilities.host.session;
        if (!capabilities.screenPreview.available) {
          respondToDisplayMediaRequest(callback, {});
          return;
        }

        desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
          .then((sources) => {
            const source = selectCaptureSource({
              sources,
              host: captureHost,
              primaryDisplayId:
                process.platform === "linux" && captureHost === "x11"
                  ? screen.getPrimaryDisplay().id
                  : null,
            });
            if (!source) {
              console.warn(
                `[screen-preview] rejected ${captureHost} source set (${sources.length} candidates)`,
              );
            }
            respondToDisplayMediaRequest(callback, source ? { video: source } : {});
          })
          .catch((error) => {
            console.warn("[screen-preview] source discovery failed:", error);
            respondToDisplayMediaRequest(callback, {});
          });
      },
      { useSystemPicker: false },
    );
  }
  registerCuaIpc();
  androidDevice.registerIpc(ipcMain);
  registerUpdaterIpc({ pageAllowed: updaterPageAllowed });
  cuaReady =
    !desktopRemoteAccess && (process.platform === "darwin" || process.platform === "linux" || process.platform === "win32")
      ? startCua().catch((e) => {
          console.error("[cua] start failed:", e);
          return { mode: "unavailable", reason: String(e) };
        })
      : Promise.resolve({ mode: "unavailable", reason: "unsupported-platform" });
  if (desktopRemoteAccess) {
    try {
      desktopCompanionRelay = await startDesktopCompanionRelay({
        access: desktopRemoteAccess,
        staticDir: app.isPackaged
          ? path.join(process.resourcesPath, "ui")
          : path.join(app.getAppPath(), "dist"),
      });
      SERVER_PORT = desktopCompanionRelay.port;
      serverReady = true;
    } catch (error) {
      serverReady = false;
      slog(`desktop companion relay failed: ${error?.message ?? error}`);
    }
  } else if (app.isPackaged) {
    const profilesStarting = startProfiles();
    await startServerPackaged();
    await profilesStarting;
  }
  if (app.isPackaged && !desktopRemoteAccess && serverReady) {
    const supervisor = await startLaterDogSupervisor({ app, dataDir: desktopDataDir(), port: SERVER_PORT, ownerToken: desktopMutationToken, log: slog });
    if (supervisor) app.once("will-quit", () => supervisor.kill("SIGTERM"));
  }
  if (desktopShutdownStarted) return;
  if (app.isPackaged && !desktopRemoteAccess) void ensureManagedDesktop().start().then(() => companyBackupSchedule.start()).catch(() => {});
  if (app.isPackaged && !desktopRemoteAccess && configuredCloudOrigin()) {
    cloudAccountRestoring = true;
    cloudAccountStarted = ensureCloudAccount().start().catch(() => {}).finally(() => { cloudAccountRestoring = false; });
  }
  void cloudAccountStarted.then(() => { cloudSignInRestored = true; });
  setLocalOrigin(rendererOrigin());
  setProfileOrigin(() => profiles?.activeOrigin() ?? null);
  appPermissions = appPermissionHandlers({
    rendererOrigin: localPageOrigin,
    mainContents: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null),
    cloudHomeOrigin: myCloud,
    cloudHomeRestoring: () => cloudAccountRestoring ? cloudAccountRestored() : null,
    activeRemoteOrigin: () => activeEnvironment(environmentsState)?.origin ?? null,
  });
  session.defaultSession.setPermissionRequestHandler(appPermissions.request);
  session.defaultSession.setPermissionCheckHandler(appPermissions.check);
  environmentsState = readEnvironments();
  void refreshSharedComputersAllowed().then((allowed) => {
    sharingController().start({ maintainer: allowed });
    void cloudAccountStarted.then(() => computerSharing?.cloudChanged());
  });
  let restoredOrganizationEntry = false;
  await workspaceMenuAction(async () => { restoredOrganizationEntry = await organizationEntry.restore(); });
  organizationEntryReady = true;
  const deliveredOrganizationEntry = await deliverOrganizationEntry();
  const deliveredCloudEntry = await cloudEntry.ready();
  if (!restoredOrganizationEntry && !deliveredOrganizationEntry && !deliveredCloudEntry && (!mainWindow || mainWindow.isDestroyed())) createWindow();
  if (credentialStoreUnavailable) {
    slog("skipping connected-apps registration: the credential store was unreadable this launch");
  }
  if (!desktopRemoteAccess && app.isPackaged && composioBrokerUrl() && !credentialStoreUnavailable) {
    void updateSecureCredentialDocument(async (credentials) => {
      await ensureManagedComposioCredentials({
        brokerUrl: composioBrokerUrl(),
        credentials,
        saveCredentials: async () => {},
        log: slog,
      });
      return credentials;
    }).finally(syncManagedComposioCredentials);
  }
  startUpdater();
  refreshApplicationMenu();
  app.on("activate", () => {
    if (desktopTray?.show()) return;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).finally(() => allWindowsClosedQuit.settleStartup());

const allWindowsClosedQuit = createAllWindowsClosedQuit({
  app,
  allWindows: () => BrowserWindow.getAllWindows(),
});

const CUA_STOP_TIMEOUT_MS = 2500;
let cuaCleanedUp = false;
let signalQuitRequested = false;

const requestSignalQuit = () => {
  if (signalQuitRequested) return;
  signalQuitRequested = true;
  app.quit();
};
process.once("SIGINT", requestSignalQuit);
process.once("SIGTERM", requestSignalQuit);

app.on("before-quit", (e) => {
  desktopShutdownStarted = true;
  startupScreen?.dispose();
  companyBackupSchedule?.close();
  orgLibrary?.close();
  managedDesktop?.close();
  cloudAccount?.close();
  void cloudMove?.close();
  companyBackupController?.abort();
  computerSharing?.close();
  lendingTray?.destroy();
  if (cuaCleanedUp) return;
  e.preventDefault();
  const stoppingServer = serverSupervisor.shutdown();
  routineWake.stop();
  try {
    desktopCompanionRelay?.close?.();
  } catch {}
  if (nativeActions.appleSpeech) stopSpeech();
  const ownedHelperCleanup = Promise.race([
    stopCua().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, CUA_STOP_TIMEOUT_MS).unref()),
  ]);
  const cleanup = Promise.all([
    ownedHelperCleanup,
    profiles?.stopAll().catch(() => {}),
    stoppingServer.then((stopped) => {
      if (!stopped) slog("server child did not stop before desktop exit; retaining the data-directory lease");
    }),
  ]);
  cleanup.then(() => {
    cuaCleanedUp = true;
    app.quit();
  });
});

function releaseDesktopDataDirLease() {
  if (!desktopDataDirLease) return;
  try {
    desktopDataDirLease.release();
    desktopDataDirLease = null;
  } catch (error) {
    slog(`data-directory lease release failed: ${error?.message ?? error}`);
  }
}

app.on("will-quit", releaseDesktopDataDirLease);
app.on("will-quit", () => { if (localControl) removeLocalControlToken(localControl.file, localControl.token); });
app.on("will-quit", () => desktopTray?.destroy());
process.once("exit", releaseDesktopDataDirLease);
