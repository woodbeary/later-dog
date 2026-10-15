// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type AppState, type Bot, type Message } from "@/state/store";
import { foldExchanges, type ExchangeItem } from "@/lib/quiet-lines";
import { groupTranscript } from "@/lib/activity-runs";
import { ExchangeLine } from "./QuietLines";

let host: HTMLDivElement;
let root: Root;
const dispatch = vi.fn();
const bots = [
  { id: "scout", name: "Scout", color: "green", threadId: "scout-main", tasks: [{ threadId: "a", title: "Current first title" }] },
  { id: "writer", name: "Writer", color: "blue", threadId: "writer-main", tasks: [{ threadId: "b", title: "Current second title" }] },
] as Bot[];
const messages: Message[] = bots.map((bot, index) => ({
  id: `receipt-${index}`, role: "bot", kind: "activity", at: index + 1, turnId: "turn-a",
  tool: { name: `Opened thread #Original title on Old ${bot.name}`, ok: true },
  threadRef: { botId: bot.id, threadId: index === 0 ? "a" : "b", title: "Original title" },
}));
function item(rows = messages): ExchangeItem {
  const [folded] = foldExchanges(groupTranscript(rows));
  if (folded?.kind !== "exchange") throw new Error("Missing exchange");
  return folded;
}
const focusedContent = vi.fn();
function FocusableExchange({ rows, forceOpen }: { rows: Message[]; forceOpen: boolean }) {
  useLayoutEffect(() => {
    if (forceOpen) focusedContent(document.querySelector('[data-mid="receipt-0"]')?.textContent);
  }, [forceOpen]);
  return createElement(ExchangeLine, { item: item(rows), forceOpen });
}
async function draw(rows = messages, currentBots = bots, forceOpen = false, groups: AppState["groups"] = []) {
  await act(async () => root.render(createElement(BotEditorStore, {
    value: { state: { ...initialState, bots: currentBots, groups }, dispatch,
      flushBotPatches: vi.fn(async () => null), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}),
    },
    children: createElement(FocusableExchange, { rows, forceOpen }),
  })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  dispatch.mockClear();
  focusedContent.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();
});

it("shows a singleton's current title and bot immediately and navigates directly", async () => {
  await draw([messages[0]]);
  expect(host.textContent).toContain("#Current first title");
  expect(host.textContent).toContain("Scout");
  expect(host.querySelector("button[aria-expanded]")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('[data-thread-chip="a"]')!.click());
  expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
    { type: "select", id: "scout" }, { type: "switchTask", botId: "scout", threadId: "a" }, { type: "revealThread", threadId: "a" },
  ]);
});

it("expands a multi-destination run and opens each recorded destination", async () => {
  await draw();
  const toggle = host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
  const details = document.getElementById(toggle.getAttribute("aria-controls")!)!;
  expect(toggle.textContent).toBe("Opened 2 threads");
  expect(details.hidden).toBe(true);
  expect(host.querySelector("[data-thread-chip]")).toBeNull();
  await act(async () => toggle.click());
  expect(details.hidden).toBe(false);
  expect(host.textContent).toContain("Current first title");
  expect(host.textContent).toContain("Current second title");
  expect(host.querySelector('[data-mid="receipt-1"]')).not.toBeNull();
  for (const [threadId, botId] of [["a", "scout"], ["b", "writer"]]) {
    dispatch.mockClear();
    await act(async () => host.querySelector<HTMLButtonElement>(`[data-thread-chip="${threadId}"]`)!.click());
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: botId }, { type: "switchTask", botId, threadId }, { type: "revealThread", threadId },
    ]);
  }
  await act(async () => toggle.click());
  expect(details.hidden).toBe(true);
});

it("refreshes bot and thread names by id while old receipts stay mounted", async () => {
  await draw(messages, bots, true);
  await draw(messages, [{ ...bots[0], name: "Renamed Scout", tasks: [{ threadId: "a", title: "Renamed work", createdAt: 1 }] }, bots[1]], true);
  const link = host.querySelector<HTMLButtonElement>('[data-thread-chip="a"]')!;
  expect(link.textContent).toContain("Renamed work");
  expect(link.textContent).toContain("Renamed Scout");
  expect(link.getAttribute("aria-label")).toBe("Open #Renamed work on Renamed Scout");
  expect(link.textContent).not.toContain("Old Scout");
});

it("retains stored names and titles for missing destinations and uses existing deleted-thread notices", async () => {
  await draw(messages, [], true);
  const link = host.querySelector<HTMLButtonElement>('[data-thread-chip="a"]')!;
  expect(link.textContent).toContain("Original title");
  expect(link.textContent).toContain("Old Scout");
  await act(async () => link.click());
  expect(dispatch).toHaveBeenCalledWith({ type: "notice", notice: { kind: "thread-gone", botName: null } });
});

it("opens a folded run when search focuses one of its receipts", async () => {
  await draw();
  expect(host.querySelector('[data-mid="receipt-1"]')).toBeNull();
  await draw(messages, bots, true);
  expect(focusedContent).toHaveBeenCalledWith(expect.stringContaining("Current first title"));
  expect(host.querySelector("button[aria-expanded]")!.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector('[data-mid="receipt-1"]')).not.toBeNull();
});

const failures: Message[] = Array.from({ length: 5 }, (_, index) => ({
  id: `receipt-${index}`, role: "bot", kind: "activity", at: index + 1,
  roomRequest: { id: `request-${index}`, phase: "result" },
  from: { botId: "scout", name: "Old Scout", color: "green" },
  tool: { name: "Old Scout couldn't finish", ok: false, output: `Result details ${index}` },
  ...(index === 4 ? { comm: { groupId: "g1", withBotId: "scout", withName: "Old Scout", withColor: "green" as const } }
    : { threadRef: { botId: "scout", threadId: "a", title: `Work ${index}` } }),
}));

it("renders mixed failures as one red pill and expands every individual result", async () => {
  await draw(failures);
  expect(host.querySelectorAll("button")).toHaveLength(1);
  const toggle = host.querySelector<HTMLButtonElement>("button")!;
  expect(toggle.textContent).toBe("Scout couldn't finish· 5");
  expect(toggle.classList.contains("text-danger")).toBe(true);
  expect(host.textContent).not.toContain("Result details");
  await act(async () => toggle.click());
  expect(host.querySelectorAll("li")).toHaveLength(5);
  for (const [index, row] of [...host.querySelectorAll("li")].entries()) {
    expect(row.getAttribute("data-mid")).toBe(`receipt-${index}`);
    expect(row.textContent).toContain(`Result details ${index}`);
    expect(row.lastElementChild!.textContent).toContain("Scout couldn't finish");
    expect(row.lastElementChild!.textContent).toContain(`Result details ${index}`);
    expect(row.querySelector("button")!.classList.contains("text-danger")).toBe(true);
    expect(row.querySelector("button")!.classList.contains("hover:text-danger")).toBe(true);
    expect(row.querySelector("button")!.classList.contains("hover:text-ink")).toBe(false);
  }
  await act(async () => host.querySelector<HTMLButtonElement>("li button")!.click());
  expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: "a" });
  await act(async () => toggle.click());
  expect(host.querySelectorAll("li")).toHaveLength(0);
});

it("uses the same failure color for singleton room and thread results", async () => {
  for (const failure of [failures[0], failures[4]]) {
    await draw([failure]);
    expect(host.querySelectorAll("button")).toHaveLength(1);
    expect(host.querySelector("button")!.classList.contains("text-danger")).toBe(true);
    expect(host.querySelector("button")!.classList.contains("hover:text-danger")).toBe(true);
  }
});

it("exposes every failure synchronously when search focuses a folded receipt", async () => {
  await draw(failures);
  await draw(failures, bots, true);
  expect(focusedContent).toHaveBeenCalledWith(expect.stringContaining("Result details 0"));
  for (const failure of failures) expect(host.querySelectorAll(`[data-mid="${failure.id}"]`)).toHaveLength(1);
});

const sends: Message[] = ["a", "b"].map((threadId, index) => ({
  id: `receipt-${index}`, role: "bot", kind: "activity", at: index + 1,
  tool: { name: "Sent to Scout", ok: true },
  threadRef: { botId: "scout", threadId, title: `Work ${threadId}` },
}));

it("shows one counted Messaged line and lets each recorded send open its thread", async () => {
  const currentBots = [{ ...bots[0], tasks: [{ threadId: "a", title: "First", createdAt: 1 }, { threadId: "b", title: "Second", createdAt: 2 }] }];
  await draw(sends, currentBots);
  const toggle = host.querySelector<HTMLButtonElement>("button")!;
  expect(host.querySelectorAll("button")).toHaveLength(1);
  expect(toggle.textContent).toBe("MessagedScout· 2");
  await act(async () => toggle.click());
  expect(host.querySelectorAll("li")).toHaveLength(2);
  expect(host.textContent).toContain("First");
  expect(host.textContent).toContain("Second");
  for (const row of host.querySelectorAll("li")) expect(row.lastElementChild!.textContent).toContain("Messaged");
  for (const [index, button] of [...host.querySelectorAll<HTMLButtonElement>("li button")].entries()) {
    dispatch.mockClear();
    await act(async () => button.click());
    expect(dispatch).toHaveBeenCalledWith({ type: "switchTask", botId: "scout", threadId: index === 0 ? "a" : "b" });
  }
});

it("exposes the first and later send synchronously when search opens the collapsed line", async () => {
  await draw(sends);
  await draw(sends, bots, true);
  expect(focusedContent).toHaveBeenCalledWith(expect.stringContaining("Messaged"));
  for (const send of sends) expect(host.querySelectorAll(`[data-mid="${send.id}"]`)).toHaveLength(1);
});

it("opens the recorded room task for each send and failure", async () => {
  const groups = [{ id: "g1", name: "Launch", memberIds: ["scout"], tasks: [{ threadId: "room-a" }, { threadId: "room-b" }] }] as AppState["groups"];
  const rows: Message[] = sends.map((message, index) => ({ ...message, threadRef: undefined,
    comm: { groupId: "g1", threadId: index === 0 ? "room-a" : "room-b", withBotId: "scout", withName: "Scout", withColor: "green" },
  }));
  await draw(rows, bots, true, groups);
  for (const [index, button] of [...host.querySelectorAll<HTMLButtonElement>("li button")].entries()) {
    dispatch.mockClear();
    await act(async () => button.click());
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
      { type: "select", id: "g1" }, { type: "switchGroupTask", groupId: "g1", threadId: index === 0 ? "room-a" : "room-b" },
    ]);
  }
  await draw([{ ...failures[4], comm: rows[0].comm }], bots, false, groups);
  dispatch.mockClear();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(dispatch.mock.calls.map(([action]) => action)).toEqual([
    { type: "select", id: "g1" }, { type: "switchGroupTask", groupId: "g1", threadId: "room-a" },
  ]);
});
