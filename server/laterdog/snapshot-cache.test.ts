import { describe, expect, it } from "vitest";
import { createSnapshotCache } from "./snapshot-cache.ts";

const later = <T>(ms: number, value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

describe("account status for the accounts list", () => {
  it("always checks again, and a quick check answers with what it found", async () => {
    const cache = createSnapshotCache<string>({ waitMs: 200 });
    const owner = {};
    let state = "signed out";
    await expect(cache.read("codex", owner, async () => state)).resolves.toBe("signed out");
    state = "signed in";
    await expect(cache.read("codex", owner, async () => state)).resolves.toBe("signed in");
  });

  it("answers with the last check when a new one is slow, and keeps the slow result for next time", async () => {
    const cache = createSnapshotCache<string>({ waitMs: 50 });
    const owner = {};
    await cache.read("grok", owner, async () => "ready");
    const started = Date.now();
    await expect(cache.read("grok", owner, () => later(300, "ready again"))).resolves.toBe("ready");
    expect(Date.now() - started).toBeLessThan(250);
    await later(350, null);
    await expect(cache.read("grok", owner, () => later(300, "third"))).resolves.toBe("ready again");
  });

  it("waits for the check when there is nothing recent to show: first open, a forgotten account, an old answer or a replaced account", async () => {
    let at = 0;
    const cache = createSnapshotCache<string>({ now: () => at, waitMs: 10, keptMs: 1_000 });
    const owner = {};
    await expect(cache.read("claude", owner, () => later(40, "first"))).resolves.toBe("first");
    cache.forget("claude");
    await expect(cache.read("claude", owner, () => later(40, "after sign-in"))).resolves.toBe("after sign-in");
    at = 2_000;
    await expect(cache.read("claude", owner, () => later(40, "after a while"))).resolves.toBe("after a while");
    await expect(cache.read("claude", {}, () => later(40, "new account"))).resolves.toBe("new account");
  });

  it("runs one check at a time for an account", async () => {
    const cache = createSnapshotCache<string>();
    const owner = {};
    let checks = 0;
    const take = () => { checks += 1; return later(20, "ready"); };
    await expect(Promise.all([cache.read("kimi", owner, take), cache.read("kimi", owner, take)])).resolves.toEqual(["ready", "ready"]);
    expect(checks).toBe(1);
  });
});
