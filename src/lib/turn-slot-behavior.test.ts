import { describe, expect, it } from "vitest";
import type { NativeRun } from "../../shared/native-runs";
import type { Bot } from "@/state/store";
import { dogRowFacts } from "./dog-row";
import { workLine } from "./work-line";

const run = (id: string, subject?: string): NativeRun => ({
  id: "turn-one",
  threadId: "thread",
  turnId: "one",
  provider: "fixture",
  revision: 1,
  startedAt: 0,
  state: "running",
  observation: "live",
  actors: [],
  activityCount: 1,
  failureCount: 0,
  limitations: [],
  currentActivity: {
    id,
    actorId: "parent",
    kind: "tool",
    label: "Bash",
    state: "running",
    startedAt: 0,
    ...(subject ? { subject } : {}),
  },
});

const dog: Bot = {
  id: "scout",
  threadId: "thread",
  name: "Scout",
  title: "",
  description: "",
  color: "yellow",
  notifications: true,
  unread: false,
  busy: true,
  activity: "working",
  messages: [],
  modelSelection: { instanceId: "fixture", model: "fixture" },
};

describe("a quiet turn signal", () => {
  it("uses one phrase for a kind throughout a turn even as step ids change", () => {
    const phrases = ["step-a", "step-b", "step-c", "step-d"].map((id) => {
      const line = workLine({ working: true, run: run(id), sideJobs: 0, now: 1_000 });
      return line?.kind === "step" ? line.phrase : null;
    });
    expect(new Set(phrases).size).toBe(1);
  });

  it("keeps a working line before a home or engine has supplied its first step", () => {
    expect(workLine({ working: true, sideJobs: 0, now: 1_000 })).toMatchObject({
      kind: "step",
      phrase: "Working on it",
    });
  });

  it("names a plain long step after a full minute", () => {
    const line = workLine({
      working: true,
      run: run("tests", "Run the order form tests"),
      sideJobs: 0,
      now: 60_000,
    });
    expect(line).toMatchObject({
      kind: "step",
      phrase: "Running the order form tests",
      age: "for 1 min",
    });
  });

  it("keeps tools, commands and paths out of a long step's words", () => {
    const generic = workLine({ working: true, run: run("unsafe"), sideJobs: 0, now: 60_000 });
    for (const subject of [
      "/srv/shop/tests.ts",
      "pnpm test order-form",
      "Run echo $TOKEN",
      "Read src/private.ts",
      "mcp__tools__run_command",
    ]) {
      const line = workLine({
        working: true,
        run: run("unsafe", subject),
        sideJobs: 0,
        now: 60_000,
      });
      expect(line).toEqual(generic);
    }
  });

  it("removes the working dot while keeping working available to assistive text", () => {
    const facts = dogRowFacts(dog, {});
    expect(facts.working).toBe(true);
    expect(facts.step).toBeTruthy();
    expect(facts.dot).toBeNull();
  });

  it("keeps waiting and unread attention while a dog works", () => {
    expect(dogRowFacts({ ...dog, unread: true }, {}).dot).toBe("unread");
    expect(dogRowFacts({ ...dog, activity: "waiting-on-you" }, {}).dot).toBe("waiting");
  });
});
