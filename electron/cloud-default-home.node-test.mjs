import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import environments from "./environments.cjs";
import { createCloudOffer, leaveHomeNow, parseOffer } from "./cloud-default-home.mjs";
import { devSessionItems } from "./dev-session-menu.mjs";

const HOME = "https://home.fixture.test";
const connected = (machine = { status: "ready", origin: HOME }) => ({ status: "connected", account: { id: "a", email: "a@b.test" }, machine });

const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");

function homeObserver(activeId = "local") {
  const calls = [];
  const home = { id: "cloud-1", name: "My Cloud", origin: HOME };
  const custom = { id: "custom", name: "Another workspace", origin: "https://custom.fixture.test" };
  const context = vm.createContext({
    environmentsState: { activeId, environments: [home, custom] },
    CLOUD_HOME_NAME: "My Cloud", LOCAL_ID: "local", leaveHomeNow,
    withoutEnvironment: environments.withoutEnvironment,
    withActive: environments.withActive,
    cloudOfferState: () => ({ signedIn: () => calls.push("signed-in") }),
    cloudAutoMove: { stop: () => calls.push("stop-copy") }, homeRetry: { stop: () => calls.push("stop-retry") },
    connectCloudHome: () => { calls.push("connect-home"); return Promise.resolve(); },
    syncCloudWindow: () => { calls.push("sync-window"); return Promise.resolve(); },
    sharingController: () => ({ forget: () => calls.push("forget-home") }),
    activeOrigin: () => context.environmentsState.activeId === "local" ? "http://127.0.0.1:8799" : "https://custom.fixture.test",
    persistEnvironments: next => { context.environmentsState = next; },
    navigateMainWindow: () => calls.push("navigate"),
    session: { defaultSession: { fetch: async () => ({ ok: true }), clearStorageData: async () => {} } },
    AbortSignal, slog: message => calls.push(message),
  });
  vm.runInContext(source.slice(source.indexOf("function observeCloudHome("), source.indexOf("function ensureManagedDesktop(")), context);
  return { context, calls, home };
}

for (const activeId of ["local", "custom", "cloud-1"]) {
  test(`account refresh hands every state to the window controller and does not navigate itself (${activeId})`, () => {
    const { context, calls } = homeObserver(activeId);
    const before = JSON.stringify(context.environmentsState);
    for (const state of [connected(), connected({ status: "provisioning" }), connected(), { status: "unavailable", account: { id: "a" } }]) context.observeCloudHome(state);
    assert.equal(JSON.stringify(context.environmentsState), before);
    assert.deepEqual(calls, ["signed-in", "sync-window", "signed-in", "sync-window", "signed-in", "sync-window", "sync-window"]);
  });
}

for (const activeId of ["local", "custom", "cloud-1"]) {
  test(`sign-out only navigates if the removed Cloud connection was active (${activeId})`, async () => {
    const { context, calls, home } = homeObserver(activeId);
    await context.leaveCloudHome(home);
    assert.equal(context.environmentsState.activeId, activeId === "cloud-1" ? "local" : activeId);
    assert.equal(context.environmentsState.environments.length, 1);
    assert.equal(context.environmentsState.environments[0].id, "custom");
    assert.equal(calls.includes("navigate"), activeId === "cloud-1");
  });
}

test("sign-out forgets a saved Cloud connection, but quiet restoration does not", () => {
  const entry = { id: "cloud-1" };
  assert.equal(leaveHomeNow({ state: { status: "signed-out" }, homeEntry: entry }), true);
  assert.equal(leaveHomeNow({ state: { status: "signed-out", message: "restoring" }, homeEntry: entry }), false);
  assert.equal(leaveHomeNow({ state: { status: "signed-out" }, homeEntry: null }), false);
  assert.equal(leaveHomeNow({ state: connected(), homeEntry: entry }), false);
  assert.equal(leaveHomeNow({ state: { status: "reauth-required", account: { id: "a" } }, homeEntry: entry }), false);
  assert.equal(leaveHomeNow({ state: { status: "unavailable", message: "restore-failed" }, homeEntry: entry }), false);
});

test("the application menu is built without any server selection hooks", () => {
  let options;
  const context = vm.createContext({
    Menu: { setApplicationMenu: () => {} },
    buildApplicationMenu: value => { options = value; return value; },
    devSessionItems, quitWithCode: () => {}, app: { name: "later.dog" }, process: { env: {} },
    environmentsState: { activeId: "cloud-1", environments: [{ id: "cloud-1", name: "My Cloud", origin: HOME }] },
    cloudAccount: { state: connected }, mainWindow: null,
  });
  vm.runInContext(source.slice(source.indexOf("function refreshApplicationMenu("), source.indexOf("function currentWindowTitle(")), context);
  context.refreshApplicationMenu();
  assert.deepEqual(Object.keys(options), ["onOpenSettings", "sessionItems"]);
  assert.deepEqual(options.sessionItems, []);
});

test("the sign-in screen is offered once: a Mac that said not now, or signed in, is never asked again", () => {
  const files = { value: null };
  const offer = createCloudOffer({ read: () => files.value, write: contents => { files.value = contents; }, now: () => 1_800_000_000_000 });
  assert.equal(offer.due(), true);
  offer.decline();
  assert.equal(offer.due(), false);
  assert.deepEqual(parseOffer(files.value), { answeredAt: 1_800_000_000_000, answer: "not-now" });
  offer.signedIn();
  assert.equal(parseOffer(files.value).answer, "signed-in");
  assert.equal(offer.due(), false);
  assert.equal(parseOffer("garbage"), null);
  const unreadable = createCloudOffer({ read: () => { throw new Error("no file"); }, write() {} });
  assert.equal(unreadable.due(), true);
});
