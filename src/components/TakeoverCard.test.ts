// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BotEditorStore, initialState, reducer, type AppState, type Message } from "@/state/store";
import type { TakeoverRequestCardData, TakeoverStatus } from "../../shared/takeover";
import { TakeoverCard } from "./TakeoverCard";

const request = (status: TakeoverStatus, patch: Partial<TakeoverRequestCardData> = {}): TakeoverRequestCardData => ({
  step: "Sign in to iCloud",
  reason: "sign-in",
  helpRequestId: "pepper-1",
  status,
  place: "cloud",
  ...patch,
});

const message = (takeoverRequest: TakeoverRequestCardData): Message => ({
  id: "card-1",
  role: "bot",
  kind: "options",
  at: 1,
  card: { title: "Computer", subtitle: takeoverRequest.step, options: [], takeoverRequest },
});

const words = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

function render(takeoverRequest: TakeoverRequestCardData): string {
  return words(renderToStaticMarkup(createElement(BotEditorStore, {
    value: { state: initialState, dispatch: vi.fn() } as never,
    children: createElement(TakeoverCard, { botId: "pepper", botName: "Pepper", threadId: "pepper-thread", message: message(takeoverRequest) }),
  })));
}

describe("the Take over card", () => {
  it("asks for just the one step, with Take over, I'm done and Skip", () => {
    const text = render(request("waiting"));
    expect(text).toContain("Computer");
    expect(text).toContain("Sign in to iCloud");
    expect(text).toContain("Take over");
    expect(text).toContain("I'm done");
    expect(text).toContain("Skip");
    expect(text).not.toContain("Open computer");
  });

  it("tells the person their password stays out of chat and where the sign-in lives", () => {
    expect(render(request("waiting"))).toContain("your password never goes in the chat. It stays signed in on Pepper's cloud computer.");
    expect(render(request("waiting", { place: "local" }))).toContain("It stays signed in on this computer.");
    expect(render(request("waiting", { reason: "captcha", step: "Solve the puzzle" }))).not.toContain("password");
  });

  it("shows who is in control and lets them hand back", () => {
    const text = render(request("in-control"));
    expect(text).toContain("You're in control");
    expect(text).toContain("Open computer");
    expect(text).toContain("I'm done");
    expect(text).not.toContain("Take over");
  });

  it("settles to a quiet record once it ends", () => {
    const done = render(request("done"));
    expect(done).toContain("Done");
    expect(done).toContain("Open computer");
    expect(done).not.toMatch(/Take over|I'm done|Skip|password/);
    expect(render(request("skipped"))).toContain("Skipped");
    expect(render(request("replied"))).not.toMatch(/Done|Skipped|Take over/);
  });
});

describe("tapping Take over", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("hands the screen over, then opens the computer with the live desktop on its way", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ status: "in-control" }), { status: 200 });
    }));
    let state: AppState = { ...initialState, selectedId: "pack" };
    const dispatch = vi.fn((action: Parameters<typeof reducer>[1]) => {
      state = reducer(state, action);
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(BotEditorStore, {
      value: { state, dispatch } as never,
      children: createElement(TakeoverCard, { botId: "pepper", botName: "Pepper", threadId: "pack-thread", message: message(request("waiting")) }),
    })));

    const takeOver = [...host.querySelectorAll("button")].find((button) => button.textContent === "Take over")!;
    flushSync(() => takeOver.click());
    await vi.waitFor(() => expect(state.computerOpen).toBe(true));

    expect(calls).toEqual([{ url: "/api/bots/pepper/takeover-cards/card-1/take", body: { threadId: "pack-thread" } }]);
    expect(dispatch.mock.calls.map(([action]) => action.type)).toEqual(["select", "takeoverIntent", "toggleComputer"]);
    expect(state.takeoverIntent).toMatchObject({ botId: "pepper" });
    root.unmount();
  });

  it("says so and leaves the screen alone when the hand-over fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "this request already ended" }), { status: 409 })));
    const dispatch = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(createElement(BotEditorStore, {
      value: { state: { ...initialState, selectedId: "pepper" }, dispatch } as never,
      children: createElement(TakeoverCard, { botId: "pepper", botName: "Pepper", threadId: "pepper-thread", message: message(request("waiting")) }),
    })));

    const takeOver = [...host.querySelectorAll("button")].find((button) => button.textContent === "Take over")!;
    flushSync(() => takeOver.click());
    await vi.waitFor(() => expect(host.querySelector("[role=alert]")?.textContent).toBe("That didn't go through. Try again."));
    expect(dispatch).not.toHaveBeenCalled();
    root.unmount();
  });
});

describe("closing the computer panel", () => {
  it("drops a pending hand-over so it never opens the desktop later by surprise", () => {
    const pending = reducer({ ...initialState, takeoverIntent: { botId: "pepper", at: 1 } }, { type: "toggleComputer", open: true });
    expect(pending.takeoverIntent).toEqual({ botId: "pepper", at: 1 });
    expect(reducer(pending, { type: "toggleComputer", open: false }).takeoverIntent).toBeNull();
  });
});
