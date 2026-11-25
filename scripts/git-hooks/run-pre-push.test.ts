import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { finishPrePush } from "./run-pre-push.mjs";

const source = resolve("scripts/git-hooks");

function entry(body: string, seconds?: number) {
  const folder = mkdtempSync(join(tmpdir(), "laterdog hook invocation "));
  copyFileSync(join(source, "run-pre-push.mjs"), join(folder, "run-pre-push.mjs"));
  writeFileSync(join(folder, "pre-push-checks"), `#!/bin/sh\n${body}\n`);
  const preload = join(folder, "preload.mjs");
  if (seconds !== undefined) writeFileSync(preload, `process.uptime = () => ${seconds};\n`);
  return spawnSync(
    process.execPath,
    [...(seconds === undefined ? [] : ["--import", preload]), join(folder, "run-pre-push.mjs")],
    { cwd: folder, input: "complete stdin\n", encoding: "utf8" },
  );
}

describe("complete pre-push invocation budget", () => {
  it.each([
    [8.999, 0],
    [9, 1],
    [9.001, 1],
  ])("uses the strict %s-second boundary", (seconds, code) => {
    const stream = { write: () => {} };
    expect(finishPrePush({ status: 0 }, seconds, stream, stream)).toBe(code);
  });

  it("reports the child failure and the budget together", () => {
    let output = "";
    const stream = {
      write: (text: string) => {
        output += text;
      },
    };
    expect(finishPrePush({ status: 7 }, 9, stream, stream)).toBe(1);
    expect(output).toContain("checks failed with exit code 7");
    expect(output).toContain("reaches or exceeds the 9s budget");
  });

  it("fails closed on spawn errors and signals", () => {
    const stream = { write: () => {} };
    expect(finishPrePush({ error: new Error("ENOENT") }, 0, stream, stream)).toBe(1);
    expect(finishPrePush({ signal: "SIGTERM", status: null }, 0, stream, stream)).toBe(1);
    expect(finishPrePush({ status: null }, 0, stream, stream)).toBe(1);
  });

  it("keeps stdin and the working directory for the complete child invocation", () => {
    const result = entry("read -r line\nprintf '%s\\n' \"$line\"\npwd\n");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("complete stdin");
    expect(result.stdout).toContain("laterdog hook invocation ");
    expect(result.stdout).toContain("complete invocation finished");
  });

  it("counts the process clock established before module initialization", () => {
    const result = entry("printf 'checks completed\\n'", 9);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("checks completed");
    expect(result.stderr).toContain("complete invocation 9.00s reaches or exceeds");
  });

  it("accepts a fast valid invocation after the child finishes", () => {
    const result = entry("printf 'checks completed\\n'", 8.999);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("checks completed");
  });

  it("preserves a failed or signalled child", () => {
    expect(entry("exit 7").status).toBe(1);
    expect(entry("kill -TERM $$").status).toBe(1);
  });

  it("preserves the executable-independent deletion fallback", () => {
    const folder = mkdtempSync(join(tmpdir(), "laterdog hook no node "));
    const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
    symlinkSync(git, join(folder, "git"));
    copyFileSync(join(source, "pre-push"), join(folder, "pre-push"));
    copyFileSync(join(source, "pre-push-checks"), join(folder, "pre-push-checks"));
    const env = { ...process.env, PATH: folder };
    delete env.LATERDOG_SKIP_HOOKS;
    const invoke = (input: string) =>
      spawnSync("/bin/sh", [join(folder, "pre-push")], { input, env, encoding: "utf8" });
    const zeros = "0".repeat(40);
    const sha = "1".repeat(40);
    expect(invoke(`(delete) ${zeros} refs/heads/old ${sha}\n`).status).toBe(0);
    expect(invoke(`(delete) ${zeros} refs/heads/old ${sha}`).status).toBe(1);
    expect(invoke(`refs/heads/main ${sha} refs/heads/main ${zeros}\n`).status).not.toBe(0);
  });
});
