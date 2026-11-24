import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FullAccessAllSwitch, onFullAnywhere, onFullEverywhere, planFullAccess, type FullAccessDog } from "./full-access-all.ts";

describe("the Full access for all dogs switch", () => {
  let folder: string;
  beforeEach(() => { folder = mkdtempSync(join(tmpdir(), "laterdog-full-all-")); });
  afterEach(() => rmSync(folder, { recursive: true, force: true }));

  it("starts off, remembers a change across restarts, and survives a damaged file", () => {
    const file = join(folder, "full-access-all.json");
    expect(new FullAccessAllSwitch(file).enabled()).toBe(false);
    const first = new FullAccessAllSwitch(file);
    first.set(true);
    expect(new FullAccessAllSwitch(file).enabled()).toBe(true);
    first.set(false);
    expect(new FullAccessAllSwitch(file).enabled()).toBe(false);
    writeFileSync(file, "{not json");
    expect(new FullAccessAllSwitch(file).enabled()).toBe(false);
  });
});

describe("which dogs move to Full access", () => {
  const dog = (id: string, mode: string, tasks: string[] = []): FullAccessDog => ({ id, approvalMode: mode, tasks: tasks.map((approvalMode) => ({ approvalMode })) });

  it("moves idle dogs that are not fully on Full, skips unsupported ones, and holds busy ones for later", () => {
    const dogs = [dog("ask", "ask", ["ask"]), dog("done", "full", ["full"]), dog("mixed", "full", ["ask"]), dog("busy", "auto"), dog("nope", "ask")];
    const plan = planFullAccess(dogs, { busy: (d) => d.id === "busy", supported: (d) => d.id !== "nope" });
    expect(plan.move.map((d) => d.id)).toEqual(["ask", "mixed"]);
    expect(plan.waiting.map((d) => d.id)).toEqual(["busy"]);
  });

  it("knows whether a dog is on Full in every thread or in any", () => {
    expect(onFullEverywhere(dog("a", "full", ["full", "ask"]))).toBe(false);
    expect(onFullEverywhere(dog("a", "full", ["full"]))).toBe(true);
    expect(onFullAnywhere(dog("a", "ask", ["full"]))).toBe(true);
    expect(onFullAnywhere(dog("a", "ask", ["ask"]))).toBe(false);
  });
});
