import { describe, expect, it } from "vitest";
import { afterCheck, NOT_ANSWERED_YET, stuckLine, within } from "../src/hang-watch.ts";

const MIN = 60_000;

describe("counting checks a home did not answer", () => {
  it("never restarts a home that has not answered since it started", () => {
    expect(afterCheck(NOT_ANSWERED_YET, false, 60 * MIN)).toEqual({ record: NOT_ANSWERED_YET, restart: false });
  });

  it("restarts once the home has been silent four minutes and missed two checks in a row", () => {
    let record = afterCheck(NOT_ANSWERED_YET, true, 0).record;
    record = afterCheck(record, false, 1 * MIN).record;
    expect(record).toEqual({ answeredAt: 0, missed: 1 });
    const early = afterCheck(record, false, 3 * MIN);
    expect(early.restart).toBe(false);
    expect(afterCheck(early.record, false, 4 * MIN)).toEqual({ record: NOT_ANSWERED_YET, restart: true });
  });

  it("needs two misses in a row even after a long gap between checks", () => {
    const answered = afterCheck(NOT_ANSWERED_YET, true, 0).record;
    expect(afterCheck(answered, false, 10 * MIN)).toEqual({ record: { answeredAt: 0, missed: 1 }, restart: false });
    expect(afterCheck({ answeredAt: 0, missed: 1 }, true, 11 * MIN)).toEqual({ record: { answeredAt: 11 * MIN, missed: 0 }, restart: false });
  });

  it("treats a check that hangs or fails as not answered", async () => {
    expect(await within(new Promise<boolean>(() => undefined), 10, false)).toBe(false);
    expect(await within(Promise.reject(new Error("refused")), 10, false)).toBe(false);
    expect(await within(Promise.resolve(true), 10, false)).toBe(true);
  });

  it("says why it restarted", () => {
    expect(stuckLine("he6e", { answeredAt: 0, missed: 2 }, 5 * MIN)).toBe("laterdog home he6e: stopped answering (no answer for 5 min, 2 checks missed in a row); restarting it from its last save");
  });
});
