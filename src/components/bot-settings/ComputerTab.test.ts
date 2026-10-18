// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../../../shared/computer-contention";

const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  flushBotPatches: vi.fn(async () => null),
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ dispatch: fixture.dispatch, flushBotPatches: fixture.flushBotPatches }),
}));
vi.mock("../Avatar", async (importOriginal) => ({
  ...await importOriginal<typeof import("../Avatar")>(),
  DogAvatar: ({ state }: { state?: string }) => createElement("span", { "data-dog": state }),
}));

const { ComputerTab, computerCardFor } = await import("./ComputerTab");
type ComputerStatus = import("./ComputerTab").ComputerStatus;
const { publishLiveFrame } = await import("@/lib/live-events");
const { ApiError } = await import("@/state/store");

type Reply = (init?: RequestInit) => unknown;
let replies: Record<string, Reply[]>;
let root: Root;
let host: HTMLDivElement;

const scout = (patch: Partial<Bot> = {}) => ({
  id: "scout", threadId: "thread-scout", name: "Scout", color: "green", computer: "cloud", busy: false, ...patch,
}) as unknown as Bot;
const box = (state: string | null): ComputerStatus => ({ surface: "cloud", configured: true, backend: "box", box: state ? { state } : null });
const reply = (key: string, ...answers: Reply[]) => { replies[key] = [...(replies[key] ?? []), ...answers]; };
const calls = (key: string) => fixture.api.mock.calls.filter(([path, init]) =>
  `${(init as RequestInit | undefined)?.method ?? "GET"} ${String(path).split("?")[0]}` === key);
const settle = () => act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
const panel = () => host.querySelector<HTMLElement>("[data-simple-computer]")!;
const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find((element) => element.textContent === label)!;
const dogButton = (label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const press = (element: HTMLElement) => act(async () => element.click());
const show = async (bot: Bot) => {
  await act(async () => root.render(createElement(ComputerTab, { bot })));
  await settle();
};

const STATUS = "GET /api/bots/scout/computer";
const WAKE = "POST /api/bots/scout/computer/provision";
const SHOT = "POST /api/bots/scout/computer/screenshot";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  replies = {};
  fixture.api.mockReset();
  fixture.api.mockImplementation(async (path: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${path.split("?")[0]}`;
    const queue = replies[key];
    if (!queue?.length) throw new Error(`no reply for ${key}`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    return next(init);
  });
  fixture.dispatch.mockReset();
  fixture.flushBotPatches.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("what the dog's computer card shows", () => {
  it("follows where the dog works before anything about a cloud computer", () => {
    const bot = { computer: "cloud" as const };
    expect(computerCardFor(bot, { surface: "off" })).toEqual({ kind: "off" });
    expect(computerCardFor(bot, { surface: "local" })).toEqual({ kind: "elsewhere", surface: "local" });
    expect(computerCardFor(bot, { surface: "vm" })).toEqual({ kind: "elsewhere", surface: "vm" });
    expect(computerCardFor(bot, { surface: "browser" })).toEqual({ kind: "elsewhere", surface: "browser" });
    expect(computerCardFor(bot, { surface: "cloud", configured: false })).toEqual({ kind: "unset" });
  });

  it("is awake when the cloud computer is up, waking while it starts, and asleep otherwise", () => {
    const bot = { computer: "cloud" as const };
    expect(computerCardFor(bot, box("running"))).toEqual({ kind: "awake" });
    expect(computerCardFor(bot, box("idle"))).toEqual({ kind: "awake" });
    expect(computerCardFor(bot, box("starting"))).toEqual({ kind: "waking", fresh: false, polling: true });
    expect(computerCardFor(bot, box("stopped"))).toEqual({ kind: "asleep", fresh: false, canWake: true });
    expect(computerCardFor(bot, box(null))).toEqual({ kind: "asleep", fresh: true, canWake: true });
  });

  it("only offers Wake when the dog itself owns a cloud computer", () => {
    expect(computerCardFor({}, box("stopped"))).toEqual({ kind: "asleep", fresh: false, canWake: false });
  });

  it("wakes a private server when the dog uses it or starts it on its own", () => {
    const vps = (extra: object) => ({ surface: "cloud" as const, configured: true, backend: "vps" as const, ...extra });
    expect(computerCardFor({ computer: "cloud" }, vps({ ready: true }))).toEqual({ kind: "awake" });
    expect(computerCardFor({ computer: "cloud" }, vps({ ready: false, container: "missing" })))
      .toEqual({ kind: "asleep", fresh: true, canWake: true });
    expect(computerCardFor({ autoStartVps: true }, vps({ ready: false, container: "stopped" })))
      .toEqual({ kind: "asleep", fresh: false, canWake: true });
    expect(computerCardFor({}, vps({ ready: false, container: "stopped" })))
      .toEqual({ kind: "asleep", fresh: false, canWake: false });
  });
});

describe("the Computer tab", () => {
  it("sleeps until woken, then shows the dog's screen and opens the full desktop", async () => {
    reply(STATUS, () => box("stopped"), () => box("running"));
    reply(WAKE, () => ({ ready: true }));
    reply(SHOT, () => ({ png: "AAAA", format: "jpeg" }));
    await show(scout());

    expect(fixture.flushBotPatches).toHaveBeenCalledWith("scout");
    expect(fixture.api.mock.calls[0]![0]).toBe("/api/bots/scout/computer?threadId=thread-scout");
    expect(panel().dataset.simpleComputer).toBe("asleep");
    expect(panel().textContent).toContain("Computer is asleep");
    expect(panel().textContent).toContain("Scout's screen");
    const dog = dogButton("Wake Scout's computer")!;
    expect(dog.querySelector('[data-dog="sleeping"]')).not.toBeNull();
    expect(panel().textContent).toContain("Tap to wake");
    expect(panel().querySelectorAll("button")).toHaveLength(1);

    await press(dog);
    await settle();
    expect(calls(WAKE)).toHaveLength(1);
    expect(panel().dataset.simpleComputer).toBe("awake");
    expect(calls(SHOT)[0]![0]).toBe("/api/bots/scout/computer/screenshot?threadId=thread-scout");
    const screen = panel().querySelector("img")!;
    expect(screen.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(screen.getAttribute("alt")).toBe("Scout's screen");

    await press(panel().querySelector<HTMLButtonElement>('[aria-label="Open Scout\'s live desktop"]')!);
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleComputer", open: true });
  });

  it("stays waking while the dog's own turn holds the computer, and checks again until it is up", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    reply(STATUS, () => box(null), () => box("running"));
    reply(WAKE, () => { throw new ApiError(CLOUD_COMPUTER_BUSY_ERROR, 409); });
    reply(SHOT, () => ({ png: "AAAA" }));
    await show(scout());

    const dog = dogButton("Wake Scout's computer")!;
    dog.focus();
    await press(dog);
    await settle();
    expect(panel().dataset.simpleComputer).toBe("waking");
    expect(panel().textContent).toContain("Waking up…");
    expect(panel().textContent).toContain("The first start takes about a minute.");
    expect(dog.isConnected).toBe(true);
    expect(document.activeElement).toBe(dog);
    expect(dog.getAttribute("aria-disabled")).toBe("true");
    expect(dog.querySelector('[data-dog="waking"]')).not.toBeNull();
    await press(dog);
    expect(calls(WAKE)).toHaveLength(1);
    expect(calls(STATUS)).toHaveLength(1);

    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(dog.querySelector('[data-dog="loading"]')).not.toBeNull();
    await act(async () => { vi.advanceTimersByTime(2000); });
    await settle();
    expect(calls(STATUS)).toHaveLength(2);
    expect(panel().dataset.simpleComputer).toBe("awake");
    expect(panel().querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AAAA");
  });

  it("says why it couldn't wake and tries again from the same place", async () => {
    reply(STATUS, () => box("stopped"));
    reply(WAKE, () => ({ ready: false, problem: "No room in that region right now" }));
    await show(scout());

    await press(dogButton("Wake Scout's computer")!);
    await settle();
    const alert = panel().querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Couldn't wake Scout's screen");
    expect(alert.textContent).toContain("No room in that region right now");
    expect(panel().textContent).toContain("Tap to try again");
    expect(button("Try again")).toBeUndefined();

    await press(dogButton("Wake Scout's computer")!);
    await settle();
    expect(calls(WAKE)).toHaveLength(2);
  });

  it("offers Open instead of Wake for a computer the dog does not own", async () => {
    reply(STATUS, () => box("stopped"));
    await show(scout({ computer: undefined }));
    expect(panel().querySelector("[data-wake-dog]")).toBeNull();
    expect(panel().querySelector('[data-dog="sleeping"]')).not.toBeNull();
    await press(button("Open"));
    expect(fixture.dispatch).toHaveBeenLastCalledWith({ type: "toggleComputer", open: true });
  });

  it("turns the computer on and wakes it with one tap on the sleeping dog", async () => {
    reply(STATUS, () => ({ surface: "off" }), () => box(null), () => box("running"));
    reply(WAKE, () => ({ ready: true }));
    reply(SHOT, () => ({ png: "AAAA" }));
    fixture.dispatch.mockImplementation((action: { type: string }) => {
      if (action.type === "updateBot") root.render(createElement(ComputerTab, { bot: scout({ computer: "cloud" }) }));
    });
    await show(scout({ computer: "off" }));
    expect(panel().textContent).toContain("No screen to show");
    expect(panel().textContent).toContain("Scout has no screen.");
    expect(panel().textContent).toContain("Tap to turn on");
    expect(panel().querySelectorAll("button")).toHaveLength(1);

    const dog = dogButton("Turn on Scout's computer")!;
    await press(dog);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { computer: "cloud" } });
    await settle();
    expect(calls(STATUS)).toHaveLength(3);
    expect(calls(WAKE)).toHaveLength(1);
    expect(panel().dataset.simpleComputer).toBe("awake");
  });

  it("goes back to sleep instead of hanging when turning on finds no computer to wake", async () => {
    reply(STATUS, () => ({ surface: "off" }));
    await show(scout({ computer: "off" }));
    await press(dogButton("Turn on Scout's computer")!);
    await settle();
    expect(calls(STATUS)).toHaveLength(2);
    expect(calls(WAKE)).toHaveLength(0);
    expect(panel().dataset.simpleComputer).toBe("off");
  });

  it("says where the dog works when it is not a cloud computer", async () => {
    reply(STATUS, () => ({ surface: "local" }));
    await show(scout({ computer: "local" }));
    expect(panel().dataset.simpleComputer).toBe("elsewhere");
    expect(panel().textContent).toContain("Works on this device");
    expect(panel().textContent).toContain("Uses your screen, mouse, and keyboard.");
    expect(calls(WAKE)).toHaveLength(0);
  });

  it("says it can't reach the screen when the check fails, and checks again on Try again", async () => {
    reply(STATUS, () => { throw new Error("offline"); }, () => box("stopped"));
    await show(scout());
    expect(panel().dataset.simpleComputer).toBe("unreachable");
    expect(panel().textContent).toContain("Can't reach Scout's screen");
    await press(button("Try again"));
    await settle();
    expect(calls(STATUS)).toHaveLength(2);
    expect(panel().dataset.simpleComputer).toBe("asleep");
  });

  it("swaps in live frames from this dog's chat and ignores other chats", async () => {
    reply(STATUS, () => box("running"));
    reply(SHOT, () => ({}));
    await show(scout());
    expect(panel().textContent).toContain("Can't reach Scout's screen");

    await act(async () => publishLiveFrame({ kind: "screen", botId: "scout", threadId: "other", png: "CCCC" }));
    expect(panel().querySelector("img")).toBeNull();
    await act(async () => publishLiveFrame({ kind: "screen", botId: "scout", threadId: "thread-scout", png: "BBBB", mime: "image/png" }));
    expect(panel().querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,BBBB");
  });
});
