import { describe, expect, it, vi } from "vitest";

import { inputText, SteerReads } from "./steer-reads.ts";

describe("inputText", () => {
  it("reads plain strings and the text parts of structured input", () => {
    expect(inputText("hello")).toBe("hello");
    expect(inputText([{ type: "text", text: "one" }, { type: "image", url: "x" }, { type: "text", text: "two" }])).toBe("one\ntwo");
    expect(inputText(undefined)).toBe("");
    expect(inputText([null, 3, { type: "text" }])).toBe("");
  });
});

describe("SteerReads", () => {
  it("marks a steer read once the turn takes in input containing its words", () => {
    const reads = new SteerReads();
    const read = vi.fn();
    reads.expect("and also this", read);
    reads.seen([{ type: "text", text: "something else" }]);
    expect(read).not.toHaveBeenCalled();
    reads.seen([{ type: "text", text: "[queued]\nand also this" }]);
    reads.seen("and also this");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("marks several steers taken in together", () => {
    const reads = new SteerReads();
    const first = vi.fn();
    const second = vi.fn();
    reads.expect("first aside", first);
    reads.expect("second aside", second);
    reads.seen("first aside\n\nsecond aside");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("never marks a forgotten steer", () => {
    const reads = new SteerReads();
    const read = vi.fn();
    const forget = reads.expect("refused words", read);
    forget();
    reads.seen("refused words");
    expect(read).not.toHaveBeenCalled();
  });

  it("ignores steers with no listener or no words", () => {
    const reads = new SteerReads();
    const read = vi.fn();
    reads.expect("", read)();
    reads.expect("words", undefined)();
    reads.seen("words");
    expect(read).not.toHaveBeenCalled();
  });
});
