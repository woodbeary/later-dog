// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot } from "@/state/store";
import { CLOUD_COMPUTER_BUSY_ERROR } from "../../../shared/computer-contention";

type FixtureState = {
  computerControl: Record<string, { held: boolean; helpReason: string | null }>;
  takeoverIntent: { botId: string; at: number } | null;
  computerStarts: Record<string, { state: string; place?: string }>;
};
const fixture = vi.hoisted(() => ({
  api: vi.fn(),
  dispatch: vi.fn(),
  flushBotPatches: vi.fn(async () => null),
  state: { computerControl: {}, takeoverIntent: null, computerStarts: {} } as FixtureState,
}));
vi.mock("@/state/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/state/store")>(),
  api: fixture.api,
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, flushBotPatches: fixture.flushBotPatches }),
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
let shown: Bot | null = null;
const show = async (bot: Bot) => {
  shown = bot;
  await act(async () => root.render(createElement(ComputerTab, { bot })));
  await settle();
};
const rerender = () => { if (shown) root.render(createElement(ComputerTab, { bot: shown })); };

const STATUS = "GET /api/bots/scout/computer";
const WAKE = "POST /api/bots/scout/computer/provision";
const SHOT = "POST /api/bots/scout/computer/screenshot";
const CONTROL = "GET /api/bots/scout/computer/control";
const CONTROL_CHANGE = "POST /api/bots/scout/computer/control";
const JOIN = "POST /api/bots/scout/computer/join";

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
  fixture.state = { computerControl: {}, takeoverIntent: null, computerStarts: {} };
  fixture.dispatch.mockImplementation((action: { type: string; botId?: string; held?: boolean; helpReason?: string | null; intent?: FixtureState["takeoverIntent"] }) => {
    if (action.type === "computerControl") {
      fixture.state = { ...fixture.state, computerControl: { ...fixture.state.computerControl, [action.botId!]: { held: action.held === true, helpReason: action.helpReason ?? null } } };
      rerender();
    }
    if (action.type === "takeoverIntent") {
      fixture.state = { ...fixture.state, takeoverIntent: action.intent ?? null };
      rerender();
    }
  });
  fixture.flushBotPatches.mockClear();
  shown = null;
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
  it("sleeps until woken, then shows the dog's screen to watch, with Take control", async () => {
    reply(STATUS, () => box("stopped"), () => box("running"));
    reply(WAKE, () => ({ ready: true }));
    reply(SHOT, () => ({ png: "AAAA", format: "jpeg" }));
    await show(scout());

    expect(fixture.flushBotPatches).toHaveBeenCalledWith("scout");
    expect(calls(STATUS)[0]![0]).toBe("/api/bots/scout/computer?threadId=thread-scout");
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

    expect(panel().querySelector('[aria-label="Open Scout\'s live desktop"]')).toBeNull();
    expect(host.querySelector("[data-computer-hands]")!.getAttribute("data-computer-hands")).toBe("watching");
    expect(button("Take control")).toBeDefined();
    expect(calls(CONTROL_CHANGE)).toHaveLength(0);
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
    expect(panel().textContent).toContain("Scout is in the middle of something. Its computer wakes as soon as Scout is free.");
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

  it("keeps saying why while a busy dog's computer is still asleep, and wakes it once the dog is free", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    reply(STATUS, () => box("archived"));
    reply(WAKE, () => { throw new ApiError(CLOUD_COMPUTER_BUSY_ERROR, 409); });
    reply(SHOT, () => ({ png: "AAAA" }));
    await show(scout({ busy: true }));
    expect(panel().dataset.simpleComputer).toBe("asleep");

    await press(dogButton("Wake Scout's computer")!);
    await settle();
    for (let poll = 0; poll < 3; poll++) {
      await act(async () => { vi.advanceTimersByTime(3000); });
      await settle();
      expect(panel().dataset.simpleComputer).toBe("waking");
      expect(panel().textContent).toContain("Scout is in the middle of something. Its computer wakes as soon as Scout is free.");
    }
    expect(calls(STATUS).length).toBeGreaterThanOrEqual(4);
    expect(calls(WAKE)).toHaveLength(1);

    replies[WAKE] = [() => ({ ready: true })];
    replies[STATUS] = [() => box("archived"), () => box("running")];
    shown = scout({ busy: false });
    await act(async () => rerender());
    await settle();
    expect(calls(WAKE)).toHaveLength(2);
    expect(panel().dataset.simpleComputer).toBe("awake");
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

  it("moves the dog onto its cloud computer when the person wakes one it does not use yet", async () => {
    reply(STATUS, () => box("stopped"));
    await show(scout({ computer: undefined }));
    expect(panel().querySelector('[data-dog="sleeping"]')).not.toBeNull();
    expect(button("Open")).toBeUndefined();
    await press(dogButton("Wake Scout's computer")!);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "updateBot", botId: "scout", patch: { computer: "cloud" } });
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

  it("shows the dog's screen as soon as its own turn sends a frame, even from asleep", async () => {
    reply(STATUS, () => box("stopped"));
    reply(SHOT, () => ({ png: "AAAA", format: "png" }));
    await show(scout());
    expect(panel().getAttribute("data-simple-computer")).toBe("asleep");

    await act(async () => publishLiveFrame({ kind: "screen", botId: "scout", threadId: "thread-scout", png: "BBBB", mime: "image/png" }));
    await settle();
    expect(panel().getAttribute("data-simple-computer")).toBe("awake");
    expect(panel().querySelector("img")).not.toBeNull();
  });

  it("checks again when the dog starts its computer, instead of staying asleep", async () => {
    reply(STATUS, () => box("stopped"), () => box("stopped"), () => box("running"));
    reply(SHOT, () => ({ png: "AAAA", format: "png" }));
    await show(scout());
    expect(panel().getAttribute("data-simple-computer")).toBe("asleep");

    fixture.state = { ...fixture.state, computerStarts: { scout: { state: "waking", place: "cloud" } } };
    await act(async () => rerender());
    await settle();
    expect(panel().getAttribute("data-simple-computer")).toBe("waking");
    expect(calls(WAKE)).toHaveLength(0);
  });
});

type ViewerState = { open: boolean; contextId: string | null };
function stubViewer(opened = true) {
  const listeners = new Set<(state: ViewerState) => void>();
  const viewer = {
    open: vi.fn(async (_url: string, _title: string, contextId: string) => {
      for (const listener of listeners) listener({ open: true, contextId });
      return opened;
    }),
    close: vi.fn(async (contextId: string) => {
      for (const listener of listeners) listener({ open: false, contextId });
      return true;
    }),
    currentState: vi.fn(async () => ({ open: false, contextId: null })),
    onState: (listener: (state: ViewerState) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    emit: (state: ViewerState) => { for (const listener of listeners) listener(state); },
  };
  vi.stubGlobal("laterdog", { desktopViewer: viewer });
  return viewer;
}
const sent = (key: string) => calls(key).map(([, init]) => JSON.parse(String((init as RequestInit).body ?? "{}")));

describe("watching and taking control of the dog's computer", () => {
  const awake = () => {
    reply(STATUS, () => box("running"));
    reply(SHOT, () => ({ png: "AAAA", format: "jpeg" }));
  };

  it("never takes control from a busy dog just by being opened", async () => {
    awake();
    reply(CONTROL, () => ({ held: false, helpReason: null }));
    stubViewer();
    await show(scout({ busy: true }));
    expect(panel().querySelector("img")!.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA");
    expect(calls(CONTROL)).toHaveLength(1);
    expect(calls(CONTROL_CHANGE)).toHaveLength(0);
    expect(calls(JOIN)).toHaveLength(0);
  });

  it("takes control, opens the desktop with an I'm done pill, and goes back to watching when the person is done", async () => {
    awake();
    reply(CONTROL, () => ({ held: false, helpReason: null }));
    reply(CONTROL_CHANGE, (init) => ({ held: JSON.parse(String(init!.body)).action === "take", helpReason: null }));
    reply(JOIN, () => ({ joinUrl: "https://desktop.example.test/cmp_one/token/" }));
    const viewer = stubViewer();
    await show(scout());

    await press(button("Take control"));
    await settle();
    expect(sent(CONTROL_CHANGE)).toEqual([{ action: "take" }]);
    expect(calls(JOIN)[0]![0]).toBe("/api/bots/scout/computer/join?threadId=thread-scout");
    expect(viewer.open).toHaveBeenCalledWith("https://desktop.example.test/cmp_one/token/", "Scout's live desktop", "scout", { label: "You're in control", done: "I'm done" });
    expect(host.querySelector("[data-computer-hands]")!.getAttribute("data-computer-hands")).toBe("held");
    expect(host.textContent).toContain("Scout waits until you're done.");

    await act(async () => viewer.emit({ open: false, contextId: "scout" }));
    await settle();
    expect(sent(CONTROL_CHANGE)).toEqual([{ action: "take" }, { action: "release" }]);
    expect(host.querySelector("[data-computer-hands]")!.getAttribute("data-computer-hands")).toBe("watching");
  });

  it("hands control back from the tab, closing the desktop", async () => {
    awake();
    reply(CONTROL, () => ({ held: true, helpReason: null }));
    reply(CONTROL_CHANGE, () => ({ held: false, helpReason: null }));
    const viewer = stubViewer();
    await show(scout());
    await press(button("I'm done"));
    await settle();
    expect(viewer.close).toHaveBeenCalledWith("scout");
    expect(sent(CONTROL_CHANGE)).toEqual([{ action: "release" }]);
    expect(button("Take control")).toBeDefined();
  });

  it("gives control back and says why when the desktop cannot open", async () => {
    awake();
    reply(CONTROL, () => ({ held: false, helpReason: null }));
    reply(CONTROL_CHANGE, (init) => ({ held: JSON.parse(String(init!.body)).action === "take", helpReason: null }));
    reply(JOIN, () => ({}));
    stubViewer();
    await show(scout());
    await press(button("Take control"));
    await settle();
    expect(sent(CONTROL_CHANGE)).toEqual([{ action: "take" }, { action: "release" }]);
    expect(host.querySelector('[role="alert"]')!.textContent).toBe("The computer did not return a live desktop link");
  });

  it("shows when the dog needs the person, with Take control and Skip", async () => {
    awake();
    reply(CONTROL, () => ({ held: false, helpReason: "Sign in to the bank, please." }));
    reply(CONTROL_CHANGE, () => ({ held: false, helpReason: null }));
    stubViewer();
    await show(scout({ busy: true }));
    expect(host.textContent).toContain("Scout needs you. Sign in to the bank, please.");
    await press(button("Skip"));
    await settle();
    expect(sent(CONTROL_CHANGE)).toEqual([{ action: "dismiss-help" }]);
    expect(host.textContent).not.toContain("needs you");
  });

  it("opens the desktop by itself after a takeover card handed control over, without taking it again", async () => {
    awake();
    reply(CONTROL, () => ({ held: true, helpReason: null }));
    reply(JOIN, () => ({ joinUrl: "https://desktop.example.test/cmp_one/token/" }));
    const viewer = stubViewer();
    fixture.state = { ...fixture.state, takeoverIntent: { botId: "scout", at: Date.now() } };
    await show(scout({ busy: true }));
    await settle();
    expect(viewer.open).toHaveBeenCalledTimes(1);
    expect(calls(CONTROL_CHANGE)).toHaveLength(0);
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "takeoverIntent", intent: null });
  });

  it("lets a stale takeover go without opening anything", async () => {
    awake();
    reply(CONTROL, () => ({ held: true, helpReason: null }));
    const viewer = stubViewer();
    fixture.state = { ...fixture.state, takeoverIntent: { botId: "scout", at: Date.now() - 61_000 } };
    await show(scout());
    expect(viewer.open).not.toHaveBeenCalled();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: "takeoverIntent", intent: null });
  });
});
