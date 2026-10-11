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
