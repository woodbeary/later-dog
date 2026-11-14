import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { answeredReady, CHECK_GIVE_UP_MS, checkUnknown, programMissing, ranOutOfTime, readCliVersion, readingReady, shownReading, unreadCli } from "./cli-version.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function program(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cli-version-"));
  dirs.push(dir);
  const file = join(dir, "engine");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

describe("reading an engine's version", () => {
  it("returns the version an engine prints", async () => {
    await expect(readCliVersion(program("echo 2.1.301"), process.env)).resolves.toEqual({ version: "2.1.301" });
  });

  it("calls an engine that does not answer in time still starting, not missing", async () => {
    await expect(readCliVersion(program("sleep 5"), process.env, undefined, 200)).resolves.toEqual({ starting: true });
  });

  it("calls an engine that is not there missing", async () => {
    await expect(readCliVersion(join(tmpdir(), "no-such-engine-anywhere"), process.env)).resolves.toEqual({ missing: true });
  });

  it("calls only a program that is not there or cannot be run missing; any other failure is a failed check", async () => {
    const reads = {
      fails: await readCliVersion(program("exit 1"), process.env),
      killed: await readCliVersion(program("kill -9 $$"), process.env),
      silent: await readCliVersion(program("true"), process.env),
      notThere: await readCliVersion(join(tmpdir(), "no-such-engine-anywhere"), process.env),
    };
    expect(reads).toEqual({ fails: { failed: true }, killed: { failed: true }, silent: { failed: true }, notThere: { missing: true } });
    const snapshots = Object.values(reads).map((read) => unreadCli("claude", read as Exclude<typeof read, { version: string }>));
    expect(snapshots.map(programMissing)).toEqual([false, false, false, true]);
    expect(snapshots.map(checkUnknown)).toEqual([true, true, true, false]);
  });

  it("calls a program that is there but not runnable missing", async () => {
    const file = program("echo 1.0.0");
    chmodSync(file, 0o644);
    await expect(readCliVersion(file, process.env)).resolves.toEqual({ missing: true });
  });

  it("counts an account whose check gave no answer as ready, and a definite answer as given", () => {
    expect(readingReady({ state: "unavailable", reason: "x", checkFailed: true })).toBe(true);
    expect(readingReady({ state: "unavailable", reason: "x", starting: true })).toBe(true);
    expect(readingReady({ state: "available", authenticated: true })).toBe(true);
    expect(readingReady({ state: "available", authenticated: false })).toBe(false);
    expect(readingReady({ state: "unavailable", reason: "x", missing: true })).toBe(false);
  });

  it("counts only a definite answer as the person's own account for starting the free trial", () => {
    expect(answeredReady({ state: "available", authenticated: true })).toBe(true);
    expect(answeredReady({ state: "available", authenticated: false })).toBe(false);
    expect(answeredReady({ state: "unavailable", reason: "x", checkFailed: true })).toBe(false);
    expect(answeredReady({ state: "unavailable", reason: "x", starting: true })).toBe(false);
  });

  it("says an account is being checked, and after ten minutes without an answer that it could not be checked", () => {
    const failed = { state: "unavailable" as const, reason: "raw error", checkFailed: true as const };
    expect(shownReading(failed, "Daniel", 0).reason).toBe("Daniel is still being checked");
    expect(shownReading(failed, "Daniel", CHECK_GIVE_UP_MS - 1).reason).toBe("Daniel is still being checked");
    const late = shownReading(failed, "Daniel", CHECK_GIVE_UP_MS);
    expect(late).toEqual({ ...failed, reason: "Daniel could not be checked. Choose Check again, or sign in to it again." });
    expect(checkUnknown(late)).toBe(true);
    expect(readingReady(late)).toBe(true);
    const starting = { state: "unavailable" as const, reason: "`claude` is still starting", starting: true as const };
    expect(shownReading(starting, "Daniel", 0)).toEqual(starting);
    expect(shownReading(starting, "Daniel", CHECK_GIVE_UP_MS).reason).toBe("Daniel could not be checked. Choose Check again, or sign in to it again.");
    const answered = { state: "available" as const, authenticated: true };
    expect(shownReading(answered, "Daniel", CHECK_GIVE_UP_MS)).toBe(answered);
  });

  it("tells the two apart in the account's answer", () => {
    expect(unreadCli("claude", { starting: true })).toEqual({ state: "unavailable", reason: "`claude` is still starting", starting: true });
    expect(unreadCli("claude", { missing: true })).toEqual({ state: "unavailable", reason: "`claude` CLI not found", missing: true });
    expect(unreadCli("claude", { failed: true })).toEqual({ state: "unavailable", reason: "`claude` is still being checked", checkFailed: true });
    expect(ranOutOfTime({ killed: true, signal: "SIGTERM" })).toBe(true);
    expect(ranOutOfTime({ code: "ENOENT" })).toBe(false);
  });
});
