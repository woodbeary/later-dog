import { describe, expect, it } from "vitest";
import { createSharedJoins } from "./shared-join.ts";

describe("opening a waking computer twice", () => {
  it("lets the second open wait for the first and share its desktop link", async () => {
    const joins = createSharedJoins<{ joinUrl: string }>();
    let calls = 0;
    let finish!: (value: { joinUrl: string }) => void;
    const first = joins.run("pup", () => { calls += 1; return new Promise((resolve) => { finish = resolve; }); });
    const second = joins.pending("pup");
    expect(second).toBe(first);
    finish({ joinUrl: "https://cloud.example.test/desktop/1/" });
    await expect(second).resolves.toEqual({ joinUrl: "https://cloud.example.test/desktop/1/" });
    expect(calls).toBe(1);
  });

  it("starts fresh once the first open has finished, even after it failed", async () => {
    const joins = createSharedJoins<string>();
    await expect(joins.run("pup", () => Promise.reject(new Error("did not wake in time")))).rejects.toThrow("did not wake in time");
    expect(joins.pending("pup")).toBeUndefined();
    await expect(joins.run("pup", () => Promise.resolve("ok"))).resolves.toBe("ok");
  });

  it("keeps each dog's open separate", () => {
    const joins = createSharedJoins<string>();
    const pup = joins.run("pup", () => new Promise(() => {}));
    expect(joins.pending("rex")).toBeUndefined();
    expect(joins.run("rex", () => new Promise(() => {}))).not.toBe(pup);
  });
});
