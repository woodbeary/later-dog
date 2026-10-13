// @vitest-environment happy-dom
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isUnread, markSeen, seenAt, unreadSince, useUnreadBoundary, type SeenRow } from "./unread-boundary";

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const bot = (at: number): SeenRow => ({ role: "bot", at });
const person = (at: number): SeenRow => ({ role: "user", at });

describe("remembering what the person has seen", () => {
  it("keeps the latest time per conversation and never moves backwards", () => {
    const store = memoryStore();
    expect(seenAt("pepper/main", store)).toBeNull();
    markSeen("pepper/main", 200, store);
    markSeen("pepper/main", 150, store);
    markSeen("rio/main", 90, store);
    expect(seenAt("pepper/main", store)).toBe(200);
    expect(seenAt("rio/main", store)).toBe(90);
  });

  it("shrugs off a broken or missing store", () => {
    const store = memoryStore();
    store.setItem("laterdog-seen-at", "{not json");
    expect(seenAt("pepper/main", store)).toBeNull();
    store.setItem("laterdog-seen-at", JSON.stringify({ "pepper/main": "soon", "rio/main": 40 }));
    expect(seenAt("pepper/main", store)).toBeNull();
    expect(seenAt("rio/main", store)).toBe(40);
    expect(() => markSeen("pepper/main", 10, undefined)).not.toThrow();
  });
});

describe("where the New line goes", () => {
  it("only counts what someone else said after the person last looked", () => {
    expect(isUnread(bot(11), 10)).toBe(true);
    expect(isUnread(bot(10), 10)).toBe(false);
    expect(isUnread(person(30), 10)).toBe(false);
    expect(isUnread(bot(30), null)).toBe(false);
  });

  it("draws nothing on a first visit or when nothing new arrived", () => {
    expect(unreadSince([bot(5), bot(20)], null)).toBeNull();
    expect(unreadSince([bot(5), person(20)], 10)).toBeNull();
    expect(unreadSince([bot(5), bot(20)], 10)).toBe(10);
  });
});

describe("while the chat is open", () => {
  let host: HTMLDivElement;
  let root: Root;
  let seen: number | null | undefined;
  let focused = true;

  function Probe({ thread, rows }: { thread: string; rows: SeenRow[] }) {
    seen = useUnreadBoundary(thread, rows);
    return null;
  }

  const show = (rows: SeenRow[], thread = "pepper/main") => flushSync(() => root.render(createElement(Probe, { thread, rows })));

  beforeEach(() => {
    localStorage.clear();
    focused = true;
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  it("marks everything seen on a first visit without drawing a line", () => {
    show([bot(10), bot(20)]);
    expect(seen).toBeNull();
    expect(seenAt("pepper/main")).toBe(20);
  });

  it("never draws a line over replies that arrive while the person is watching", () => {
    show([bot(10)]);
    show([bot(10), bot(20)]);
    show([bot(10), bot(20), bot(30)]);
    expect(seen).toBeNull();
    expect(seenAt("pepper/main")).toBe(30);
  });

  it("marks the replies that came in while the person was away once they come back", () => {
    show([bot(10)]);
    focused = false;
    window.dispatchEvent(new Event("blur"));
    show([bot(10), bot(20), bot(30)]);
    expect(seenAt("pepper/main")).toBe(10);
    expect(seen).toBeNull();

    focused = true;
    flushSync(() => window.dispatchEvent(new Event("focus")));
    expect(seen).toBe(10);
    expect(seenAt("pepper/main")).toBe(30);

    show([bot(10), bot(20), bot(30), bot(40)]);
    expect(seen).toBe(10);
  });

  it("drops the line on the next return when nothing new came in", () => {
    show([bot(10)]);
    focused = false;
    show([bot(10), bot(20)]);
    focused = true;
    flushSync(() => window.dispatchEvent(new Event("focus")));
    expect(seen).toBe(10);
    flushSync(() => window.dispatchEvent(new Event("focus")));
    expect(seen).toBeNull();
  });

  it("opens another conversation at its own last look", () => {
    markSeen("rio/main", 15);
    show([bot(10), bot(20)], "rio/main");
    expect(seen).toBe(15);
    show([bot(10)], "pepper/main");
    expect(seen).toBeNull();
  });

  it("waits for the conversation to load before deciding", () => {
    markSeen("pepper/main", 15);
    show([]);
    expect(seen).toBeNull();
    expect(seenAt("pepper/main")).toBe(15);
    show([bot(10), bot(20)]);
    expect(seen).toBe(15);
    expect(seenAt("pepper/main")).toBe(20);
  });
});
