import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HOME_HEALTH_FILE, lastError, noteHomeHealth, outputTail, pushedCodeFellBack } from "../runtime/home-health.mjs";

it("says in home-health.log that a crashed pushed server left the home on the image's server, with its last error", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-health-"));
  const bundle = join(dir, "index.js");
  writeFileSync(bundle, "throw new Error('Dynamic require of \"events\" is not supported');\n");
  const crashed = spawnSync(process.execPath, [bundle], { encoding: "utf8" });
  const tail = outputTail();
  tail.push(crashed.stderr);
  const said = pushedCodeFellBack({ code: crashed.status, signal: crashed.signal, tail: tail.text() });
  expect(noteHomeHealth(dir, said, { now: new Date("2026-11-09T06:00:00Z") })).toBe(true);
  const log = readFileSync(join(dir, HOME_HEALTH_FILE), "utf8");
  expect(log.startsWith("2026-11-09T06:00:00.000Z cloud home: the pushed server code stopped right away (exit code 1, signal none); this home now runs the image's own server")).toBe(true);
  expect(log).toContain('Dynamic require of "events" is not supported');
  expect(log.trim().split("\n")).toHaveLength(1);
});

it("keeps only the end of a long error and never fails the runtime when the log cannot be written", () => {
  const tail = outputTail(64);
  tail.push("x".repeat(500));
  tail.push("\nlast line");
  expect(tail.text().length).toBe(64);
  expect(lastError("a\n\n b \n" + "y".repeat(2000)).length).toBeLessThanOrEqual(601);
  expect(noteHomeHealth("/proc/1/nope", "message")).toBe(false);
});
