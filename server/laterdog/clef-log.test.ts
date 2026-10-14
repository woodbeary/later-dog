import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { appendClefLog, clefLogFileFor, flushClefLog } from "./clef-log.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("the Clef log", () => {
  it("appends one JSON line per row to a month file, in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-clef-log-"));
    dirs.push(dir);
    const at = new Date("2026-10-13T12:00:00Z");
    appendClefLog(dir, { kind: "turnEnd", threadId: "t", action: "nudged", pTop: 0.9 }, at);
    appendClefLog(dir, { kind: "screenCheck", threadId: "t", state: "loading" }, at);
    await flushClefLog(dir);
    const lines = readFileSync(clefLogFileFor(dir, at), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toEqual([
      { at: at.toISOString(), kind: "turnEnd", threadId: "t", action: "nudged", pTop: 0.9 },
      { at: at.toISOString(), kind: "screenCheck", threadId: "t", state: "loading" },
    ]);
  });
});
