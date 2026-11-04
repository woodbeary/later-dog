import { describe, expect, it } from "vitest";
import { afterCheck, NOT_ANSWERED_YET, stuckLine, within } from "../src/hang-watch.ts";

describe("counting checks a home did not answer", () => {
  it("counts misses only after the home has answered, and asks for a restart at the limit", () => {
    expect(afterCheck(NOT_ANSWERED_YET, false)).toEqual({ record: NOT_ANSWERED_YET, restart: false });
    let record = afterCheck(NOT_ANSWERED_YET, true).record;
    for (let miss = 1; miss < 4; miss += 1) {
      const verdict = afterCheck(record, false);
      expect(verdict).toEqual({ record: { answered: true, missed: miss }, restart: false });
      record = verdict.record;
    }
    expect(afterCheck(record, false)).toEqual({ record: NOT_ANSWERED_YET, restart: true });
    expect(afterCheck({ answered: true, missed: 3 }, true)).toEqual({ record: { answered: true, missed: 0 }, restart: false });
  });

  it("treats a check that hangs or fails as not answered", async () => {
    expect(await within(new Promise<boolean>(() => undefined), 10, false)).toBe(false);
    expect(await within(Promise.reject(new Error("refused")), 10, false)).toBe(false);
    expect(await within(Promise.resolve(true), 10, false)).toBe(true);
  });

  it("says why it restarted", () => {
    expect(stuckLine("he6e", 4, 60)).toBe("laterdog home he6e: stopped answering (4 checks in a row over 4 min); restarting it from its last save");
  });
});
