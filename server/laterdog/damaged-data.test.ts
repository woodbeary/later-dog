import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { RoutineManager } from "../routines.ts";
import { Store } from "../store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "claude-sonnet-5" });
const routineOptions = (file: string) => ({ file, botState: () => "ready" as const, conversationFor: () => null, startTurn: async () => {} });
const kept = (name: string) => readdirSync(DATA_DIR).filter((file) => file.startsWith(`${name}.damaged-`));

describe("a damaged roster file", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps the original bytes, makes no new dog over it, and says so", () => {
    const original = new Store(selection);
    original.createBot({ name: "Rex" });
    original.createBot({ name: "Juniper" });
    const bytes = readFileSync(join(DATA_DIR, "bots.json"), "utf8");
    const truncated = bytes.slice(0, Math.floor(bytes.length / 2));
    writeFileSync(join(DATA_DIR, "bots.json"), truncated);

    const store = new Store(selection);
    expect(store.needsSeed()).toBe(false);
    store.seedIfEmpty();
    expect(store.bots).toEqual([]);
    expect(store.damaged).toEqual([{ name: "bots", keptAs: expect.stringMatching(/^bots\.json\.damaged-/) }]);
    expect(kept("bots.json")).toHaveLength(1);
    expect(readFileSync(join(DATA_DIR, kept("bots.json")[0]!), "utf8")).toBe(truncated);
    expect(readFileSync(join(DATA_DIR, "bots.json"), "utf8")).toBe(truncated);
  });

  it("still lets the person make a dog, and the copy stays", () => {
    writeFileSync(join(DATA_DIR, "bots.json"), "[{");
    const store = new Store(selection);
    store.createBot({ name: "Fresh" });
    expect(new Store(selection).bots.map((bot) => bot.name)).toEqual(["Fresh"]);
    expect(readFileSync(join(DATA_DIR, kept("bots.json")[0]!), "utf8")).toBe("[{");
  });

  it("still seeds the first dog when there is no file at all", () => {
    const store = new Store(selection);
    expect(store.damaged).toEqual([]);
    expect(store.needsSeed()).toBe(true);
    store.seedIfEmpty();
    expect(store.bots).toHaveLength(1);
  });

  it("keeps a damaged group chats file and keeps the dogs", () => {
    new Store(selection).createBot({ name: "Rex" });
    writeFileSync(join(DATA_DIR, "groups.json"), '[{"id":');
    const store = new Store(selection);
    expect(store.bots.map((bot) => bot.name)).toEqual(["Rex"]);
    expect(store.groups).toEqual([]);
    expect(store.damaged).toEqual([{ name: "groups", keptAs: expect.stringMatching(/^groups\.json\.damaged-/) }]);
    expect(readFileSync(join(DATA_DIR, kept("groups.json")[0]!), "utf8")).toBe('[{"id":');
  });

  it("treats a roster that is valid JSON but not a list of dogs as damaged instead of failing to start", () => {
    writeFileSync(join(DATA_DIR, "bots.json"), '{"bots":[]}');
    const store = new Store(selection);
    expect(store.bots).toEqual([]);
    expect(store.needsSeed()).toBe(false);
    expect(store.damaged.map((file) => file.name)).toEqual(["bots"]);
  });
});

describe("a damaged routines file", () => {
  beforeEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
    mkdirSync(DATA_DIR, { recursive: true });
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("keeps the original bytes and starts with no routines", () => {
    const file = join(DATA_DIR, "routines.json");
    writeFileSync(file, '{"routines":[{"id":"r1","sch');
    const manager = new RoutineManager(routineOptions(file));
    expect(manager.listRoutines()).toEqual([]);
    expect(manager.damaged).toEqual({ name: "routines", keptAs: expect.stringMatching(/^routines\.json\.damaged-/) });
    expect(readFileSync(join(DATA_DIR, kept("routines.json")[0]!), "utf8")).toBe('{"routines":[{"id":"r1","sch');
  });

  it("treats entries the loader cannot read as damage, not as an empty file", () => {
    const file = join(DATA_DIR, "routines.json");
    writeFileSync(file, '{"routines":[null]}');
    expect(new RoutineManager(routineOptions(file)).damaged?.name).toBe("routines");
  });

  it("reports nothing for a missing or readable file", () => {
    const file = join(DATA_DIR, "routines.json");
    expect(new RoutineManager(routineOptions(file)).damaged).toBeNull();
    writeFileSync(file, JSON.stringify({ routines: [], runs: [] }));
    expect(new RoutineManager(routineOptions(file)).damaged).toBeNull();
    expect(kept("routines.json")).toEqual([]);
  });
});
