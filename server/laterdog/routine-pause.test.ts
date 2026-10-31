import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OptionCardData } from "../../shared/wire.ts";
import { AWAY_BEFORE_PAUSE_MS, ROUTINE_PAUSE_ANSWERS, RoutinePauses, routinePauseOutcome, UNREAD_RESULTS_BEFORE_PAUSE } from "./routine-pause.ts";

const HOUR = 60 * 60_000;

function setup(routineList = [
  { id: "r1", botId: "b1", name: "Morning news", enabled: true },
  { id: "r2", botId: "b1", name: "Inbox sweep", enabled: true },
  { id: "r3", botId: "b1", name: "Old one", enabled: false },
  { id: "r4", botId: "b2", name: "Other dog", enabled: true },
]) {
  const file = join(mkdtempSync(join(tmpdir(), "routine-pause-")), "routine-pauses.json");
  let now = 1_000_000;
  const list = routineList.map((routine) => ({ ...routine }));
  const messages: Array<{ threadId: string; card: OptionCardData; text: string }> = [];
  const deps = {
    file,
    now: () => now,
    routines: {
      listRoutines: () => list,
      update: (id: string, patch: { enabled: boolean }) => { Object.assign(list.find((routine) => routine.id === id)!, patch); return null; },
    },
    bot: (botId: string) => (botId === "b1" || botId === "b2" ? { id: botId, name: "Biscuit", color: "yellow" as const, threadId: `t-${botId}` } : null),
    appendMessage: (threadId: string, message: { card: OptionCardData; text: string }) => { messages.push({ threadId, card: message.card, text: message.text }); return { id: `m${messages.length}` }; },
  };
  return { deps, list, messages, file, advance: (ms: number) => { now += ms; }, pauses: () => new RoutinePauses(deps) };
}

describe("pausing a dog's routines while their results go unread", () => {
  it("pauses only after enough unread results over at least a day, then asks in the dog's chat", () => {
    const { pauses, advance, list, messages } = setup();
    const watch = pauses();
    for (let index = 1; index < UNREAD_RESULTS_BEFORE_PAUSE; index += 1) {
      expect(watch.result("b1")).toBeNull();
      advance(8 * HOUR);
    }
    expect(watch.result("b1")).toEqual({ paused: ["r1", "r2"], messageId: "m1" });
    expect(list.map((routine) => [routine.id, routine.enabled])).toEqual([["r1", false], ["r2", false], ["r3", false], ["r4", true]]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.threadId).toBe("t-b1");
    expect(messages[0]!.card).toMatchObject({
      title: "I paused my routines while you were away",
      options: [ROUTINE_PAUSE_ANSWERS.resume, ROUTINE_PAUSE_ANSWERS.keepRunning, ROUTINE_PAUSE_ANSWERS.keepPaused],
      routinePause: { version: 1, routineIds: ["r1", "r2"] },
    });
    expect(messages[0]!.card.subtitle).toContain("5 results in a row went unread");
    expect(watch.watched("b1")).toMatchObject({ unread: 0, since: null });
  });

  it("doesn't pause a quick burst of results, however many", () => {
    const { pauses, advance, messages } = setup();
    const watch = pauses();
    for (let index = 0; index < 20; index += 1) {
      expect(watch.result("b1")).toBeNull();
      advance(HOUR);
    }
    expect(messages).toHaveLength(0);
    advance(AWAY_BEFORE_PAUSE_MS);
    expect(watch.result("b1")?.paused).toEqual(["r1", "r2"]);
  });

  it("starts counting again once the person reads the dog's chat", () => {
    const { pauses, advance, messages } = setup();
    const watch = pauses();
    for (let index = 0; index < UNREAD_RESULTS_BEFORE_PAUSE - 1; index += 1) { watch.result("b1"); advance(10 * HOUR); }
    watch.seen("b1");
    expect(watch.result("b1")).toBeNull();
    expect(watch.watched("b1").unread).toBe(1);
    expect(messages).toHaveLength(0);
  });

  it("remembers the count across a restart", () => {
    const { pauses, advance, file } = setup();
    const first = pauses();
    first.result("b1");
    advance(HOUR);
    first.result("b1");
    expect(pauses().watched("b1").unread).toBe(2);
    expect(JSON.parse(readFileSync(file, "utf8")).b1.unread).toBe(2);
  });

  it("asks nothing when the dog has no routine running", () => {
    const { pauses, advance, messages } = setup([{ id: "r3", botId: "b1", name: "Old one", enabled: false }]);
    const watch = pauses();
    for (let index = 0; index < UNREAD_RESULTS_BEFORE_PAUSE; index += 1) { watch.result("b1"); advance(10 * HOUR); }
    expect(messages).toHaveLength(0);
  });
});

describe("the person's answer to the pause card", () => {
  const paused = () => {
    const context = setup();
    const watch = context.pauses();
    for (let index = 0; index < UNREAD_RESULTS_BEFORE_PAUSE; index += 1) { watch.result("b1"); context.advance(10 * HOUR); }
    return { ...context, watch, card: context.messages[0]!.card };
  };

  it("starts the paused routines again, and only those", () => {
    const { watch, card, list } = paused();
    expect(watch.answer("b1", card, ROUTINE_PAUSE_ANSWERS.resume)?.routinePause?.outcome).toBe("resumed");
    expect(list.map((routine) => [routine.id, routine.enabled])).toEqual([["r1", true], ["r2", true], ["r3", false], ["r4", true]]);
  });

  it("keeps them running for good when asked, and never pauses that dog again", () => {
    const { watch, card, list, advance, messages } = paused();
    expect(watch.answer("b1", card, ROUTINE_PAUSE_ANSWERS.keepRunning)?.routinePause?.outcome).toBe("keep-running");
    expect(list.find((routine) => routine.id === "r1")!.enabled).toBe(true);
    for (let index = 0; index < 10; index += 1) { watch.result("b1"); advance(10 * HOUR); }
    expect(messages).toHaveLength(1);
  });

  it("leaves them paused when asked, and answers each card once", () => {
    const { watch, card, list } = paused();
    const kept = watch.answer("b1", card, ROUTINE_PAUSE_ANSWERS.keepPaused)!;
    expect(kept.routinePause?.outcome).toBe("kept");
    expect(list.find((routine) => routine.id === "r1")!.enabled).toBe(false);
    expect(watch.answer("b1", kept, ROUTINE_PAUSE_ANSWERS.resume)).toBeNull();
    expect(list.find((routine) => routine.id === "r1")!.enabled).toBe(false);
  });

  it("ignores other answers and other cards", () => {
    const { watch, card } = paused();
    expect(watch.answer("b1", card, "Something else")).toBeNull();
    expect(watch.answer("b1", { title: "Deploy?", subtitle: "", options: ["Yes"] }, "Yes")).toBeNull();
    expect(routinePauseOutcome("Start them again")).toBe("resumed");
  });
});
