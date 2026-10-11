import { describe, expect, it } from "vitest";
import { startsOffLeash } from "./MeetYourBotBeat";

describe("the first dog", () => {
  it("starts Off-leash unless it already has a level or works on this Mac", () => {
    expect(startsOffLeash({})).toBe(true);
    expect(startsOffLeash({ approvalMode: "ask" })).toBe(true);
    expect(startsOffLeash({ approvalMode: "auto" })).toBe(false);
    expect(startsOffLeash({ approvalMode: "full" })).toBe(false);
    expect(startsOffLeash({ autoApprove: true })).toBe(false);
    expect(startsOffLeash({ computer: "local" })).toBe(false);
  });
});
