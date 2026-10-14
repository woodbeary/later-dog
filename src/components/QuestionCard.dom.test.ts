// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import { QUESTION_DISMISS_MESSAGE } from "../../shared/ask-question";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: fixture.dispatch }) }));
import { QuestionCard } from "./QuestionCard";

let host: HTMLDivElement;
let composer: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  composer = document.createElement("div");
  composer.dataset.tour = "composer";
  composer.append(document.createElement("textarea"));
  host = document.createElement("div");
  document.body.append(host, composer);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  composer.remove();
  fixture.dispatch.mockReset();
});

function question(card: Partial<NonNullable<Message["card"]>> = {}): Message {
  return {
    id: "m-1",
    role: "bot",
    kind: "options",
    at: 0,
    card: {
      title: "Your dog has a question",
      options: [],
      requestId: "req-1",
      requestType: "question",
      questionRequest: {
        version: 1,
        questions: [{ question: "What should I help with first?", options: [{ label: "Code and GitHub" }, { label: "Research and writing" }] }],
      },
      ...card,
    },
  } as Message;
}

function mount(message: Message) {
  act(() => root.render(createElement(QuestionCard, { threadId: "thread-1", bot: { name: "Biscuit" }, message })));
}

const closeButton = () => host.querySelector<HTMLButtonElement>("[data-question-close]");
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("closing a dog's question", () => {
  it("ends the dog's wait with the close note, hides the card and hands the person the composer", async () => {
    mount(question());
    expect(closeButton()?.getAttribute("aria-label")).toBe("Close question");
    act(() => closeButton()?.click());
    expect(host.textContent).toBe("");
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({
      type: "decideRequest",
      threadId: "thread-1",
      requestId: "req-1",
      behavior: "answer",
      message: QUESTION_DISMISS_MESSAGE,
    });
    await act(nextFrame);
    expect(document.activeElement).toBe(composer.querySelector("textarea"));
  });

  it("brings the question back when the close does not reach the dog", () => {
    mount(question());
    act(() => closeButton()?.click());
    expect(host.textContent).toBe("");
    act(() => fixture.dispatch.mock.calls[0]![0].onError("offline"));
    expect(host.textContent).toContain("What should I help with first?");
    expect(closeButton()).not.toBeNull();
  });

  it("offers no × on an answered question, and draws nothing once closed", () => {
    mount(question({ answered: "answer", answeredText: "Code and GitHub" }));
    expect(host.textContent).toContain("Code and GitHub");
    expect(closeButton()).toBeNull();
    mount(question({ answered: "answer", dismissed: true }));
    expect(host.textContent).toBe("");
  });
});

describe("answering a dog's question", () => {
  it("sends a single choice the moment it is picked", () => {
    mount(question());
    const option = [...host.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((button) => button.textContent?.includes("Research and writing"));
    act(() => option?.click());
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "answer", message: expect.stringContaining("A: Research and writing") });
  });

  it("waits for Submit when there is more than one question", () => {
    mount(question({
      questionRequest: {
        version: 1,
        questions: [
          { question: "What first?", options: [{ label: "Code" }, { label: "Writing" }] },
          { question: "How often?", options: [{ label: "Daily" }, { label: "Weekly" }] },
        ],
      },
    }));
    act(() => host.querySelector<HTMLButtonElement>("[role=radio]")?.click());
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });
});


describe("a card with several questions", () => {
  const several = () => question({
    questionRequest: {
      version: 1,
      questions: [
        { question: "What first?", options: [{ label: "Code" }, { label: "Writing" }] },
        { question: "How often?", options: [{ label: "Daily" }, { label: "Weekly" }] },
        { question: "Which days?", multiSelect: true, options: [{ label: "Mon" }, { label: "Tue" }] },
      ],
    },
  });
  const option = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>("[role=radio],[role=checkbox]")].find((button) => button.textContent?.includes(label))!;
  const nextButton = () => host.querySelector<HTMLButtonElement>("[data-question-next]");
  const backButton = () => host.querySelector<HTMLButtonElement>("[data-question-back]")!;
  const submitButton = () => host.querySelector<HTMLButtonElement>("[data-question-submit]");
  const step = () => host.querySelector("[data-question-step]")?.textContent;

  it("shows one question at a time with its place in the card", () => {
    mount(several());
    expect(step()).toBe("1 of 3");
    expect(host.textContent).toContain("What first?");
    expect(host.textContent).not.toContain("How often?");
    expect(nextButton()?.disabled).toBe(true);
    expect(backButton().disabled).toBe(true);
  });

  it("moves on by itself after a single choice and goes back with Back", () => {
    mount(several());
    act(() => option("Writing").click());
    expect(step()).toBe("2 of 3");
    expect(host.textContent).toContain("How often?");
    act(() => backButton().click());
    expect(step()).toBe("1 of 3");
    expect(option("Writing").getAttribute("aria-checked")).toBe("true");
    expect(nextButton()?.disabled).toBe(false);
    act(() => nextButton()!.click());
    expect(step()).toBe("2 of 3");
  });

  it("jumps to a question from its tab", () => {
    mount(several());
    act(() => host.querySelectorAll<HTMLButtonElement>("[role=tab]")[2]!.click());
    expect(step()).toBe("3 of 3");
    expect(host.textContent).toContain("Which days?");
  });

  it("holds multi-select questions until Next and sends everything from the last step", () => {
    mount(several());
    act(() => option("Code").click());
    act(() => option("Weekly").click());
    expect(step()).toBe("3 of 3");
    act(() => option("Mon").click());
    act(() => option("Tue").click());
    expect(step()).toBe("3 of 3");
    expect(nextButton()).toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    act(() => submitButton()!.click());
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    const sent = fixture.dispatch.mock.calls[0]![0];
    expect(sent).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "answer" });
    expect(sent.message).toContain("A: Code");
    expect(sent.message).toContain("A: Weekly");
    expect(sent.message).toContain("A: Mon, Tue");
    expect(host.querySelector("[data-folded-line]")?.textContent).toContain("Code");
    expect(host.querySelector("[role=radio]")).toBeNull();
  });

  it("keeps Submit off until every question has an answer", () => {
    mount(several());
    act(() => host.querySelectorAll<HTMLButtonElement>("[role=tab]")[2]!.click());
    act(() => option("Mon").click());
    expect(submitButton()?.disabled).toBe(true);
  });
});


describe("folded answers", () => {
  it("folds immediately, expands read-only and folds again", () => {
    mount(question());
    act(() => host.querySelector<HTMLButtonElement>("[role=radio]")?.click());
    const line = host.querySelector<HTMLButtonElement>("[data-folded-line]")!;
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("[role=radio]")).toBeNull();
    expect(host.textContent).toBe("Code and GitHub");
    act(() => line.click());
    expect(line.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("What should I help with first?");
    expect(host.querySelector("[role=radio]")).toBeNull();
    act(() => line.click());
    expect(host.textContent).toBe("Code and GitHub");
  });

  it("opens again when sending fails", () => {
    mount(question());
    act(() => host.querySelector<HTMLButtonElement>("[role=radio]")?.click());
    act(() => fixture.dispatch.mock.calls[0]![0].onError("offline"));
    expect(host.querySelector("[data-folded-line]")).toBeNull();
    expect(host.querySelector("[role=radio]")).not.toBeNull();
  });

  it("loads a saved answer folded", () => {
    mount(question({ answered: "answer", answeredText: "Code and GitHub" }));
    expect(host.querySelector("[data-folded-line]")?.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).toBe("Code and GitHub");
  });
});
