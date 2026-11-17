// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

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

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
const key = (name: string, target: EventTarget = document.body) => act(() => { target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); });

describe("a dog's question card", () => {
  it("has no ×, no eyebrow and no tabs, and leads with the question", () => {
    mount(question());
    expect(host.querySelector("[data-question-close]")).toBeNull();
    expect(host.querySelector("[role=tab]")).toBeNull();
    expect(host.textContent).not.toContain("has a question");
    expect(host.querySelector("[data-question-card]")!.firstElementChild!.textContent).toBe("What should I help with first?");
  });

  it("numbers each option and draws no row for Other", () => {
    mount(question());
    expect([...host.querySelectorAll("[data-question-option]")].map((row) => row.textContent)).toEqual(["1Code and GitHub", "2Research and writing"]);
    expect(host.textContent).not.toContain("Other");
  });

  it("settles a provider-resolved native question neutrally without leaving answer actions open", () => {
    mount(question());
    mount(question({ answered: "resolved", answeredText: "Resolved by Codex", nativeActorLabel: "Researcher", dismissed: false }));
    expect(host.textContent).toContain("Resolved by Codex");
    expect(host.textContent).toContain("Requested by Researcher");
    expect(host.querySelector('[data-folded-line]')?.getAttribute("aria-label")).toBe("Resolved by Codex");
    act(() => host.querySelector<HTMLButtonElement>("[data-folded-line]")!.click());
    expect(host.querySelectorAll('[role="radio"], [data-question-submit], textarea')).toHaveLength(0);
    expect(host.querySelector(".text-success")).toBeNull();
    expect(host.textContent).not.toContain("Waiting for");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("draws nothing once dismissed", () => {
    mount(question({ answered: "answer", dismissed: true }));
    expect(host.textContent).toBe("");
  });
});

describe("answering a dog's question", () => {
  it("shows a check on a single pick, holds it 600 ms, then sends", async () => {
    mount(question());
    const option = [...host.querySelectorAll<HTMLButtonElement>("[role=radio]")].find((button) => button.textContent?.includes("Research and writing"));
    act(() => option?.click());
    expect(option!.querySelector("[data-question-check]")).not.toBeNull();
    expect(fixture.dispatch).not.toHaveBeenCalled();
    await wait(650);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({ type: "decideRequest", requestId: "req-1", behavior: "answer", message: expect.stringContaining("A: Research and writing") });
  });

  it("picks an option with keys 1 to 9", async () => {
    mount(question());
    await key("3");
    await key("2");
    await wait(650);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0]![0].message).toContain("A: Research and writing");
  });

  it("leaves a digit typed in a text field to the field", async () => {
    mount(question());
    await key("1", composer.querySelector("textarea")!);
    await wait(650);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("waits for Send when there is more than one question", () => {
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

  it("keeps Send off until every question has an answer", () => {
    mount(several());
    act(() => option("Code").click());
    act(() => option("Weekly").click());
    expect(submitButton()?.disabled).toBe(true);
    expect(submitButton()?.textContent).toBe("Send");
    act(() => option("Mon").click());
    expect(submitButton()?.disabled).toBe(false);
  });
});


describe("folded answers", () => {
  it("folds once sent, expands read-only and folds again", async () => {
    mount(question());
    act(() => host.querySelector<HTMLButtonElement>("[role=radio]")?.click());
    await wait(650);
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

  it("opens again when sending fails", async () => {
    mount(question());
    act(() => host.querySelector<HTMLButtonElement>("[role=radio]")?.click());
    await wait(650);
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
