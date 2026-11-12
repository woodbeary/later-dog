// @vitest-environment happy-dom
import { act, createElement, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type AppState, type Bot, type Message } from "@/state/store";
import { foldExchanges, type ExchangeItem } from "@/lib/quiet-lines";
import { groupTranscript } from "@/lib/activity-runs";
import { ExchangeLine, PlainNoteLine } from "./QuietLines";

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

it("shows an old opened-thread receipt as plain text with nothing to open", async () => {
  await act(async () => root.render(createElement(BotEditorStore, {
    value: { state: { ...initialState, bots }, dispatch,
      flushBotPatches: vi.fn(async () => null), refreshInstances: vi.fn(async () => {}), refreshModels: vi.fn(async () => {}),
    },
    children: createElement(PlainNoteLine, { message: messages[0] }),
  })));
  expect(host.textContent).toBe("Opened thread #Original title on Old Scout");
  expect(host.querySelector("button")).toBeNull();
  expect(foldExchanges(groupTranscript(messages)).map((entry) => entry.kind)).toEqual(["message", "message"]);
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
  expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "scout" });
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

it("shows one counted Messaged line and lets each recorded send open the dog", async () => {
  const currentBots = [{ ...bots[0], tasks: [{ threadId: "a", title: "First", createdAt: 1 }, { threadId: "b", title: "Second", createdAt: 2 }] }];
  await draw(sends, currentBots);
  const toggle = host.querySelector<HTMLButtonElement>("button")!;
  expect(host.querySelectorAll("button")).toHaveLength(1);
  expect(toggle.textContent).toBe("MessagedScout· 2");
  await act(async () => toggle.click());
  expect(host.querySelectorAll("li")).toHaveLength(2);
  expect(host.textContent).not.toContain("First");
  expect(host.textContent).not.toContain("Second");
  for (const row of host.querySelectorAll("li")) {
    expect(row.lastElementChild!.textContent).toContain("Messaged");
    expect(row.lastElementChild!.textContent).toContain("Scout ·");
  }
  for (const button of host.querySelectorAll<HTMLButtonElement>("li button")) {
    dispatch.mockClear();
    await act(async () => button.click());
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "scout" }]);
  }
});

it("exposes the first and later send synchronously when search opens the collapsed line", async () => {
  await draw(sends);
  await draw(sends, bots, true);
  expect(focusedContent).toHaveBeenCalledWith(expect.stringContaining("Messaged"));
  for (const send of sends) expect(host.querySelectorAll(`[data-mid="${send.id}"]`)).toHaveLength(1);
});

it("opens the group chat for each send and failure, never a group task switch", async () => {
  const groups = [{ id: "g1", name: "Launch", memberIds: ["scout"], tasks: [{ threadId: "room-a" }, { threadId: "room-b" }] }] as AppState["groups"];
  const rows: Message[] = sends.map((message, index) => ({ ...message, threadRef: undefined,
    comm: { groupId: "g1", threadId: index === 0 ? "room-a" : "room-b", withBotId: "scout", withName: "Scout", withColor: "green" },
  }));
  await draw(rows, bots, true, groups);
  for (const button of host.querySelectorAll<HTMLButtonElement>("li button")) {
    dispatch.mockClear();
    await act(async () => button.click());
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "g1" }]);
  }
  await draw([{ ...failures[4], comm: rows[0].comm }], bots, false, groups);
  dispatch.mockClear();
  await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
  expect(dispatch.mock.calls.map(([action]) => action)).toEqual([{ type: "select", id: "g1" }]);
});

const sentTo = (exchange: Message["exchange"]): Message => ({
  id: "sent", role: "bot", kind: "activity", at: 5, turnId: "turn-b", handoffId: "child",
  from: { botId: "writer", name: "Writer", color: "blue" },
  tool: { name: "Sent to Scout", ok: true },
  comm: { groupId: "dm", threadId: "dm-thread", withBotId: "scout", withName: "Scout", withColor: "green", direction: "to" },
  ...(exchange ? { exchange } : {}),
});
const record = (over: Partial<NonNullable<Message["exchange"]>> = {}): NonNullable<Message["exchange"]> => ({
  id: "child", status: "running", to: "Scout", from: "Writer", owner: { dog: "Writer", person: true },
  request: "Check the invoice totals", ...over,
});

it("reads the exchange state from the home's record and shows the request and reply on demand", async () => {
  await draw([sentTo(record({ status: "completed", reply: "Totals match" }))]);
  expect(host.querySelector("[data-exchange-state]")?.getAttribute("data-exchange-state")).toBe("Done");
  expect(host.querySelector("[data-exchange-preview]")?.textContent).toBe("· Check the invoice totals");
  expect(host.querySelector("[data-exchange-details]")).toBeNull();
  await act(async () => (host.querySelector("[data-exchange-toggle]") as HTMLButtonElement).click());
  expect(host.querySelector("[data-exchange-request]")?.textContent).toBe("Check the invoice totals");
  expect(host.querySelector("[data-exchange-reply]")?.textContent).toBe("Totals match");
  expect(host.querySelector("[data-exchange-details]")?.textContent).toContain("Writer asked Scout");
});

it("an acknowledgment with no result reads as still working", async () => {
  await draw([sentTo(record({ status: "completed" }))]);
  expect(host.querySelector("[data-exchange-state]")?.getAttribute("data-exchange-state")).toBe("Working");
  await act(async () => (host.querySelector("[data-exchange-toggle]") as HTMLButtonElement).click());
  expect(host.querySelector("[data-exchange-reply]")).toBeNull();
  expect(host.querySelector("[data-exchange-details]")?.textContent).toContain("No reply yet");
});

it("says what a waiting exchange is waiting on", async () => {
  await draw([sentTo(record({ status: "waiting", waitingOn: ["Patch"] }))]);
  await act(async () => (host.querySelector("[data-exchange-toggle]") as HTMLButtonElement).click());
  expect(host.querySelector("[data-exchange-waiting]")?.textContent).toBe("Waiting for Patch");
});

it("an old record with no handoff on the wire keeps the plain line with no details toggle", async () => {
  await draw([sentTo(undefined)]);
  expect(host.querySelector("[data-exchange-toggle]")).toBeNull();
  expect(host.querySelector("[data-exchange-name]")?.textContent).toBe("Scout");
});
