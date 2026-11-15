// @vitest-environment happy-dom
import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bot, Group, Message } from "@/state/store";

vi.mock("./ModelPicker", () => ({ ModelPicker: () => null }));
const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: { ...original.initialState, instances: [{ instanceId: "claude", driverKind: "claudeAgent", displayName: "Claude", capabilities: { queueing: true } }] },
      dispatch: fixture.dispatch,
    }),
  };
});
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

const { Composer } = await import("./Composer");
const { QuestionCard } = await import("./QuestionCard");
const { OptionCard } = await import("./OptionCard");
const { appendComposerDraft } = await import("@/lib/drafts");
const { setLocale } = await import("@/lib/i18n");
const { formatQuestionAnswers } = await import("../../shared/ask-question");

const QUESTIONS = [
  { question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }] },
  { question: "Which size?", header: "Size", options: [{ label: "Small" }, { label: "Large" }] },
];

let host: HTMLDivElement;
let root: Root;
let n = 0;

const dog = (threadId: string): Bot => ({
  id: "biscuit", threadId, name: "Biscuit", title: "", description: "", color: "green",
  notifications: true, unread: false, messages: [], busy: true, modelSelection: { instanceId: "claude", model: "claude-fake" },
});

async function mount(card: (threadId: string) => ReturnType<typeof createElement>, typed: string) {
  const threadId = `thread-${++n}`;
  appendComposerDraft(`bot:biscuit:${threadId}`, typed);
  await act(async () => root.render(createElement(Fragment, null, card(threadId), createElement("div", { "data-tour": "composer" }, createElement(Composer, { bot: dog(threadId) })))));
  return threadId;
}

const question = (threadId: string) => createElement(QuestionCard, {
  threadId, bot: { name: "Biscuit" },
  message: { id: "q", role: "bot", kind: "options", at: 1, card: { title: "Question", subtitle: "", options: [], requestId: "req-q", requestType: "question", questionRequest: { version: 1, questions: QUESTIONS } } } as Message,
});
const choice = (threadId: string) => createElement(OptionCard, {
  botId: "biscuit", threadId,
  message: { id: "c", role: "bot", kind: "options", at: 1, card: { title: "Which name?", subtitle: "Pick one, or use Other to type your own.", options: ["alpha", "beta"], requestId: "req-c", requestType: "question" } } as Message,
});

const click = async (name: string) => {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim().endsWith(name))!;
  await act(async () => button.click());
};
const enter = async () => {
  const textarea = host.querySelector("textarea")!;
  await act(async () => { textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
};
const actions = () => fixture.dispatch.mock.calls.map(([action]) => action).filter((action) => action.type === "decideRequest" || action.type === "send" || action.type === "sendGroup");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  vi.stubGlobal("requestAnimationFrame", (run: () => void) => { run(); return 0; });
  setLocale("en");
  fixture.dispatch.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("answering a card in your own words", () => {
  it("ends the card with Other, which puts the cursor in the message box and sends the typed answer to the card with its other picks", async () => {
    const threadId = await mount(question, "Medium please");
    await click("Red");
    await click("Other");
    const textarea = host.querySelector("textarea")!;
    expect(document.activeElement).toBe(textarea);
    expect(textarea.placeholder).toBe("Type your answer");
    expect(host.querySelector('[role="group"] input')).toBeNull();
    await enter();
    expect(actions()).toEqual([expect.objectContaining({
      type: "decideRequest", threadId, requestId: "req-q", behavior: "answer",
      message: formatQuestionAnswers(QUESTIONS, [["Red"], ["Medium please"]]),
    })]);
    expect(textarea.value).toBe("");
  });

  it("keeps the words in the box until every question has an answer, and says which one is open", async () => {
    await mount(question, "Teal");
    await click("Other");
    await enter();
    expect(actions()).toEqual([]);
    expect(host.querySelector("textarea")!.value).toBe("Teal");
    expect(host.querySelector("[data-question-typing]")!.textContent).toBe("Pick an answer for Size first, then send yours.");
  });

  it("gives a dog's choice card an Other that answers its request with the typed words", async () => {
    const threadId = await mount(choice, "gamma");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent?.trim()).filter(Boolean)).toEqual(expect.arrayContaining(["Aalpha", "Bbeta", "COther"]));
    await click("Other");
    expect(host.querySelector("textarea")!.placeholder).toBe("Type your answer");
    await enter();
    expect(actions()).toEqual([expect.objectContaining({ type: "decideRequest", threadId, requestId: "req-c", behavior: "answer", message: "gamma" })]);
  });

  it("answers the card from a group chat's message box the same way", async () => {
    const threadId = `group-thread-${++n}`;
    const group = { id: `room-${n}`, threadId, name: "Kitchen", memberIds: ["biscuit"], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages: [] } as unknown as Group;
    appendComposerDraft(`group:${group.id}:${threadId}`, "Medium please");
    await act(async () => root.render(createElement(Fragment, null, question(threadId), createElement("div", { "data-tour": "composer" }, createElement(Composer, { group, members: [dog(threadId)] })))));
    await click("Red");
    await click("Other");
    expect(host.querySelector("textarea")!.placeholder).toBe("Type your answer");
    await enter();
    expect(actions()).toEqual([expect.objectContaining({
      type: "decideRequest", threadId, requestId: "req-q", behavior: "answer",
      message: formatQuestionAnswers(QUESTIONS, [["Red"], ["Medium please"]]),
    })]);
  });
});
