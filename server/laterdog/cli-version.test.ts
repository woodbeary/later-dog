import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ranOutOfTime, readCliVersion, unreadCli } from "./cli-version.ts";

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

  it("tells the two apart in the account's answer", () => {
    expect(unreadCli("claude", { starting: true })).toEqual({ state: "unavailable", reason: "`claude` is still starting", starting: true });
    expect(unreadCli("claude", { missing: true })).toEqual({ state: "unavailable", reason: "`claude` CLI not found" });
    expect(ranOutOfTime({ killed: true, signal: "SIGTERM" })).toBe(true);
    expect(ranOutOfTime({ code: "ENOENT" })).toBe(false);
  });
});
