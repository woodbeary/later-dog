// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkStatusLine } from "./WorkStatusLine";
import type { Message } from "@/state/store";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const draw = (bot: Parameters<typeof WorkStatusLine>[0]["bot"]) => act(() => root.render(createElement(WorkStatusLine, { bot })));

it("says what the chat is waiting for in the header", () => {
  draw({ busy: false, work: { kind: "waiting-on-dog", dogs: [{ id: "scout", name: "Scout" }] } });
  expect(host.querySelector("[role=status]")?.textContent).toBe("Waiting on Scout");
  draw({ busy: true, work: { kind: "retrying", attempt: 2 } });
  expect(host.querySelector("[data-work-state=retrying]")?.textContent).toBe("Reconnecting to the engine, try 2");
});

it("shows nothing for plain running or idle work", () => {
  draw({ busy: true, work: { kind: "running" } });
  expect(host.textContent).toBe("");
  draw({ busy: false, work: { kind: "idle" } });
  expect(host.textContent).toBe("");
});

it("falls back to the teammate wait line from a home that sends no work state", () => {
  draw({ busy: false, waitingForTeammates: true, waitingOn: [{ botId: "scout", name: "Scout" }] });
  expect(host.textContent).toBe("Waiting on Scout");
});

it("says who is working in a room's header, and nothing from a home that sends no work for the room", () => {
  draw({ busy: true, work: { kind: "running", dogs: [{ id: "scout", name: "Scout" }, { id: "biscuit", name: "Biscuit" }] } });
  expect(host.querySelector("[data-work-state=running]")?.textContent).toBe("Scout and Biscuit are working");
  draw({ busy: true, work: { kind: "needs-you", what: "Allow the deploy?" } });
  expect(host.querySelector("[role=status]")?.textContent).toBe("Needs you: Allow the deploy?");
  draw({ busy: true, work: undefined });
  expect(host.textContent).toBe("");
});

it("names the dog and what it waits for in the header and the sidebar, for a question and for an approval", async () => {
  const { needsYouWords } = await import("./WorkStatusLine");
  const { waitingLine } = await import("./Sidebar");
  const question = { id: "q", role: "bot", kind: "options", at: 1, card: { title: "Your dog has a question", options: [], requestId: "r1", requestType: "question" } } as unknown as Message;
  const approval = { id: "a", role: "bot", kind: "options", at: 2, card: { title: "Approval needed", options: [], requestId: "r2", tool: "Bash", subtitle: "ls" } } as unknown as Message;
  expect(needsYouWords("Pepper", [question])).toBe("Pepper has a question");
  expect(needsYouWords("Pepper", [approval])).toBe("Pepper wants to run a command");
  expect(needsYouWords("Pepper", [])).toBeUndefined();
  expect(waitingLine([question])).toBe("Has a question");
  expect(waitingLine([approval])).toBe("Asks to run a command");
  act(() => root.render(createElement(WorkStatusLine, { bot: { busy: false, work: { kind: "needs-you", what: "Your dog has a question" } }, what: needsYouWords("Pepper", [question]) })));
  expect(host.querySelector("[role=status]")?.textContent).toBe("Needs you: Pepper has a question");
});

it("says the newest open ask in both places, including one passed on from another dog", async () => {
  const { needsYouWords } = await import("./WorkStatusLine");
  const { waitingLine } = await import("./Sidebar");
  const question = { id: "q", role: "bot", kind: "options", at: 1, card: { title: "", options: [], requestId: "r1", requestType: "question" } } as unknown as Message;
  const approval = { id: "a", role: "bot", kind: "options", at: 2, card: { title: "", options: [], requestId: "r2", tool: "Bash" } } as unknown as Message;
  const proxy = { id: "p", role: "bot", kind: "text", at: 3, needsYou: { status: "waiting", botId: "z", botName: "Ziggy", threadId: "t", messageId: "m", label: "Allow a deploy" } } as unknown as Message;
  expect(needsYouWords("Pepper", [question, approval])).toBe("Pepper wants to run a command");
  expect(waitingLine([question, approval])).toBe("Asks to run a command");
  expect(needsYouWords("Pepper", [approval, question])).toBe("Pepper has a question");
  expect(needsYouWords("Pepper", [question, proxy])).toBe(waitingLine([question, proxy]));
  expect(waitingLine([question, proxy])).toContain("Ziggy");
});
