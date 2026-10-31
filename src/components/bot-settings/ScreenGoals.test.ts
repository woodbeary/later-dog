// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type Bot } from "@/state/store";
import { GOALS_SETTLE_MS, ScreenGoals, STEPS_SHOWN } from "./ScreenGoals";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(api).mockReset().mockReturnValue(new Promise(() => {}));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

type Messages = NonNullable<Bot["messages"]>;
const ask = (id: string, at: number, text: string) => ({ id, role: "user", kind: "text", text, at }) as Messages[number];
const step = (id: string, at: number, name: string, input?: string, ok = true) => ({ id, role: "bot", kind: "activity", at, tool: { name, ok, input } }) as Messages[number];
const show = (messages: Messages, busy = false) => act(() => root.render(createElement(ScreenGoals, { bot: { messages, busy, threadId: "thread-1" } })));

describe("goals on the dog's Computer tab", () => {
  it("shows nothing until the dog has used its computer for a request", () => {
    show([ask("u1", 1, "Hi")]);
    expect(host.querySelector("[data-screen-goals]")).toBeNull();
  });

  it("shows the latest goal working while the dog is busy, with the steps it took", () => {
    show([ask("u1", 1, "Book a table"), step("s1", 2, "mcp__computer__open_url", '{"url":"https://example.com"}'), step("s2", 3, "mcp__computer__type_text", '{"text":"two people"}'), step("s3", 4, "mcp__computer__click", undefined, false)], true);
    const card = host.querySelector("[data-goal]")!;
    expect(card.getAttribute("data-goal-status")).toBe("working");
    expect(card.textContent).toContain("Book a table");
    expect([...card.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Opened example.com", "Typed 10 characters", "ClickedDidn't work"]);
    expect(card.textContent).not.toContain("two people");
  });

  it("calls a finished goal done, and moves between goals with the dots", () => {
    show([ask("u1", 1, "First"), step("s1", 2, "mcp__computer__click"), ask("u2", 3, "Second"), step("s2", 4, "mcp__computer__scroll")]);
    expect(host.querySelector("[data-goal]")!.getAttribute("data-goal-status")).toBe("done");
    const dots = [...host.querySelectorAll<HTMLButtonElement>("[data-goal-dots] button")];
    expect(dots.map((dot) => dot.getAttribute("aria-label"))).toEqual(["Goal 1 of 2", "Goal 2 of 2"]);
    expect(dots[1]!.getAttribute("aria-current")).toBe("step");
    expect(host.querySelector("[data-goal]")!.textContent).toContain("Second");
    act(() => dots[0]!.click());
    expect(host.querySelector("[data-goal]")!.textContent).toContain("First");
    expect(host.querySelector("[data-goal-dots] button")!.getAttribute("aria-current")).toBe("step");
  });

  it("shows the last few steps, and all of them on request", () => {
    const steps = Array.from({ length: STEPS_SHOWN + 3 }, (_, index) => step(`s${index}`, index + 2, "mcp__computer__click"));
    show([ask("u1", 1, "Click a lot"), ...steps]);
    expect(host.querySelectorAll("li")).toHaveLength(STEPS_SHOWN);
    const more = [...host.querySelectorAll("button")].find((button) => button.textContent === `Show all ${STEPS_SHOWN + 3} steps`)!;
    act(() => more.click());
    expect(host.querySelectorAll("li")).toHaveLength(STEPS_SHOWN + 3);
  });

  it("asks the server for goals from the whole conversation once the chat settles", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api).mockResolvedValue({ goals: [{ id: "u0", text: "Post the launch note", at: 1, latest: false, steps: [{ id: "s0", at: 2, action: "open", detail: "x.com", ok: true }] }] });
      show([ask("u9", 90, "Thanks")]);
      expect(host.querySelector("[data-screen-goals]")).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(GOALS_SETTLE_MS); });
      expect(api).toHaveBeenCalledWith("/api/threads/thread-1/screen-goals");
      expect(host.querySelector("[data-goal]")!.textContent).toContain("Post the launch note");
      expect([...host.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Opened x.com"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the goals it can see when the server can't answer", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(api).mockRejectedValue(new Error("no route"));
      show([ask("u1", 1, "Check the page"), step("s1", 2, "mcp__computer__screenshot")]);
      await act(async () => { await vi.advanceTimersByTimeAsync(GOALS_SETTLE_MS); });
      expect(host.querySelector("[data-goal]")!.textContent).toContain("Check the page");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a long goal until the person shows all of it", () => {
    show([ask("u1", 1, "a".repeat(400)), step("s1", 2, "mcp__computer__click")]);
    const text = host.querySelector("[data-goal] p")!;
    expect(text.className).toContain("line-clamp-3");
    const toggle = [...host.querySelectorAll("button")].find((button) => button.textContent === "Show full goal")!;
    act(() => toggle.click());
    expect(text.className).not.toContain("line-clamp-3");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });
});
