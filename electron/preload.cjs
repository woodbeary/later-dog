const { contextBridge, ipcRenderer, webUtils } = require("electron");

let pendingPackageInstallUrl = null;
const packageInstallListeners = new Set();
ipcRenderer.on("package:install", (_event, url) => {
  if (typeof url !== "string") return;
  pendingPackageInstallUrl = url;
  for (const listener of packageInstallListeners) listener(url);
});

const FIXED_SETTINGS_ACTIONS = new Set(["organization", "cloud", "cloud-settings", "lending"]);
let pendingSettingsAction = null;
const appSettingsListeners = new Set();
ipcRenderer.on("app:open-settings", (_event, section) => {
  const fixedSection = FIXED_SETTINGS_ACTIONS.has(section) ? section : undefined;
  if (fixedSection && !appSettingsListeners.size) pendingSettingsAction = fixedSection;
  if (!appSettingsListeners.size) return;
  pendingSettingsAction = null;
  for (const listener of appSettingsListeners) listener(fixedSection);
});

function bannerRelay(channel) {
  const listeners = new Set();
  const pending = [];
  ipcRenderer.on(channel, (_event, payload) => {
    if (!payload || typeof payload !== "object") return;
    if (!listeners.size) {
      pending.push(payload);
      return;
    }
    for (const listener of listeners) listener(payload);
  });
  return (cb) => {
    listeners.add(cb);
    queueMicrotask(() => {
      if (!listeners.has(cb)) return;
      for (const payload of pending.splice(0)) for (const listener of listeners) listener(payload);
    });
    return () => listeners.delete(cb);
  };
}
const onBannerOpen = bannerRelay("notification:open");
const onBannerReply = bannerRelay("notification:reply");

const localOrigin = process.argv.find((arg) => arg.startsWith("--laterdog-local-origin="))?.slice("--laterdog-local-origin=".length) ?? null;
const isLocalPage = !localOrigin || location.origin === localOrigin;
const savedServer = id => isLocalPage && typeof id === "string" && /^[\w-]{1,64}$/.test(id) ? [id] : [];
const REMOTE_SAFE = new Set(["platform", "getCapabilities", "onCapabilitiesChanged", "applySkin", "setUnreadCount", "permStatus", "workspaces", "cloudMove", "cloudLending", "cloudPlan", "cloudPermissions", "onOpenAppSettings", "notifications"]);
function updaterOffered() {
  try { return ipcRenderer.sendSync("update:offered") === true; } catch { return false; }
}
let shownUpdateVersion;
function showUpdateState(state) {
  if (state?.status === "downloaded") shownUpdateVersion = typeof state.version === "string" ? state.version : undefined;
  return state;
}
const REMOTE_SPEECH = ["speechStart", "speechStop", "speechFinish", "speechAudio", "onSpeechTranscript", "onSpeechEnd"];
const remoteKeys = isLocalPage ? REMOTE_SAFE
  : new Set([...REMOTE_SAFE, ...REMOTE_SPEECH, ...(updaterOffered() ? ["updater"] : [])]);

const COMPANY_BACKUP_CLIENT_KEYS = [
  "laterdog-drafts", "laterdog-draft-attachments", "laterdog-draft-send-ids", "laterdog-draft-channel-modes",
  "laterdog-skin", "laterdog-show-threads", "laterdog-show-run-card", "laterdog.sidebarDensity",
  "laterdog.sidebarCollapsedSections.v1", "laterdog.sidebarSectionOrder.v1",
  "laterdog-analytics-opt-out", "laterdog.remote-voice.v1",
];
if (isLocalPage && process.argv.includes("--laterdog-company-desktop=1")) {
  ipcRenderer.on("company-backups:collect-client-state", (_event, request) => {
    if (!request || typeof request.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(request.requestId)) return;
    try {
      if (!localOrigin || location.origin !== localOrigin) throw new Error("Not the local workspace");
      const clientState = {};
      for (const key of COMPANY_BACKUP_CLIENT_KEYS) {
        const value = localStorage.getItem(key);
        if (value !== null) clientState[key] = value;
      }
      if (new TextEncoder().encode(JSON.stringify(clientState)).byteLength > 2 * 1024 ** 2) throw new Error("Browser state too large");
      ipcRenderer.send("company-backups:client-state", { requestId: request.requestId, clientState });
    } catch {
      ipcRenderer.send("company-backups:client-state", { requestId: request.requestId, unavailable: true });
    }
  });
}

const bridge = {
  platform: process.platform,
  workspaces: {
    state: () => ipcRenderer.invoke("workspaces:state"),
    menu: () => ipcRenderer.invoke("workspaces:menu"),
  },
  getCapabilities: () => ipcRenderer.invoke("desktop:capabilities"),
  onCapabilitiesChanged: (cb) => {
    const handler = (_event, capabilities) => cb(capabilities);
    ipcRenderer.on("desktop:capabilities-changed", handler);
    return () => ipcRenderer.removeListener("desktop:capabilities-changed", handler);
  },
  localPage: true,
  routines: {
    wakeState: () => ipcRenderer.invoke("routines:wake-state"),
    keepAwake: (enabled) => ipcRenderer.invoke("routines:keep-awake", enabled),
  },
  approvals: {
    setMode: (botId, mode, options) => ipcRenderer.invoke("approvals:set-trusted-mode", botId, mode, options),
  },
  localControl: {
    status: () => ipcRenderer.invoke("cua:linux-status"),
    enable: () => ipcRenderer.invoke("cua:linux-enable"),
    disable: () => ipcRenderer.invoke("cua:linux-disable"),
    retry: () => ipcRenderer.invoke("cua:linux-retry"),
  },
  beginScreenPreviewIntent: () => ipcRenderer.sendSync("screen:preview-intent"),
  screenFrame: () => ipcRenderer.invoke("screen:frame"),
  androidDevice: {
    status: () => ipcRenderer.invoke("android-device:status"),
    frame: (serial) => ipcRenderer.invoke("android-device:frame", serial),
    input: (serial, payload) =>
      ipcRenderer.invoke("android-device:input", serial, payload).then(() => undefined),
  },
  speechStart: (options) => ipcRenderer.invoke("speech:start", options),
  speechStop: () => ipcRenderer.invoke("speech:stop"),
  speechFinish: () => ipcRenderer.invoke("speech:finish"),
  speechAudio: (file) => ipcRenderer.invoke("speech:audio", file),
  onSpeechTranscript: (cb) => {
    const handler = (_event, line) => cb(line);
    ipcRenderer.on("speech:transcript", handler);
    return () => ipcRenderer.removeListener("speech:transcript", handler);
  },
  onSpeechEnd: (cb) => {
    const handler = (_event, info) => cb(info);
    ipcRenderer.on("speech:end", handler);
    return () => ipcRenderer.removeListener("speech:end", handler);
  },
  onOpenAppSettings: (cb) => {
    appSettingsListeners.add(cb);
    queueMicrotask(() => {
      const section = pendingSettingsAction;
      if (!section || !appSettingsListeners.size) return;
      pendingSettingsAction = null;
      for (const listener of appSettingsListeners) listener(section);
    });
    return () => appSettingsListeners.delete(cb);
  },
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  permStatus: () => ipcRenderer.invoke("perm:status"),
  permRequestMic: () => ipcRenderer.invoke("perm:request-mic"),
  permOpenSettings: (pane) => ipcRenderer.invoke("perm:open-settings", pane),
  permissions: {
    status: () => ipcRenderer.invoke("perm:checklist"),
    request: (permission) => ipcRenderer.invoke("perm:request", permission),
    openSettings: (permission) => ipcRenderer.invoke("perm:open-settings", permission),
  },
  relaunch: () => ipcRenderer.invoke("desktop:relaunch"),

  openInstallTerminal: (command) => ipcRenderer.invoke("engine:open-terminal", command),
  copyText: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  applySkin: (skin) => ipcRenderer.invoke("desktop:skin", skin),
  windowControls: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    state: () => ipcRenderer.invoke("window:state"),
    onMaximizedChanged: (cb) => {
      const handler = (_event, maximized) => cb(maximized);
      ipcRenderer.on("window:maximized-changed", handler);
      return () => ipcRenderer.removeListener("window:maximized-changed", handler);
    },
  },
  onPackageInstall: (cb) => {
    packageInstallListeners.add(cb);
    if (pendingPackageInstallUrl) cb(pendingPackageInstallUrl);
    return () => packageInstallListeners.delete(cb);
  },
  setUnreadCount: (count) => ipcRenderer.send("desktop:unread-count", count),
  notifications: {
    show: (request) => ipcRenderer.send("notification:show", request),
    onOpen: onBannerOpen,
    onReply: onBannerReply,
  },
  desktopViewer: {
    open: (url, title, contextId, pill) => ipcRenderer.invoke("desktop-viewer:open", url, title, contextId, pill),
    close: (contextId) => ipcRenderer.invoke("desktop-viewer:close", contextId),
    currentState: () => ipcRenderer.invoke("desktop-viewer:state-now"),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-viewer:state", handler);
      return () => ipcRenderer.removeListener("desktop-viewer:state", handler);
    },
  },
  desktopWorkspace: {
    open: (input) => ipcRenderer.invoke("desktop-workspace:open", input),
    layout: (items) => ipcRenderer.invoke("desktop-workspace:layout", items),
    setInteractive: (contextId) => ipcRenderer.invoke("desktop-workspace:set-interactive", contextId),
    close: (contextId) => ipcRenderer.invoke("desktop-workspace:close", contextId),
    onState: (cb) => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("desktop-workspace:state", handler);
      return () => ipcRenderer.removeListener("desktop-workspace:state", handler);
    },
  },
  pickFolder: (current) => ipcRenderer.invoke("desktop:pick-folder", current),
  exportDiagnostics: () => ipcRenderer.invoke("desktop:export-diagnostics"),
  saveFile: (filePath) =>
    ipcRenderer.invoke("desktop:save-file", filePath).catch((error) => {
      const message = String(error?.message ?? error);
      throw new Error(message.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, ""));
    }),
  revealInFolder: (filePath) => ipcRenderer.invoke("desktop:reveal-file", filePath),
  setCredential: async (name, value) => {
    try {
      return await ipcRenderer.invoke("credential:set", name, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = message.replace(/^Error invoking remote method 'credential:set': (?:Error: )?/, "");
      throw new Error(value && detail.includes(value) ? "The key could not be saved securely. Try again." : detail);
    }
  },
  retryCredentialStore: () => ipcRenderer.invoke("credential:retry"),

  updater: {
    check: () => ipcRenderer.invoke("update:check"),
    install: (version) => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("update:install", typeof version === "string" ? version : shownUpdateVersion)
      : Promise.reject(new Error("Choose Restart to update.")),
    onState: (cb) => {
      ipcRenderer
        .invoke("update:get-state")
        .then((s) => cb(showUpdateState(s)))
        .catch(() => {});
      const handler = (_event, s) => cb(showUpdateState(s));
      ipcRenderer.on("update:state", handler);
      return () => ipcRenderer.removeListener("update:state", handler);
    },
  },
  releaseCheck: {
    setEnabled: (enabled) => ipcRenderer.invoke("release-check:set", enabled === true),
  },

  environments: {
    state: () => ipcRenderer.invoke("environments:state"),
    switch: (id) => ipcRenderer.invoke("environments:switch", id),
    addFromLink: (link, name) => ipcRenderer.invoke("environments:add-from-link", link, name),
    forget: (id) => ipcRenderer.invoke("environments:forget", id),
    onOpenSettings: (cb) => {
      const handler = (_event, computerId, panel) => cb(computerId, panel === "copy" ? "copy" : undefined);
      ipcRenderer.on("workspaces:open-settings", handler);
      return () => ipcRenderer.removeListener("workspaces:open-settings", handler);
    },
  },
  cloudAccount: process.argv.includes("--laterdog-company-desktop=1") && process.argv.includes("--laterdog-cloud-account=1") ? {
    state: () => ipcRenderer.invoke("cloud-account:state"),
    begin: () => ipcRenderer.invoke("cloud-account:begin"),
    signInAgain: () => ipcRenderer.invoke("cloud-account:signInAgain"),
    reopen: () => ipcRenderer.invoke("cloud-account:reopen"),
    cancel: () => ipcRenderer.invoke("cloud-account:cancel"),
    refresh: () => ipcRenderer.invoke("cloud-account:refresh"),
    signOut: () => ipcRenderer.invoke("cloud-account:signOut"),
    openDashboard: () => ipcRenderer.invoke("cloud-account:openDashboard"),
    connectHome: () => ipcRenderer.invoke("cloud-account:connectHome"),
    connectHomeForPhone: () => ipcRenderer.invoke("cloud-account:connectHomeForPhone"),
    sendCode: email => ipcRenderer.invoke("cloud-account:sendCode", typeof email === "string" ? email : ""),
    verifyCode: (email, code) => ipcRenderer.invoke("cloud-account:verifyCode", typeof email === "string" ? email : "", typeof code === "string" ? code : ""),
    offer: () => ipcRenderer.invoke("cloud-account:offer"),
    declineOffer: () => ipcRenderer.invoke("cloud-account:declineOffer"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("cloud-account:state-changed", handler);
      return () => ipcRenderer.removeListener("cloud-account:state-changed", handler);
    },
    lending: {
      state: () => ipcRenderer.invoke("lending:state"),
      setHome: on => ipcRenderer.invoke("lending:home", on === true),
    },
  } : undefined,
  cloudMove: process.argv.includes("--laterdog-company-desktop=1") ? {
    state: id => ipcRenderer.invoke("cloud-move:state", ...savedServer(id)),
    start: id => isLocalPage ? ipcRenderer.invoke("cloud-move:start", ...savedServer(id))
      : navigator.userActivation?.isActive === true ? ipcRenderer.invoke("cloud-move:start") : Promise.reject(new Error("Choose Copy to start copying.")),
    cancel: () => ipcRenderer.invoke("cloud-move:cancel"),
    restorePrevious: id => ipcRenderer.invoke("cloud-move:restore-previous", ...savedServer(id)),
    dismiss: id => ipcRenderer.invoke("cloud-move:dismiss", ...savedServer(id)),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("cloud-move:state-changed", handler);
      return () => ipcRenderer.removeListener("cloud-move:state-changed", handler);
    },
  } : undefined,
  cloudLending: process.argv.includes("--laterdog-company-desktop=1") && process.argv.includes("--laterdog-cloud-account=1") ? {
    open: () => ipcRenderer.invoke("cloud-lending:open"),
    state: () => ipcRenderer.invoke("cloud-lending:state"),
    setHome: on => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-lending:home", on === true) : Promise.reject(new Error("Choose the switch to change this.")),
  } : undefined,
  cloudPermissions: process.argv.includes("--laterdog-company-desktop=1") && process.argv.includes("--laterdog-cloud-account=1") ? {
    status: () => ipcRenderer.invoke("cloud-permissions:status"),
    request: permission => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-permissions:request", permission) : Promise.reject(new Error("Choose Allow to ask macOS.")),
    openSettings: permission => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-permissions:open-settings", permission) : Promise.reject(new Error("Choose Open Settings to open System Settings.")),
  } : undefined,
  cloudPlan: process.argv.includes("--laterdog-company-desktop=1") && process.argv.includes("--laterdog-cloud-account=1") ? {
    state: () => ipcRenderer.invoke("cloud-plan:state"),
    manage: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:manage") : Promise.reject(new Error("Choose Manage to open your Plan page.")),
    signOut: () => isLocalPage || navigator.userActivation?.isActive === true
      ? ipcRenderer.invoke("cloud-plan:signOut") : Promise.reject(new Error("Choose Sign out to sign out.")),
  } : undefined,
  organization: process.argv.includes("--laterdog-company-desktop=1") ? {
    defaultPortalOrigin: process.argv.find((arg) => arg.startsWith("--laterdog-admin-origin="))?.slice("--laterdog-admin-origin=".length) ?? "",
    settingsOpened: () => ipcRenderer.invoke("organization:settings-opened"),
    state: () => ipcRenderer.invoke("organization:state"),
    begin: input => ipcRenderer.invoke("organization:begin", input),
    reopen: () => ipcRenderer.invoke("organization:reopen"),
    cancelEnrollment: () => ipcRenderer.invoke("organization:cancel"),
    refresh: () => ipcRenderer.invoke("organization:refresh"),
    disconnect: () => ipcRenderer.invoke("organization:disconnect"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("organization:state-changed", handler);
      return () => ipcRenderer.removeListener("organization:state-changed", handler);
    },
  } : undefined,
  companyBackups: process.argv.includes("--laterdog-company-desktop=1") ? {
    state: () => ipcRenderer.invoke("company-backups:state"),
    list: () => ipcRenderer.invoke("company-backups:list"),
    create: input => ipcRenderer.invoke("company-backups:create", input),
    configureSchedule: input => ipcRenderer.invoke("company-backups:configure-schedule", input),
    prepareRestore: input => ipcRenderer.invoke("company-backups:preview", input),
    restore: input => ipcRenderer.invoke("company-backups:restore", input),
    delete: input => ipcRenderer.invoke("company-backups:delete", input),
    cancel: () => ipcRenderer.invoke("company-backups:cancel"),
    onState: cb => {
      const handler = (_event, state) => cb(state);
      ipcRenderer.on("company-backups:state-changed", handler);
      return () => ipcRenderer.removeListener("company-backups:state-changed", handler);
    },
  } : undefined,
  computerSharing: {
    state: id => ipcRenderer.invoke("sharing:state", id),
    chooseFolder: () => ipcRenderer.invoke("sharing:folder"),
    save: (id, grant) => ipcRenderer.invoke("sharing:save", id, grant),
    revoke: id => ipcRenderer.invoke("sharing:revoke", id),
    activity: id => ipcRenderer.invoke("sharing:activity", id),
  },
  confirm: message => ipcRenderer.invoke("dialog:confirm", message),
};

contextBridge.exposeInMainWorld(
  "laterdog",
  isLocalPage ? bridge : Object.fromEntries(Object.entries(bridge).filter(([key]) => remoteKeys.has(key))),
);
