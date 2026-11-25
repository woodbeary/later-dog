import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("installed hooks in linked worktrees", () => {
  it("uses each checkout's relative executable hook and reports its checks", () => {
    const root = mkdtempSync(join(tmpdir(), "laterdog installed hook "));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    const hook = join(root, "scripts/git-hooks/pre-push");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nprintf 'original-hook'\n");
    chmodSync(hook, 0o755);
    writeFileSync(
      join(root, "scripts/install-git-hooks.mjs"),
      readFileSync(resolve("scripts/install-git-hooks.mjs")),
    );
    git("add", ".");
    git(
      "-c",
      "user.name=Hook fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const env = { ...process.env };
    delete env.CI;
    delete env.LATERDOG_SKIP_HOOKS;
    const installed = spawnSync(process.execPath, [join(root, "scripts/install-git-hooks.mjs")], {
      env,
      encoding: "utf8",
    });
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stdout).toContain("format");
    expect(git("config", "--get", "core.hooksPath")).toBe("scripts/git-hooks");
    const runHook = (cwd: string) => {
      const result = spawnSync("git", ["hook", "run", "pre-push"], { cwd, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout + result.stderr;
    };
    expect(runHook(root)).toBe("original-hook");
    const linked = `${root} linked`;
    git("worktree", "add", "--quiet", "--detach", linked, "HEAD");
    writeFileSync(join(linked, "scripts/git-hooks/pre-push"), "#!/bin/sh\nprintf 'linked-hook'\n");
    const own = runHook(join(linked, "scripts"));
    expect(own).toBe("linked-hook");
    expect(runHook(root)).toBe("original-hook");
    git("config", "core.hooksPath", "custom-hooks");
    expect(
      spawnSync(process.execPath, [join(root, "scripts/install-git-hooks.mjs")], {
        env: { ...env, CI: "1" },
      }).status,
    ).toBe(0);
    expect(git("config", "--get", "core.hooksPath")).toBe("custom-hooks");
  });
});
