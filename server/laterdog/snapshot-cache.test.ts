import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSnapshotCache } from "./snapshot-cache.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

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

  it("answers at once for an account whose checks are slow, and still checks behind it", async () => {
    const cache = createSnapshotCache<string>({ waitMs: 50 });
    const owner = {};
    await cache.read("claude", owner, () => later(120, "signed in"));
    const started = Date.now();
    await expect(cache.read("claude", owner, () => later(120, "signed in, new usage"))).resolves.toBe("signed in");
    expect(Date.now() - started).toBeLessThan(40);
    await later(160, null);
    await expect(cache.read("claude", owner, () => later(120, "later"))).resolves.toBe("signed in, new usage");
  });

  it("keeps the last answers across a restart for the same account only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-cache-"));
    dirs.push(dir);
    const file = join(dir, "account-snapshots.json");
    const identity = (owner: object) => (owner as { name: string }).name;
    const before = createSnapshotCache<string>({ waitMs: 50, file, identity });
    await before.read("claude", { name: "claude:claudeAgent" }, async () => "signed in as ada");
    await later(1_200, null);
    const after = createSnapshotCache<string>({ waitMs: 50, file, identity });
    const started = Date.now();
    await expect(after.read("claude", { name: "claude:claudeAgent" }, () => later(300, "fresh"))).resolves.toBe("signed in as ada");
    expect(Date.now() - started).toBeLessThan(200);
    const another = createSnapshotCache<string>({ waitMs: 50, file, identity });
    await expect(another.read("claude", { name: "claude:codex" }, () => later(30, "a different engine"))).resolves.toBe("a different engine");
  });
});
