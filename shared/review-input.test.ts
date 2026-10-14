import { describe, expect, it } from "vitest";

import { REVIEW_INPUT_MAX, reviewInputOf, reviewInputText, reviewInputWasCut } from "./review-input.ts";

describe("what a request is reviewed on", () => {
  it("carries every argument, including a prompt next to a url", () => {
    const input = reviewInputOf({ url: "https://example.com/docs", prompt: "Summarise the page for me" })!;
    expect(input.fields).toEqual([
      { key: "url", value: "https://example.com/docs" },
      { key: "prompt", value: "Summarise the page for me" },
    ]);
    expect(reviewInputText(input)).toBe("url: https://example.com/docs; prompt: Summarise the page for me");
    expect(reviewInputWasCut(input)).toBe(false);
  });

  it("counts the whole input, so a long padded url is cut even when the front looks harmless", () => {
    const url = `https://example.com/?q=${"a".repeat(900)}&next=http://evil.example`;
    const input = reviewInputOf({ url })!;
    expect(input.length).toBeGreaterThan(REVIEW_INPUT_MAX);
    expect(reviewInputWasCut(input)).toBe(true);
    expect(input.fields[0]!.value.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX);
  });

  it("counts a long argument of an MCP or task call, and nested values", () => {
    expect(reviewInputWasCut(reviewInputOf({ query: "x".repeat(700) })!)).toBe(true);
    expect(reviewInputWasCut(reviewInputOf({ args: { nested: ["a", "b".repeat(700)] } })!)).toBe(true);
    expect(reviewInputWasCut(reviewInputOf({ description: "short", prompt: "also short" })!)).toBe(false);
  });

  it("counts secrets by their real length and masks them", () => {
    const secret = `sk-ant-${"a".repeat(700)}`;
    const input = reviewInputOf({ command: `curl -H "x-key: ${secret}" https://example.com` })!;
    expect(reviewInputWasCut(input)).toBe(true);
    expect(JSON.stringify(input)).not.toContain(secret);
  });

  it("treats too many fields as too long, and survives odd values", () => {
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, "v"]));
    expect(reviewInputWasCut(reviewInputOf(many)!)).toBe(true);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(reviewInputWasCut(reviewInputOf(cyclic)!)).toBe(true);
    expect(reviewInputOf(undefined)).toBeUndefined();
    expect(reviewInputOf("rm file")!.fields).toEqual([{ key: "input", value: "rm file" }]);
  });

  it("leaves out the keys it is told to", () => {
    expect(reviewInputOf({ threadId: "t", command: "ls" }, { skip: ["threadId"] })!.fields).toEqual([{ key: "command", value: "ls" }]);
  });
});
