import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
const personal = "http://127.0.0.1:48992";

function load({ origin = personal, profilePage = false, updater = false, profiles = true, throws = false } = {}) {
  const invoked = [];
  const listeners = new Map();
  const asked = [];
  let bridge;
  const context = vm.createContext({
    process: { platform: "fixture", argv: [`--laterdog-local-origin=${personal}`, ...(profiles ? ["--laterdog-profiles=1"] : [])] },
    location: { origin },
    TextEncoder,
    localStorage: { getItem: () => null },
    queueMicrotask,
    require: (name) => {
      assert.equal(name, "electron");
      return {
        webUtils: { getPathForFile: () => "" },
        contextBridge: { exposeInMainWorld: (_key, value) => { bridge = value; } },
        ipcRenderer: {
          on: (channel, handler) => listeners.set(channel, handler),
          removeListener: (channel) => listeners.delete(channel),
          send: () => undefined,
          sendSync: (channel) => {
            asked.push(channel);
            if (throws) throw new Error("no answer");
            if (channel === "profiles:page") return profilePage;
            if (channel === "update:offered") return updater;
            return undefined;
          },
          invoke: (...args) => { invoked.push(args); return Promise.resolve(null); },
        },
      };
    },
  });
  vm.runInContext(source, context);
  return { bridge, invoked, listeners, asked };
}

const PERSONAL_ONLY = [
  "remoteClient", "companion", "routines", "companionAccount", "localControl", "androidDevice",
  "desktopViewer", "desktopWorkspace", "environments", "cloudAccount", "cloudMove", "cloudLending",
  "cloudPlan", "organization", "companyBackups", "computerSharing",
];

test("Personal's page gets the whole bridge, profiles included, without asking main", () => {
  const { bridge, asked } = load();
  assert.equal(typeof bridge.profiles.switch, "function");
  assert.equal(typeof bridge.environments.switch, "function");
  assert.deepEqual(asked, []);
});

test("the open profile's page gets its own desktop features and nothing Personal-only", () => {
  const { bridge, asked } = load({ origin: "http://127.0.0.1:8811", profilePage: true });
  assert.deepEqual(asked, ["profiles:page"]);
  for (const key of ["profiles", "setCredential", "saveFile", "revealInFolder", "approvals", "speechStart", "permissions", "updater", "confirm", "workspaces"]) {
    assert.ok(key in bridge, `${key} should reach a profile`);
  }
  for (const key of PERSONAL_ONLY) assert.equal(key in bridge, false, `${key} must stay Personal-only`);
});

test("a server's page that main does not name as the open profile keeps the remote subset", () => {
  for (const options of [{ profilePage: false }, { throws: true }]) {
    const { bridge } = load({ origin: "https://remote.invalid", ...options });
    assert.equal("profiles" in bridge, false);
    assert.equal("setCredential" in bridge, false);
    assert.equal("saveFile" in bridge, false);
    assert.equal(typeof bridge.getCapabilities, "function");
  }
  const offered = load({ origin: "https://remote.invalid", updater: true });
  assert.deepEqual(offered.asked, ["profiles:page", "update:offered"]);
  assert.equal(typeof offered.bridge.updater.check, "function");
});

test("the profiles bridge forwards each call over its own channel", async () => {
  const { bridge, invoked, listeners } = load();
  await bridge.profiles.list();
  await bridge.profiles.add("Business");
  await bridge.profiles.switch("p00000000000a");
  await bridge.profiles.rename("p00000000000a", "Business 2");
  await bridge.profiles.remove("p00000000000a");
  assert.deepEqual(invoked, [
    ["profiles:list"],
    ["profiles:add", "Business"],
    ["profiles:switch", "p00000000000a"],
    ["profiles:rename", "p00000000000a", "Business 2"],
    ["profiles:remove", "p00000000000a"],
  ]);
  const seen = [];
  const stop = bridge.profiles.onChanged((state) => seen.push(state));
  listeners.get("profiles:changed")({}, { activeId: "main" });
  assert.deepEqual(seen, [{ activeId: "main" }]);
  stop();
  assert.equal(listeners.has("profiles:changed"), false);
});

test("builds without profiles show no switcher", () => {
  assert.equal(load({ profiles: false }).bridge.profiles, undefined);
});
