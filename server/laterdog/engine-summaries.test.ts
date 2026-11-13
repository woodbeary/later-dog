import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileEngineSummaries, KEPT_CHATS } from "./engine-summaries.ts";

let dir = "";
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe("the engine's own compaction summaries", () => {
  it("keeps the latest per chat across a restart, privately and bounded", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-engine-summaries-"));
    const path = join(dir, "engine-summaries.json");
    let now = 1;
    const first = fileEngineSummaries(path, () => now++);
    first.remember("t1", { text: "older summary", throughId: "m1" });
    first.remember("t1", { text: "newer summary", throughId: "m9" });
    first.remember("t2", { text: "x".repeat(20_000), throughId: "m2" });
    const reread = fileEngineSummaries(path);
    expect(reread.read("t1")).toMatchObject({ text: "newer summary", throughId: "m9" });
    expect(Buffer.byteLength(reread.read("t2")!.text)).toBeLessThanOrEqual(6_000);
    expect(reread.read("t3")).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("older summary");
  });

  it("forgets a deleted chat's summary for good", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-engine-summaries-"));
    const path = join(dir, "engine-summaries.json");
    const store = fileEngineSummaries(path);
    store.remember("deleted", { text: "DELETED_CHAT_SUMMARY", throughId: "m1" });
    store.remember("kept", { text: "kept summary", throughId: "m2" });
    store.forget(["deleted", "never-stored"]);
    expect(store.read("deleted")).toBeUndefined();
    const reread = fileEngineSummaries(path);
    expect(reread.read("deleted")).toBeUndefined();
    expect(reread.read("kept")).toBeDefined();
    expect(readFileSync(path, "utf8")).not.toContain("DELETED_CHAT_SUMMARY");
  });

  it("keeps secrets out of a stored summary", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-engine-summaries-"));
    const store = fileEngineSummaries(join(dir, "engine-summaries.json"));
    store.remember("t", { text: "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH", throughId: "m1" });
    expect(store.read("t")!.text).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("ignores empty summaries and keeps only the most recent chats", () => {
    dir = mkdtempSync(join(tmpdir(), "laterdog-engine-summaries-"));
    const path = join(dir, "engine-summaries.json");
    let now = 1;
    const store = fileEngineSummaries(path, () => now++);
    store.remember("empty", { text: "   ", throughId: "m1" });
    expect(store.read("empty")).toBeUndefined();
    for (let i = 0; i <= KEPT_CHATS; i++) store.remember(`t${i}`, { text: "s", throughId: "m" });
    expect(store.read("t0")).toBeUndefined();
    expect(store.read(`t${KEPT_CHATS}`)).toBeDefined();
  });
});
