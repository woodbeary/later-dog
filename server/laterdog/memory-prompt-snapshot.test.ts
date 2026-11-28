import { expect, it } from "vitest";
import { quickMemorySnapshot } from "./memory-prompt-snapshot.ts";

const last = new Map([["MEMORY.md", "last turn's notes"]]);

it("uses a fresh read that answers quickly", async () => {
  const fresh = new Map([["MEMORY.md", "fresh notes"]]);
  expect(await quickMemorySnapshot(Promise.resolve(fresh), last, 50)).toBe(fresh);
});

it("answers with the last snapshot when the fresh read is slow, without waiting for it", async () => {
  const slow = new Promise<ReadonlyMap<string, string> | null>((resolve) => setTimeout(() => resolve(new Map()), 2_000));
  const started = Date.now();
  expect(await quickMemorySnapshot(slow, last, 50)).toBe(last);
  expect(Date.now() - started).toBeLessThan(1_000);
});

it("leaves the choice to the caller when there is no earlier snapshot or the fresh read failed", async () => {
  const slow = new Promise<ReadonlyMap<string, string> | null>((resolve) => setTimeout(() => resolve(new Map()), 2_000));
  expect(await quickMemorySnapshot(slow, new Map(), 50)).toBeNull();
  expect(await quickMemorySnapshot(Promise.reject(new Error("down")), new Map(), 50)).toBeNull();
  expect(await quickMemorySnapshot(Promise.resolve(null), last, 50)).toBe(last);
});
