import { describe, expect, it } from "vitest";
import { waitUntil } from "./api.ts";

describe("waitUntil", () => {
  it("rejects when a read never completes before the deadline", async () => {
    const stalled = new Promise<string>(() => {});
    await expect(waitUntil("stalled read", () => stalled, () => true, 50))
      .rejects.toThrow("stalled read timed out: a read never completed");
  });

  it("keeps polling a false read and returns the first accepted value", async () => {
    let reads = 0;
    const value = await waitUntil("counter", async () => ++reads, (count) => count >= 3, 5_000);
    expect(value).toBe(3);
  });
});
