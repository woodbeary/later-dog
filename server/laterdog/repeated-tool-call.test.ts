import { describe, expect, it } from "vitest";
import { permissionCallKey, toolArgsDigest } from "./repeated-tool-call.ts";
import { RepeatDetector, callKey, repeatedCallLine } from "../repeat-detector.ts";

const summary = 'Allow the agents MCP server to run tool "dog_queue"?';

function run(inputs: unknown[]) {
  const detector = new RepeatDetector({ thresholds: [5] });
  const hits: number[] = [];
  for (const input of inputs) {
    const digest = toolArgsDigest(input);
    const key = permissionCallKey({ tool: "dog_queue", summary, ...(digest ? { argsDigest: digest } : { argsUnknown: true as const }) });
    if (!key) continue;
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

  it("does not count five operations with missing arguments as the same call", () => {
    expect(run([undefined, undefined, undefined, undefined, undefined])).toEqual([]);
    expect(toolArgsDigest(undefined)).toBeUndefined();
  });

  it("treats known empty arguments as known and distinct, and still warns when repeated", () => {
    expect(toolArgsDigest({})).toMatch(/^[0-9a-f]{16}$/);
    expect(toolArgsDigest([])).toMatch(/^[0-9a-f]{16}$/);
    expect(toolArgsDigest({})).not.toBe(toolArgsDigest([]));
    expect(toolArgsDigest({})).toBe(toolArgsDigest({}));
    expect(run([{}, {}, {}, {}, {}])).toEqual([5]);
    expect(run([{}, [], {}, [], {}])).toEqual([]);
  });

  it("sorts keys, and keeps __proto__ and similar keys distinct", () => {
    expect(toolArgsDigest({ a: 1, b: { y: 1, x: 2 } })).toBe(toolArgsDigest({ b: { x: 2, y: 1 }, a: 1 }));
    const proto = JSON.parse('{"__proto__": {"a": 1}}');
    expect(toolArgsDigest(proto)).toMatch(/^[0-9a-f]{16}$/);
    expect(toolArgsDigest(proto)).not.toBe(toolArgsDigest({}));
    expect(toolArgsDigest(proto)).not.toBe(toolArgsDigest(JSON.parse('{"__proto__": {"a": 2}}')));
    expect(toolArgsDigest({ "1": "x" })).not.toBe(toolArgsDigest(["x"]));
    expect(toolArgsDigest("1")).not.toBe(toolArgsDigest(1));
  });

  it("returns unknown instead of colliding when arguments nest too deeply or are too large", () => {
    const nest = (leaf: string) => {
      let value: unknown = leaf;
      for (let i = 0; i < 12; i++) value = { next: value };
      return value;
    };
    expect(toolArgsDigest(nest("one"))).toBeUndefined();
    expect(toolArgsDigest(nest("two"))).toBeUndefined();
    expect(run([nest("a"), nest("b"), nest("c"), nest("d"), nest("e")])).toEqual([]);
    expect(toolArgsDigest(Array.from({ length: 5000 }, (_, i) => i))).toBeUndefined();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(toolArgsDigest(cycle)).toBeUndefined();
  });

  it("is a bounded digest that never carries the argument text", () => {
    const digest = toolArgsDigest({ token: "sk-secret-value".repeat(1000) })!;
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    const key = permissionCallKey({ tool: "dog_queue", summary, argsDigest: digest })!;
    expect(key).not.toContain("sk-secret");
    expect(repeatedCallLine(5, key)).not.toContain("sk-secret");
  });

  it("leaves the displayed warning wording unchanged", () => {
    const key = permissionCallKey({ tool: "dog_queue", summary, argsDigest: toolArgsDigest({ dog: "a" }) })!;
    expect(repeatedCallLine(5, key)).toBe(repeatedCallLine(5, callKey("dog_queue", summary)!));
  });

  it("keys other providers' calls without a digest as before", () => {
    expect(callKey("shell", "ls -la")).toBe("shell:ls -la");
  });
});
