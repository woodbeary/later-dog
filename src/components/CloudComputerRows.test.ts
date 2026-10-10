// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudComputer, CloudComputerList } from "./CloudComputerRows";

const fixture = vi.hoisted(() => ({
  lists: [] as Array<CloudComputerList | { error: string; status: number }>,
  posts: [] as Array<{ url: string; body: unknown }>,
  confirm: true,
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { box: { configured: true } } } }) }));
vi.mock("./ApiKeys", () => ({ CloudComputersRow: () => createElement("div", { "data-key-row": "" }) }));
vi.mock("./CloudTrial", () => ({ CloudTrialRow: () => null }));

const { CloudComputerRows, cloudComputerState, mergeCloudComputers } = await import("./CloudComputerRows");

const computer = (patch: Partial<CloudComputer> = {}): CloudComputer => ({
  boxId: "box-1", name: "laterdog-scout", state: "archived", ownerBotId: "scout", ownerName: "Scout", orphaned: false, inUse: false, ...patch,
});
const list = (instances: CloudComputer[], patch: Partial<CloudComputerList> = {}): CloudComputerList => ({
  configured: true, available: true, problem: null, instances, ...patch,
});

let root: Root | null = null;
const flush = async () => {
  for (let i = 0; i < 20; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  }
};
const mount = async () => {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  flushSync(() => root!.render(createElement(CloudComputerRows)));
  await flush();
};
const text = () => document.body.textContent ?? "";
const deleteButton = (boxId: string) => document.querySelector<HTMLButtonElement>(`[data-cloud-computer-delete="${boxId}"]`);

beforeEach(() => {
  fixture.lists = [];
  fixture.posts = [];
  fixture.confirm = true;
  vi.stubGlobal("confirm", () => fixture.confirm);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      fixture.posts.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 202 });
    }
    const next = fixture.lists.length > 1 ? fixture.lists.shift()! : fixture.lists[0];
    if (next && "error" in next) return new Response(JSON.stringify({ error: next.error }), { status: next.status });
    return new Response(JSON.stringify(next ?? list([])), { status: 200 });
  }));
});
afterEach(() => {
  root?.unmount();
  root = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a cloud computer's state", () => {
  it("reads in a word or two", () => {
    expect(cloudComputerState(computer({ state: "running", inUse: true }))).toBe("In use");
    expect(cloudComputerState(computer({ state: "removing" }))).toBe("Removing");
    expect(["archived", "stopped"].map((state) => cloudComputerState(computer({ state })))).toEqual(["Sleeping", "Sleeping"]);
    expect(["archiving", "stopping"].map((state) => cloudComputerState(computer({ state })))).toEqual(["Going to sleep", "Going to sleep"]);
    expect(["idle", "ready", "running"].map((state) => cloudComputerState(computer({ state })))).toEqual(["Running", "Running", "Running"]);
    expect(cloudComputerState(computer({ state: "provisioning" }))).toBe("Starting");
    expect(cloudComputerState(computer({ state: "error" }))).toBe("Needs attention");
  });
});

describe("merging a fresh read", () => {
  const previous = [computer()];

  it("keeps the last list when Boat is out or the key is gone", () => {
    expect(mergeCloudComputers(list([], { available: false, problem: "down" }), previous, new Set())).toBe(previous);
    expect(mergeCloudComputers(list([], { configured: false }), previous, new Set())).toBe(previous);
  });

  it("takes Boat's list, with a computer whose delete is settling read as Removing", () => {
    const fresh = [computer(), computer({ boxId: "box-2", ownerName: "Bo" })];
    expect(mergeCloudComputers(list(fresh), previous, new Set(["box-2"])).map(({ boxId, state }) => [boxId, state]))
      .toEqual([["box-1", "archived"], ["box-2", "removing"]]);
    expect(mergeCloudComputers(list([]), previous, new Set())).toEqual([]);
  });
});

describe("Settings → Computer → Cloud computers", () => {
  it("names each computer by its dog, says when one is left over, and holds Delete while one is in use", async () => {
    fixture.lists = [list([
      computer(),
      computer({ boxId: "box-2", name: "laterdog-old", ownerBotId: null, ownerName: null, orphaned: true, state: "stopped" }),
      computer({ boxId: "box-3", ownerName: "Bo", state: "running", inUse: true }),
    ])];
    await mount();
    expect(text()).toContain("ScoutSleeping");
    expect(text()).toContain("Left over from a removed dogSleeping");
    expect(text()).toContain("BoIn use · Stop this dog's work before changing its computer.");
    expect(deleteButton("box-1")!.disabled).toBe(false);
    expect(deleteButton("box-3")!.disabled).toBe(true);
    expect(document.querySelector("[data-key-row]")).not.toBeNull();
  });

  it("says when there are none, and when Boat can't list them", async () => {
    fixture.lists = [list([])];
    await mount();
    expect(text()).toContain("No cloud computers yet.");
    root!.unmount();
    document.body.innerHTML = "";

    fixture.lists = [list([], { available: false, problem: null })];
    await mount();
    expect(text()).toContain("Can't list your cloud computers right now.");
    expect(text()).not.toContain("No cloud computers yet.");
  });

  it("deletes after the person confirms, reads Removing, and drops the row once Boat's list does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fixture.lists = [list([computer()]), list([computer()]), list([])];
    await mount();
    flushSync(() => deleteButton("box-1")!.click());
    await flush();
    expect(fixture.posts).toEqual([{ url: "/api/computers/boxes/box-1/delete", body: { confirmName: "laterdog-scout" } }]);
    expect(text()).toContain("Removing");
    expect(deleteButton("box-1")!.disabled).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(text()).toContain("Removing");
    await vi.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(deleteButton("box-1")).toBeNull();
    expect(text()).toContain("No cloud computers yet.");
  });

  it("deletes nothing when the person cancels", async () => {
    fixture.lists = [list([computer()])];
    fixture.confirm = false;
    await mount();
    flushSync(() => deleteButton("box-1")!.click());
    await flush();
    expect(fixture.posts).toEqual([]);
    expect(text()).toContain("ScoutSleeping");
  });
});
