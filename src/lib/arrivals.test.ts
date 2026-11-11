import { describe, expect, it } from "vitest";

import { arrived, settle } from "./arrivals";

describe("arrivals", () => {
  it("settles the rows present when a chat opens, so none of them arrives", () => {
    const opened = settle(null, "bot-1/thread-1", ["a", "b"]);
    expect(arrived(opened, "a")).toBe(false);
    expect(arrived(opened, "b")).toBe(false);
  });

  it("marks a row that shows up later as arriving, for as long as the chat is open", () => {
    const opened = settle(null, "bot-1/thread-1", ["a"]);
    const later = settle(opened, "bot-1/thread-1", ["a", "b"]);
    expect(arrived(later, "a")).toBe(false);
    expect(arrived(later, "b")).toBe(true);
    const again = settle(later, "bot-1/thread-1", ["a", "b"]);
    expect(again).toBe(later);
    expect(arrived(settle(again, "bot-1/thread-1", ["a", "b", "c"]), "b")).toBe(true);
  });

  it("settles afresh for another chat, so switching never replays old rows", () => {
    const first = settle(settle(null, "bot-1/thread-1", ["a"]), "bot-1/thread-1", ["a", "b"]);
    const switched = settle(first, "bot-2/thread-2", ["x", "y", "b"]);
    expect(switched).not.toBe(first);
    expect(arrived(switched, "x")).toBe(false);
    expect(arrived(switched, "b")).toBe(false);
  });

  it("never counts older rows filled in above the ones already shown as arriving", () => {
    const tail = Array.from({ length: 30 }, (_, index) => `m${90 + index}`);
    const opened = settle(null, "bot-1/thread-1", tail);
    const wider = Array.from({ length: 60 }, (_, index) => `m${60 + index}`);
    const filling = settle(opened, "bot-1/thread-1", wider);
    expect(wider.filter((id) => arrived(filling, id))).toEqual([]);
    const all = Array.from({ length: 121 }, (_, index) => `m${index}`);
    const filled = settle(filling, "bot-1/thread-1", all);
    expect(all.filter((id) => arrived(filled, id))).toEqual(["m120"]);
  });

  it("keeps older rows settled when they come in together with a new one, and after the new one", () => {
    const opened = settle(null, "bot-1/thread-1", ["c", "d"]);
    const both = settle(opened, "bot-1/thread-1", ["b", "c", "d", "e"]);
    expect(["b", "c", "d", "e"].filter((id) => arrived(both, id))).toEqual(["e"]);
    const earlier = settle(both, "bot-1/thread-1", ["a", "b", "c", "d", "e"]);
    expect(arrived(earlier, "a")).toBe(false);
    expect(arrived(earlier, "e")).toBe(true);
  });

  it("lets the first rows of a chat that opened empty arrive, and settles what fills in above them", () => {
    const opened = settle(null, "bot-1/thread-1", []);
    const loaded = settle(opened, "bot-1/thread-1", ["y", "z"]);
    expect(arrived(loaded, "y")).toBe(true);
    expect(arrived(settle(loaded, "bot-1/thread-1", ["x", "y", "z"]), "x")).toBe(false);
  });
});
