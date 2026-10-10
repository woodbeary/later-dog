import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import environments from "./environments.cjs";
import localOrigin from "./local-origin.cjs";

const PERSONAL = "http://127.0.0.1:48995";
const BUSINESS = "http://127.0.0.1:8811";
const REMOTE = "https://workspace.example.test";
const BUSINESS_ID = "p00000000000a";
const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Profile wiring section moved: ${start}`);
  return source.slice(from, to);
}

function block(start) {
  return `${section(start, "\n}\n")}\n}\n`;
}

const plain = (value) => JSON.parse(JSON.stringify(value));

function fixture({ showing = PERSONAL, open = "main", status = "running", mainName = "", serverReady = true, remote = false } = {}) {
  const calls = [];
  const state = { activeId: open };
  const frame = { url: `${showing}/` };
  const contents = { mainFrame: frame, getURL: () => frame.url, send: (...args) => calls.push(["send", ...args]) };
  const mainWindow = { webContents: contents, isDestroyed: () => false, loadURL: async (url) => calls.push(["load", url]) };
  let context;
  const profiles = {
    list: () => ({
      activeId: state.activeId,
      canAdd: true,
      profiles: [
        { id: "main", name: mainName, main: true, status: "running" },
        { id: BUSINESS_ID, name: "Business", main: false, status },
      ],
    }),
    activeId: () => state.activeId,
    activeOrigin: () => (state.activeId === "main" ? null : BUSINESS),
    usePersonal: () => {
      calls.push(["usePersonal"]);
      state.activeId = "main";
      context.profilesChanged();
    },
  };
  localOrigin.setLocalOrigin(PERSONAL);
  localOrigin.setProfileOrigin(() => profiles.activeOrigin());
  context = vm.createContext({
    URL,
    profiles,
    mainWindow,
    rendererOrigin: () => PERSONAL,
    desktopDataDir: () => "/fixture/.laterdog",
    activeEnvironment: environments.activeEnvironment,
    workspaceSenderAllowed: environments.workspaceSenderAllowed,
    senderIsLocal: localOrigin.isLocalSender,
    isProfileSender: localOrigin.isProfileSender,
    environmentsState: remote
      ? { activeId: "remote", environments: [{ id: "remote", origin: REMOTE, name: "Remote" }] }
      : { activeId: "local", environments: [] },
    app: { isPackaged: true },
    serverReady,
    serverStartConflictOnly: false,
    serverUnavailableWindows: new Set(),
    buildErrorPage: () => "data:text/html,unavailable",
    navigateMainWindow: (url) => calls.push(["navigate", url]),
    dialog: {
      showMessageBox: async (options) => {
        calls.push(["dialog", plain(options)]);
        return { response: 0 };
      },
    },
  });
  vm.runInContext(section("function activeOrigin() {", "function syncProfileMutationToken("), context, {
    filename: "main.mjs (profile wiring fixture)",
  });
  return { calls, context, contents, frame, mainWindow, profiles, event: { sender: contents, senderFrame: frame } };
}

test("the window moves to the open profile's page and stays put once it is there", () => {
  const f = fixture({ open: BUSINESS_ID });
  f.context.showActive();
  assert.deepEqual(f.calls, [["navigate", BUSINESS]]);
  f.calls.length = 0;
  f.frame.url = `${BUSINESS}/threads/1`;
  f.context.showActive();
  assert.deepEqual(f.calls, []);
});

test("a server shown in the window keeps it, whichever profile is open", () => {
  const f = fixture({ showing: REMOTE, open: BUSINESS_ID, remote: true });
  assert.equal(f.context.activeOrigin(), REMOTE);
  assert.equal(f.context.localPageOrigin(), BUSINESS);
  f.context.showActive();
  assert.deepEqual(f.calls, []);
});

test("going back to Personal while its server is down shows the unavailable page", () => {
  const f = fixture({ showing: BUSINESS, serverReady: false });
  f.context.showActive();
  assert.deepEqual(f.calls, [["load", "data:text/html,unavailable"]]);
  assert.equal(f.context.serverUnavailableWindows.has(f.mainWindow), true);
});

test("a stopped profile hands the window back to Personal with one notice", () => {
  for (const [mainName, shown] of [["", "Personal"], ["Home", "Home"]]) {
    const f = fixture({ showing: BUSINESS, open: BUSINESS_ID, status: "failed", mainName });
    f.context.profilesChanged();
    assert.deepEqual(f.calls.map(([kind]) => kind), ["send", "usePersonal", "navigate", "dialog"]);
    assert.equal(f.calls[0][1], "profiles:changed");
    assert.equal(f.calls[2][1], PERSONAL);
    assert.equal(f.calls[3][1].message, "Business stopped");
    assert.equal(f.calls[3][1].detail, `Showing ${shown} instead. Choose Business again from the menu under your name to try again.`);
  }
});

test("while a server is shown, a stopped profile leaves the window alone", () => {
  const f = fixture({ showing: REMOTE, open: BUSINESS_ID, status: "failed", remote: true });
  f.context.profilesChanged();
  assert.deepEqual(f.calls, []);
});

test("profile changes reach the open local page and no other", () => {
  const f = fixture();
  f.context.profilesChanged();
  assert.deepEqual(f.calls.map(([kind, channel]) => [kind, channel]), [["send", "profiles:changed"]]);
  assert.equal(f.calls[0][2].activeId, "main");
  for (const options of [{ showing: BUSINESS }, { showing: REMOTE, remote: true }, { showing: "about:blank" }]) {
    const other = fixture(options);
    other.context.profilesChanged();
    assert.deepEqual(other.calls, []);
  }
});

test("only the window's own page may switch, and only the open profile's page counts as a profile", () => {
  const personal = fixture();
  assert.equal(personal.context.profileSwitcherSender(personal.event), true);
  assert.equal(personal.context.profilePageSender(personal.event), false);
  const business = fixture({ showing: BUSINESS, open: BUSINESS_ID });
  assert.equal(business.context.profileSwitcherSender(business.event), true);
  assert.equal(business.context.profilePageSender(business.event), true);
  const child = { sender: business.contents, senderFrame: { url: `${BUSINESS}/embedded` } };
  const otherWindow = { sender: { mainFrame: business.frame }, senderFrame: business.frame };
  for (const event of [child, otherWindow, { sender: business.contents }]) {
    assert.equal(business.context.profileSwitcherSender(event), false);
    assert.equal(business.context.profilePageSender(event), false);
  }
  const closed = fixture({ showing: BUSINESS });
  assert.equal(closed.context.profileSwitcherSender(closed.event), false);
  assert.equal(closed.context.askingProfile(closed.event), false);
  const remote = fixture({ showing: REMOTE, open: BUSINESS_ID, remote: true });
  assert.equal(remote.context.profileSwitcherSender(remote.event), false);
});

test("a build without profiles keeps every page on Personal", () => {
  const f = fixture({ showing: BUSINESS, open: BUSINESS_ID });
  f.context.profiles = null;
  assert.equal(f.context.localPageOrigin(), PERSONAL);
  assert.equal(f.context.askingProfile(f.event), false);
  f.context.profilesChanged();
  assert.deepEqual(f.calls, []);
});

test("opening Personal's settings from a profile's page switches the window to Personal first", () => {
  const f = fixture({ showing: BUSINESS, open: BUSINESS_ID });
  Object.assign(f.context, {
    LOCAL_ID: "local",
    withActive: (state, id) => ({ ...state, activeId: id }),
    persistEnvironments: (state) => f.calls.push(["persist", state.activeId]),
  });
  vm.runInContext(block("function openWorkspaceSettings("), f.context);
  f.context.openWorkspaceSettings("vps", "copy");
  assert.deepEqual(f.calls, [["usePersonal"], ["persist", "local"], ["navigate", `${PERSONAL}/?desktop-settings=workspaces&copy-to=vps`]]);
  assert.equal(f.context.localPageOrigin(), PERSONAL);
  const personal = fixture();
  vm.runInContext(block("function openWorkspaceSettings("), personal.context);
  personal.context.openWorkspaceSettings("vps", "copy");
  assert.deepEqual(personal.calls, [["send", "workspaces:open-settings", "vps", "copy"]]);
});

test("the desktop's token goes only to Personal's server and to running profiles' servers", () => {
  let listener;
  const running = { value: true };
  const context = vm.createContext({
    URL,
    session: { defaultSession: { webRequest: { onBeforeSendHeaders: (handler) => { listener = handler; } } } },
    serverReady: true,
    SERVER_PORT: 48995,
    DESKTOP_MUTATION_HEADER: "x-fixture-desktop",
    desktopMutationToken: "fixture-token",
    profiles: { ownsPort: (port) => port === 8811 && running.value },
  });
  vm.runInContext(`${block("function installDesktopMutationHeader() {")}\ninstallDesktopMutationHeader();`, context);
  const tokenFor = (url) => {
    let headers;
    listener({ url, requestHeaders: { accept: "*/*" } }, ({ requestHeaders }) => {
      headers = plain(requestHeaders);
    });
    assert.equal(headers.accept, "*/*");
    return headers["x-fixture-desktop"] ?? null;
  };
  assert.equal(tokenFor(`${PERSONAL}/api/config`), "fixture-token");
  assert.equal(tokenFor(`${BUSINESS}/api/config`), "fixture-token");
  for (const url of ["http://127.0.0.1:8813/api/config", "http://localhost:8811/api/config", "https://127.0.0.1:8811/api/config", `${REMOTE}/api/config`, "not a url"]) {
    assert.equal(tokenFor(url), null, url);
  }
  running.value = false;
  assert.equal(tokenFor(`${BUSINESS}/api/config`), null);
  context.profiles = null;
  assert.equal(tokenFor(`${PERSONAL}/api/config`), "fixture-token");
  context.serverReady = false;
  assert.equal(tokenFor(`${PERSONAL}/api/config`), null);
});

function ipcFixture(options) {
  const f = fixture(options);
  const handlers = new Map(), saved = [];
  Object.assign(f.profiles, {
    activeCredentialStore: () => "unavailable",
    activeProcess: () => (f.context.profileProcess ?? null),
    saveCredential: async (...args) => {
      saved.push(["profile", ...plain(args)]);
      return { ok: true };
    },
  });
  Object.assign(f.context, {
    process: { platform: "fixture", env: {} },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly,
    cuaReady: Promise.resolve(null),
    credentialStoreUnavailable: false,
    desktopCapabilities: (capabilities) => plain(capabilities),
    CREDENTIAL_PATCH: { xaiApiKey: (value) => ({ xai: { key: value } }) },
    safeStorage: { isAsyncEncryptionAvailable: async () => f.context.encryption !== false },
    saveWorkspaceCredential: async (...args) => {
      saved.push(["personal", ...args]);
      return { ok: true };
    },
    serverProc: "personal-server",
    profileProcess: "business-server",
    trustedApprovalMode: { request: (proc, ...args) => [proc, ...plain(args)] },
  });
  vm.runInContext(
    section('ipcMain.handle("desktop:capabilities"', "registerProfileIpc(") +
      section("async function saveProfileCredential(", "async function broadcastDesktopCapabilities()"),
    f.context,
  );
  return { ...f, handlers, saved };
}

test("a profile's keys and approval grants go to that profile, and Personal's stay with Personal", async () => {
  const business = ipcFixture({ showing: BUSINESS, open: BUSINESS_ID });
  await business.handlers.get("credential:set")(business.event, "xaiApiKey", " xai-fixture ");
  assert.deepEqual(business.saved, [["profile", BUSINESS_ID, "xaiApiKey", " xai-fixture ", { xai: { key: "xai-fixture" } }]]);
  assert.deepEqual(business.handlers.get("approvals:set-trusted-mode")(business.event, "bot-1", "full", {}), ["business-server", "bot-1", "full", {}]);
  await assert.rejects(business.handlers.get("credential:set")(business.event, "unknownKey", "x"), /Unsupported credential/);
  business.context.encryption = false;
  await assert.rejects(business.handlers.get("credential:set")(business.event, "xaiApiKey", "x"), /credential store is unavailable/);
  business.context.profileProcess = null;
  assert.throws(() => business.handlers.get("approvals:set-trusted-mode")(business.event, "bot-1", "full", {}), /require the embedded desktop server/);
  assert.equal(business.saved.length, 1);

  const personal = ipcFixture();
  await personal.handlers.get("credential:set")(personal.event, "xaiApiKey", "xai-personal");
  assert.deepEqual(personal.saved, [["personal", "xaiApiKey", "xai-personal"]]);
  assert.deepEqual(personal.handlers.get("approvals:set-trusted-mode")(personal.event, "bot-1", "full", {}), ["personal-server", "bot-1", "full", {}]);

  const remote = ipcFixture({ showing: REMOTE, open: BUSINESS_ID, remote: true });
  assert.throws(() => remote.handlers.get("credential:set")(remote.event, "xaiApiKey", "x"), /only available/);
  assert.throws(() => remote.handlers.get("approvals:set-trusted-mode")(remote.event, "bot-1", "full", {}), /only available/);
  assert.deepEqual(remote.saved, []);
});

test("the open profile's page hears about this Mac as a local page, with its own key store", async () => {
  const business = ipcFixture({ showing: BUSINESS, open: BUSINESS_ID });
  const forBusiness = await business.handlers.get("desktop:capabilities")(business.event);
  assert.equal(forBusiness.remote, false);
  assert.equal(forBusiness.credentialStore, "unavailable");
  const personal = ipcFixture();
  const forPersonal = await personal.handlers.get("desktop:capabilities")(personal.event);
  assert.equal(forPersonal.remote, false);
  assert.equal(forPersonal.credentialStore, "ok");
  const remote = ipcFixture({ showing: REMOTE, open: BUSINESS_ID, remote: true });
  assert.equal((await remote.handlers.get("desktop:capabilities")(remote.event)).remote, true);
});
