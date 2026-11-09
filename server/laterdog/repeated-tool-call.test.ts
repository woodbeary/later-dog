import { describe, expect, it } from "vitest";
import { toolArgsDigest } from "./repeated-tool-call.ts";
import { RepeatDetector, callKey, repeatedCallLine } from "../repeat-detector.ts";

const summary = 'Allow the agents MCP server to run tool "dog_queue"?';

function run(inputs: unknown[]) {
  const detector = new RepeatDetector({ thresholds: [5] });
  const hits: number[] = [];
  for (const input of inputs) {
    const key = callKey("dog_queue", summary, toolArgsDigest(input))!;
    const { threshold } = detector.record("t", key);
    if (threshold) hits.push(threshold);
  }
  return hits;
}

describe("repeated tool call identity", () => {
  it("does not warn for five dog_queue calls on different dogs", () => {
    expect(run(["a", "b", "c", "d", "e"].map((dog) => ({ dog })))).toEqual([]);
  });

  it("warns for five identical calls, whatever the key order", () => {
    expect(run([{ dog: "a", n: 1 }, { n: 1, dog: "a" }, { dog: "a", n: 1 }, { dog: "a", n: 1 }, { n: 1, dog: "a" }])).toEqual([5]);
  });

  it("keeps unknown operations without args on the summary alone", () => {
    expect(run([undefined, null, {}, undefined, undefined])).toEqual([5]);
    expect(toolArgsDigest({ dog: "a" })).not.toBe(toolArgsDigest(undefined));
  });

  it("is a bounded digest that never carries the argument text", () => {
    const digest = toolArgsDigest({ token: "sk-secret-value".repeat(1000) })!;
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it("leaves the displayed warning wording unchanged", () => {
    const key = callKey("dog_queue", summary, toolArgsDigest({ dog: "a" }))!;
    expect(repeatedCallLine(5, key)).toBe(repeatedCallLine(5, callKey("dog_queue", summary)!));
  });

  it("keys other providers' calls without a digest as before", () => {
    expect(callKey("shell", "ls -la")).toBe("shell:ls -la");
  });
});
