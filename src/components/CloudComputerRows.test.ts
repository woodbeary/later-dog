// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudComputer, CloudComputerList } from "./CloudComputerRows";

const fixture = vi.hoisted(() => ({
  lists: [] as Array<CloudComputerList | { error: string; status: number }>,
  posts: [] as Array<{ url: string; body: unknown }>,
  postReply: null as { status: number; body: Record<string, unknown> } | null,
  confirm: true,
  bots: [] as Array<{ id: string; name: string; color: string }>,
}));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { box: { configured: true } }, bots: fixture.bots } }) }));
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
const sleepButton = (boxId: string) => document.querySelector<HTMLButtonElement>(`[data-cloud-computer-sleep="${boxId}"]`);
const row = (boxId: string) => document.querySelector<HTMLElement>(`[data-cloud-computer="${boxId}"]`)!;

beforeEach(() => {
  fixture.lists = [];
  fixture.posts = [];
  fixture.postReply = null;
  fixture.confirm = true;
  fixture.bots = [];
  vi.stubGlobal("confirm", () => fixture.confirm);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      fixture.posts.push({ url, body: JSON.parse(String(init.body)) });
      if (fixture.postReply) return new Response(JSON.stringify(fixture.postReply.body), { status: fixture.postReply.status });
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

describe("putting a cloud computer to sleep from Settings", () => {
  it("offers Sleep only on an awake computer, and holds it while a dog is using it", async () => {
    fixture.lists = [list([
      computer({ state: "running" }),
      computer({ boxId: "box-2", ownerName: "Bo", state: "running", inUse: true }),
      computer({ boxId: "box-3", ownerName: "Ada", state: "archived" }),
      computer({ boxId: "box-4", ownerName: "Cy", state: "provisioning" }),
    ])];
    await mount();
    expect(sleepButton("box-1")!.disabled).toBe(false);
    expect(sleepButton("box-1")!.textContent).toBe("Sleep");
    expect(sleepButton("box-2")!.disabled).toBe(true);
    expect(sleepButton("box-3")).toBeNull();
    expect(sleepButton("box-4")).toBeNull();
  });

  it("asks the server to put it to sleep, without a confirm, and reads Sleeping once the list does", async () => {
    fixture.lists = [list([computer({ state: "running" })]), list([computer({ state: "archived" })])];
    fixture.confirm = false;
    await mount();
    flushSync(() => sleepButton("box-1")!.click());
    await flush();
    expect(fixture.posts).toEqual([{ url: "/api/computers/boxes/box-1/sleep", body: {} }]);
    expect(text()).toContain("ScoutSleeping");
    expect(sleepButton("box-1")).toBeNull();
    expect(deleteButton("box-1")!.disabled).toBe(false);
  });

  it("says why when the server refuses, and leaves the computer as it was", async () => {
    fixture.lists = [list([computer({ state: "running" })])];
    fixture.postReply = { status: 409, body: { error: "Scout is using its computer right now." } };
    await mount();
    flushSync(() => sleepButton("box-1")!.click());
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("Scout is using its computer right now.");
    expect(text()).toContain("ScoutRunning");
    expect(sleepButton("box-1")!.disabled).toBe(false);
  });

  it("falls back to its own words when the refusal has none", async () => {
    fixture.lists = [list([computer({ state: "running" })])];
    fixture.postReply = { status: 502, body: {} };
    await mount();
    flushSync(() => sleepButton("box-1")!.click());
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toBe("Could not put this cloud computer to sleep");
  });
});

describe("whose computer it is", () => {
  it("shows the dog that owns it, asleep while its computer sleeps, and a plain screen for a left-over one", async () => {
    fixture.bots = [{ id: "scout", name: "Scout", color: "amber" }, { id: "bo", name: "Bo", color: "sky" }];
    fixture.lists = [list([
      computer(),
      computer({ boxId: "box-2", ownerBotId: "bo", ownerName: "Bo", state: "running" }),
      computer({ boxId: "box-3", name: "laterdog-old", ownerBotId: null, ownerName: null, orphaned: true, state: "stopped" }),
    ])];
    await mount();
    expect(row("box-1").querySelector("[data-sleeping-dog]")).not.toBeNull();
    expect(row("box-1").querySelector(".lucide-monitor")).toBeNull();
    expect(row("box-2").querySelector("[data-sleeping-dog]")).toBeNull();
    expect(row("box-2").querySelector(".lucide-monitor")).toBeNull();
    expect(row("box-3").querySelector("[data-sleeping-dog]")).toBeNull();
    expect(row("box-3").querySelector(".lucide-monitor")).not.toBeNull();
    expect(row("box-1").getAttribute("aria-label")).toBe("Scout");
    expect(row("box-3").getAttribute("aria-label")).toBe("Left over from a removed dog");
  });
});
