import { describe, expect, it } from "vitest";
import { leftoverProgramsNotice } from "./unconfirmed-stop.ts";

describe("the notice after a stop that could not confirm every program closed", () => {
  it.each(["Claude Code", "Codex"] as const)("names the engine that ran, says it stopped, and does not call the programs helpers: %s", (engine) => {
    const notice = leftoverProgramsNotice(engine);
    expect(notice.startsWith(`${engine} has stopped`)).toBe(true);
    expect(notice).toContain("may still be running");
    expect(notice.toLowerCase()).not.toContain("helper");
  });
});
