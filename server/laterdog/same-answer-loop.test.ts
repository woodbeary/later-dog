import { describe, expect, it } from "vitest";

import { SAME_ANSWER_LIMIT, SameAnswerLoop, sameAnswerLine } from "./same-answer-loop.ts";

let ids = 0;
function run(loop: SameAnswerLoop, threadId: string, args: string, output: string | undefined, ok = true, shown?: string) {
  const itemId = `item-${++ids}`;
  loop.started(threadId, { itemId, tool: "Bash", args, shown });
  return loop.completed(threadId, { itemId, ok, output });
}

describe("SameAnswerLoop", () => {
  it("ends a turn once the same call has given the same answer ten times", () => {
    const loop = new SameAnswerLoop();
    const results = Array.from({ length: SAME_ANSWER_LIMIT }, () => run(loop, "t1", '{"command":"gh auth status"}', "You are not logged in", false, "gh auth status"));
    expect(results.slice(0, -1).every((result) => result === undefined)).toBe(true);
    expect(results.at(-1)).toEqual({ call: "gh auth status", times: SAME_ANSWER_LIMIT });
    expect(run(loop, "t1", '{"command":"gh auth status"}', "You are not logged in", false)).toBeUndefined();
  });

  it("keeps polling a build whose answer changes, however many times it asks", () => {
    const loop = new SameAnswerLoop();
    for (let i = 0; i < 60; i++) {
      expect(run(loop, "t1", '{"command":"gh run view 42"}', `in progress, step ${Math.floor(i / 3)} of 20`)).toBeUndefined();
    }
  });

  it("does not count calls with different arguments, different threads, or no answer", () => {
    const loop = new SameAnswerLoop({ limit: 3 });
    for (let i = 0; i < 5; i++) expect(run(loop, "t1", `{"command":"cat part-${i}.txt"}`, "same text")).toBeUndefined();
    for (let i = 0; i < 2; i++) run(loop, "t1", '{"command":"ls"}', "a b");
    for (let i = 0; i < 2; i++) run(loop, "t2", '{"command":"ls"}', "a b");
    expect(run(loop, "t1", '{"command":"ls"}', undefined)).toBeUndefined();
    expect(run(loop, "t1", '{"command":"ls"}', "a b")).toBeUndefined();
    expect(run(loop, "t2", '{"command":"ls"}', "a b")).toEqual({ call: "Bash", times: 3 });
  });

  it("treats a failed answer and a successful one with the same text as different", () => {
    const loop = new SameAnswerLoop({ limit: 3 });
    run(loop, "t1", '{"command":"make"}', "done", true);
    run(loop, "t1", '{"command":"make"}', "done", false);
    expect(run(loop, "t1", '{"command":"make"}', "done", false)).toBeUndefined();
    expect(run(loop, "t1", '{"command":"make"}', "done", false)).toEqual({ call: "Bash", times: 3 });
  });

  it("counts a call's answers across other calls in between, like a wait between checks", () => {
    const loop = new SameAnswerLoop({ limit: 3 });
    run(loop, "t1", '{"command":"wrangler whoami"}', "Not logged in");
    run(loop, "t1", '{"command":"sleep 5"}', "slept");
    run(loop, "t1", '{"command":"wrangler whoami"}', "Not logged in");
    run(loop, "t1", '{"command":"sleep 5"}', "slept");
    expect(run(loop, "t1", '{"command":"wrangler whoami"}', "Not logged in", true, "wrangler whoami")).toEqual({ call: "wrangler whoami", times: 3 });
  });

  it("forgets a thread when its turn settles and ignores results it never saw start", () => {
    const loop = new SameAnswerLoop({ limit: 2 });
    run(loop, "t1", '{"command":"ls"}', "a");
    loop.settle("t1");
    expect(run(loop, "t1", '{"command":"ls"}', "a")).toBeUndefined();
    expect(loop.completed("t1", { itemId: "never-started", ok: true, output: "a" })).toBeUndefined();
    loop.started("t1", { tool: "Bash", args: "ls" });
    expect(loop.completed("t1", { ok: true, output: "a" })).toBeUndefined();
  });

  it("rejects a limit that would end a turn on its first call", () => {
    expect(() => new SameAnswerLoop({ limit: 1 })).toThrow(/at least 2/);
  });
});

describe("sameAnswerLine", () => {
  it("says plainly what the dog ran and what it is waiting for", () => {
    expect(sameAnswerLine("Patch", { call: "gh auth status", times: 10 })).toBe(
      "Patch stopped: it ran gh auth status 10 times and got the same answer every time. It is waiting for that answer to change. Reply when it should try again or do something else.",
    );
    expect(sameAnswerLine(undefined, { call: "x".repeat(100), times: 10 })).toMatch(new RegExp(`^The dog stopped: it ran ${"x".repeat(80)}… 10 times`));
  });
});
