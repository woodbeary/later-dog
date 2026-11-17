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
const { appendComposerDraft, restoreComposerDraft } = await import("@/lib/drafts");
const { setLocale } = await import("@/lib/i18n");
const { formatQuestionAnswers } = await import("../../shared/ask-question");
const { typedAnswerFor } = await import("@/lib/typed-answer");

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
  it("answers an open question with what is typed in the message box, together with the card's other picks", async () => {
    const threadId = await mount(question, "Medium please");
    await click("Red");
    const textarea = host.querySelector("textarea")!;
    expect(textarea.placeholder).toBe("Or type your own answer");
    expect(host.querySelector('[role="group"] input')).toBeNull();
    await enter();
    expect(actions()).toEqual([expect.objectContaining({
      type: "decideRequest", threadId, requestId: "req-q", behavior: "answer",
      message: formatQuestionAnswers(QUESTIONS, [["Red"], ["Medium please"]]),
    })]);
    expect(textarea.value).toBe("");
  });

  it("holds each question's own typed answer, and says which question still needs a pick", async () => {
    await mount(question, "Teal");
    await enter();
    expect(actions()).toEqual([]);
    expect(host.querySelector("textarea")!.value).toBe("");
    expect(host.querySelector("[data-question-typing]")!.textContent).toBe("Pick an answer for Size first, then send yours.");
  });

  it("sends a different typed answer for each question", async () => {
    const threadId = await mount(question, "Teal");
    await enter();
    expect(actions()).toEqual([]);
    expect(host.querySelector("textarea")!.value).toBe("");
    const box = host.querySelector("textarea")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, "Huge");
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await enter();
    expect(actions()).toEqual([expect.objectContaining({
      type: "decideRequest", threadId, requestId: "req-q",
      message: formatQuestionAnswers(QUESTIONS, [["Teal"], ["Huge"]]),
    })]);
  });

  it("holds a typed answer over the answer limit in the message box, says how long it may be, and sends it once it fits", async () => {
    const long = "word ".repeat(401).trim();
    const threadId = await mount(question, long);
    await click("Red");
    await enter();
    expect(actions()).toEqual([]);
    const box = host.querySelector("textarea")!;
    expect(box.value).toBe(long);
    expect(host.querySelector("[data-typed-answer-long]")?.textContent).toBe(`An answer can be up to ${(2000).toLocaleString()} characters. This one has ${(2004).toLocaleString()}.`);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(box, long.slice(0, 2000));
      box.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(host.querySelector("[data-typed-answer-long]")).toBeNull();
    await enter();
    expect(actions()).toEqual([expect.objectContaining({
      type: "decideRequest", threadId, requestId: "req-q",
      message: formatQuestionAnswers(QUESTIONS, [["Red"], [long.slice(0, 2000).trim()]]),
    })]);
  });

  it("gives a dog's choice card an Other that answers its request with the typed words", async () => {
    const threadId = await mount(choice, "gamma");
    expect([...host.querySelectorAll("button")].map((button) => button.textContent?.trim()).filter(Boolean)).toEqual(expect.arrayContaining(["Aalpha", "Bbeta", "COther"]));
    await click("Other");
    expect(host.querySelector("textarea")!.placeholder).toBe("Or type your own answer");
    await enter();
    expect(actions()).toEqual([expect.objectContaining({ type: "decideRequest", threadId, requestId: "req-c", behavior: "answer", message: "gamma" })]);
  });

  it("answers the card from a group chat's message box the same way", async () => {
    const threadId = `group-thread-${++n}`;
    const group = { id: `room-${n}`, threadId, name: "Kitchen", memberIds: ["biscuit"], defaultResponder: { kind: "mentions" }, bulletin: "", unread: false, createdAt: 1, messages: [] } as unknown as Group;
    appendComposerDraft(`group:${group.id}:${threadId}`, "Medium please");
    await act(async () => root.render(createElement(Fragment, null, question(threadId), createElement("div", { "data-tour": "composer" }, createElement(Composer, { group, members: [dog(threadId)] })))));
    await click("Red");
    expect(host.querySelector("textarea")!.placeholder).toBe("Or type your own answer");
    await enter();
    expect(actions()).toEqual([expect.objectContaining({
      type: "decideRequest", threadId, requestId: "req-q", behavior: "answer",
      message: formatQuestionAnswers(QUESTIONS, [["Red"], ["Medium please"]]),
    })]);
  });

  it("with two cards open, the card Other was chosen on last takes the typed answer", async () => {
    const threadId = `thread-${++n}`;
    appendComposerDraft(`bot:biscuit:${threadId}`, "gamma");
    await act(async () => root.render(createElement(Fragment, null,
      createElement("section", { key: "q", id: "qc" }, question(threadId)),
      createElement("section", { key: "c", id: "cc" }, choice(threadId)),
      createElement("div", { key: "box", "data-tour": "composer" }, createElement(Composer, { bot: dog(threadId) })))));
    const inCard = async (id: string, name: string) => {
      const button = [...host.querySelectorAll<HTMLButtonElement>(`#${id} button`)].find((candidate) => candidate.textContent?.trim().endsWith(name))!;
      await act(async () => button.click());
    };
    await inCard("cc", "Other");
    expect([...host.querySelectorAll("[data-question-typing]")].map((note) => note.closest("section")!.id)).toEqual(["cc"]);
    await enter();
    expect(actions()).toEqual([expect.objectContaining({ type: "decideRequest", requestId: "req-c", message: "gamma" })]);
    expect(host.querySelectorAll("[data-question-typing]")).toHaveLength(0);
  });

  it("when the card closes while the person types, keeps the words, lets go of Other and says the question was answered", async () => {
    const threadId = `thread-${++n}`;
    appendComposerDraft(`bot:biscuit:${threadId}`, "gamma");
    const card = (answered?: string) => createElement(OptionCard, {
      key: "c", botId: "biscuit", threadId,
      message: { id: "c", role: "bot", kind: "options", at: 1, card: { title: "Which name?", subtitle: "", options: ["alpha", "beta"], requestId: "req-c", requestType: "question", ...(answered ? { answered } : {}) } } as Message,
    });
    const draw = (answered?: string) => act(async () => root.render(createElement(Fragment, null, card(answered), createElement("div", { key: "box", "data-tour": "composer" }, createElement(Composer, { bot: dog(threadId) })))));
    await draw();
    await click("Other");
    await draw("beta");
    const box = host.querySelector("textarea")!;
    expect(box.value).toBe("gamma");
    expect(box.placeholder).not.toBe("Or type your own answer");
    expect(host.querySelector("[data-typed-answer-closed]")?.textContent).toBe("This question was answered. Your words are still here.");
    expect(host.querySelector("[data-option-other]")).toBeNull();
    await enter();
    expect(actions()).toEqual([expect.objectContaining({ type: "send", text: "gamma" })]);
    expect(host.querySelector("[data-typed-answer-closed]")).toBeNull();
  });

  it("when a file goes with the typed answer, sends nothing, keeps the words, the file and Other, and says an answer can't carry it", async () => {
    const threadId = `thread-${++n}`;
    restoreComposerDraft(`bot:biscuit:${threadId}`, { text: "see the picture", attachments: [{ kind: "file", id: "f1", path: "/work/notes.txt", name: "notes.txt", size: 4 }] });
    await act(async () => root.render(createElement(Fragment, null, question(threadId), createElement("div", { "data-tour": "composer" }, createElement(Composer, { bot: dog(threadId) })))));
    await click("Red");
    await enter();
    expect(actions()).toEqual([]);
    expect(host.querySelector("textarea")!.value).toBe("see the picture");
    expect(host.textContent).toContain("notes.txt");
    expect(host.querySelector("[data-typed-answer-files]")?.textContent).toBe("An answer can't carry attachments. Remove them to send your answer.");
    expect(typedAnswerFor(threadId)).not.toBeNull();
  });
});
