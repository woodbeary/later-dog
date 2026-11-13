import { describe, expect, it } from "vitest";
import { helpersStoppedLine } from "./helpers-stopped.ts";

describe("what stopped with the turn", () => {
  it.each([
    [{ helpers: 0, commands: 0 }, null],
    [{ helpers: 1, commands: 0 }, "A helper stopped when this turn ended."],
    [{ helpers: 2, commands: 0 }, "2 helpers stopped when this turn ended."],
    [{ helpers: 0, commands: 1 }, "A command running in the background stopped when this turn ended."],
    [{ helpers: 0, commands: 3 }, "3 commands running in the background stopped when this turn ended."],
    [{ helpers: 1, commands: 1 }, "A helper and a command running in the background stopped when this turn ended."],
    [{ helpers: 2, commands: 2 }, "2 helpers and 2 commands running in the background stopped when this turn ended."],
  ] as const)("%j", (stopped, line) => {
    expect(helpersStoppedLine(stopped)).toBe(line);
  });
});
