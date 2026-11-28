import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CLOUD_HOME_MARKER, HOME_HEALTH_FILE, lastError, noteHomeHealth, outputTail, pushedCodeFellBack, shouldFallBackFromPushed } from "../runtime/home-health.mjs";

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
  const notAFolder = join(mkdtempSync(join(tmpdir(), "home-health-")), "a-file");
  writeFileSync(notAFolder, "");
  expect(noteHomeHealth(join(notAFolder, "nope"), "message")).toBe(false);
});

it("falls back only when pushed code crashes right after start, never on container shutdown signals", () => {
  expect(shouldFallBackFromPushed({ stopping: false, code: 1, signal: null, elapsedMs: 5_000, graceMs: 30_000 })).toBe(true);
  expect(shouldFallBackFromPushed({ stopping: false, code: null, signal: "SIGKILL", elapsedMs: 5_000, graceMs: 30_000 })).toBe(true);
  expect(shouldFallBackFromPushed({ stopping: false, code: 0, signal: null, elapsedMs: 5_000, graceMs: 30_000 })).toBe(false);
  expect(shouldFallBackFromPushed({ stopping: false, code: 1, signal: null, elapsedMs: 30_000, graceMs: 30_000 })).toBe(false);
  expect(shouldFallBackFromPushed({ stopping: true, code: 1, signal: null, elapsedMs: 5_000, graceMs: 30_000 })).toBe(false);
  expect(shouldFallBackFromPushed({ stopping: true, code: null, signal: "SIGTERM", elapsedMs: 11_000, graceMs: 30_000 })).toBe(false);
  expect(shouldFallBackFromPushed({ stopping: false, code: null, signal: "SIGTERM", elapsedMs: 11_000, graceMs: 30_000 })).toBe(false);
  expect(shouldFallBackFromPushed({ stopping: false, code: null, signal: "SIGINT", elapsedMs: 11_000, graceMs: 30_000 })).toBe(false);
});

it("writes nothing into a home the server has not adopted yet, so a brand-new home still passes the server's first-start check", () => {
  const home = mkdtempSync(join(tmpdir(), "laterdog-new-home-"));
  expect(noteHomeHealth(join(home, ".laterdog"), "a new home: nothing to restore", { home })).toBe(false);
  expect(readdirSync(home)).toEqual([]);
  writeFileSync(join(home, CLOUD_HOME_MARKER), JSON.stringify({ version: 1, machine: "home-7f3k2" }));
  expect(noteHomeHealth(join(home, ".laterdog"), "restored 3 files", { home })).toBe(true);
  expect(readFileSync(join(home, ".laterdog", HOME_HEALTH_FILE), "utf8")).toContain("restored 3 files");
});

it("uses the same adoption marker name as the server", () => {
  const server = readFileSync(join(import.meta.dirname, "..", "..", "..", "..", "server", "cloud-home.ts"), "utf8");
  expect(server).toContain(`export const CLOUD_HOME_MARKER = "${CLOUD_HOME_MARKER}";`);
});
