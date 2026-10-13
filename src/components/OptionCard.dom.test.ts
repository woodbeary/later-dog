// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { bots: [{ id: "bot-1", name: "Biscuit", threadId: "thread-1" }] }, dispatch: fixture.dispatch }),
  visibleMessages: () => [],
}));
import { OptionCard } from "./OptionCard";

let host: HTMLDivElement;
let root: Root;
const question = (card: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: "m-1", role: "bot", kind: "options", at: 0,
  card: { title: "Pick one", subtitle: "What should we do?", options: ["Ship it", "Hold"], requestId: "req-1", requestType: "question", ...card },
});
const mount = (message = question(), groupId?: string) => act(() => root.render(createElement(OptionCard, { botId: "bot-1", threadId: groupId ? "room-thread" : "thread-1", groupId, message })));
const line = () => host.querySelector<HTMLButtonElement>("[data-folded-line]");
const choose = () => act(() => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "AShip it")?.click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  fixture.dispatch.mockReset();
  vi.unstubAllGlobals();
});

describe("answered option cards", () => {
  it("folds before the request finishes and expands read-only", () => {
    mount();
    choose();
    expect(line()?.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).toBe("Ship it");
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({ type: "decideRequest", threadId: "thread-1", requestId: "req-1", message: "Ship it" });
    act(() => line()?.click());
    expect(line()?.getAttribute("aria-expanded")).toBe("true");
    expect(host.textContent).toContain("What should we do?");
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.disabled)).toHaveLength(2);
    expect(host.querySelector("input")).toBeNull();
    act(() => line()?.click());
    expect(host.textContent).toBe("Ship it");
  });

  it("restores the open choices after a failed answer", () => {
    mount();
    choose();
    act(() => fixture.dispatch.mock.calls[0]![0].onError("offline"));
    expect(line()).toBeNull();
    expect(host.textContent).toContain("What should we do?");
    expect(host.querySelector("button[disabled]")).toBeNull();
  });

  it("folds a persisted answer after reload", () => {
    mount(question({ answered: "answer", answeredText: "Ship it" }));
    expect(line()?.getAttribute("aria-expanded")).toBe("false");
    expect(host.textContent).toBe("Ship it");
  });

  it("sends room answers to the room thread", () => {
    mount(question(), "room-1");
    choose();
    expect(fixture.dispatch.mock.calls[0]![0]).toMatchObject({ threadId: "room-thread", message: "Ship it" });
    expect(host.textContent).toBe("Ship it");
  });

  it("keeps answered onboarding and dismissed questions hidden", () => {
    mount(question({ requestId: undefined, answered: "Ship it" }));
    expect(host.textContent).toBe("");
    mount(question({ dismissed: true, answered: "answer" }));
    expect(host.textContent).toBe("");
  });
});
