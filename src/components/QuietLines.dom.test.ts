// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type Bot, type Message } from "@/state/store";
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
async function draw(rows = messages, currentBots = bots, forceOpen = false) {
  await act(async () => root.render(createElement(BotEditorStore, {
    value: { state: { ...initialState, bots: currentBots }, dispatch,
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
