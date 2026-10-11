import assert from "node:assert/strict";
import { test } from "node:test";
import { PROFILE_IPC_CHANNELS, registerProfileIpc } from "./laterdog-profile-ipc.mjs";

function setup({ allowed = true, page = true, runner } = {}) {
  const handlers = new Map();
  const listeners = new Map();
  const calls = [];
  let shown = 0;
  const list = () => ({ activeId: "main", canAdd: true, profiles: [{ id: "main", name: "", main: true, status: "running" }] });
  const fake = runner === undefined
    ? {
        list,
        add: async (name) => {
          calls.push(["add", name]);
          return { id: "p00000000000a", ready: true };
        },
        switchTo: async (id) => {
          calls.push(["switchTo", id]);
          if (id !== "main" && id !== "p00000000000a") throw new Error("That profile no longer exists");
          return { id };
        },
        rename: (id, name) => {
          calls.push(["rename", id, name]);
          return list();
        },
        remove: async (id) => {
          calls.push(["remove", id]);
          return list();
        },
      }
    : runner;
  registerProfileIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      on: (channel, handler) => listeners.set(channel, handler),
    },
    runner: () => fake,
    isPage: () => {
      if (page === "throws") throw new Error("no window");
      return page;
    },
    senderAllowed: () => allowed,
    showActive: () => {
      shown++;
    },
  });
  return { handlers, listeners, calls, shown: () => shown };
}

const event = {};

test("each profile action has its own channel", () => {
  const { handlers, listeners } = setup();
  assert.deepEqual([...handlers.keys()], PROFILE_IPC_CHANNELS);
  assert.deepEqual([...listeners.keys()], ["profiles:page"]);
});

test("the preload's question gets a plain yes or no", () => {
  for (const [page, expected] of [[true, true], [false, false], ["yes", false], ["throws", false]]) {
    const { listeners } = setup({ page });
    const asked = {};
    listeners.get("profiles:page")(asked);
    assert.equal(asked.returnValue, expected);
  }
});

test("adding names the new profile and hands back the list", async () => {
  const { handlers, calls } = setup();
  const result = await handlers.get("profiles:add")(event, "Business");
  assert.deepEqual(result.added, { id: "p00000000000a", ready: true });
  assert.equal(result.activeId, "main");
  await handlers.get("profiles:add")(event, { name: "Business" });
  assert.deepEqual(calls, [["add", "Business"], ["add", ""]]);
});

test("switching shows the profile now open, and only after it is ready", async () => {
  const { handlers, calls, shown } = setup();
  await handlers.get("profiles:switch")(event, "p00000000000a");
  assert.equal(shown(), 1);
  await assert.rejects(handlers.get("profiles:switch")(event, "p0000000000ff"), /no longer exists/);
  assert.equal(shown(), 1);
  await assert.rejects(handlers.get("profiles:switch")(event, 42), /no longer exists/);
  assert.deepEqual(calls.map(([, id]) => id), ["p00000000000a", "p0000000000ff", ""]);
});

test("renaming and removing pass only text through", async () => {
  const { handlers, calls } = setup();
  await handlers.get("profiles:rename")(event, "p00000000000a", "Business 2");
  await handlers.get("profiles:rename")(event, null, ["x"]);
  await handlers.get("profiles:remove")(event, "p00000000000a");
  await handlers.get("profiles:remove")(event, { id: "p00000000000a" });
  assert.deepEqual(calls, [
    ["rename", "p00000000000a", "Business 2"],
    ["rename", "", ""],
    ["remove", "p00000000000a"],
    ["remove", ""],
  ]);
});

test("another window or page, or a build without profiles, gets nothing", async () => {
  for (const options of [{ allowed: false }, { runner: null }]) {
    const { handlers, calls, shown } = setup(options);
    for (const channel of PROFILE_IPC_CHANNELS) {
      await assert.rejects(handlers.get(channel)(event, "p00000000000a", "Business"), /only available in this app's window/);
    }
    assert.deepEqual(calls, []);
    assert.equal(shown(), 0);
  }
});
