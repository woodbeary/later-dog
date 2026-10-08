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
    expect(later).toBe(opened);
    expect(arrived(later, "b")).toBe(true);
    expect(arrived(settle(later, "bot-1/thread-1", ["a", "b", "c"]), "b")).toBe(true);
  });

  it("settles afresh for another chat, so switching never replays old rows", () => {
    const first = settle(null, "bot-1/thread-1", ["a"]);
    const switched = settle(first, "bot-2/thread-2", ["x", "y"]);
    expect(switched).not.toBe(first);
    expect(arrived(switched, "x")).toBe(false);
    expect(arrived(switched, "a")).toBe(true);
  });
});
