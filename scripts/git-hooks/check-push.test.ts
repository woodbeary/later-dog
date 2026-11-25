import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { changedPushFiles, pushChecks, runPushChecks } from "./check-push.mjs";

const head = "4023b874e1477c65580da03d31e739e7cce32d3f";
const base = "1023b874e1477c65580da03d31e739e7cce32d3f";
const zeros = "0".repeat(40);
const refs = (remote = base) => `refs/heads/work ${head} refs/heads/work ${remote}\n`;

function repo(dirty = "", files = "server/new\nname.ts\0src/renamed.ts\0") {
  return vi.fn((args: string[]) => {
    if (args[0] === "rev-parse") return head;
    if (args[0] === "status") return dirty;
    if (args[0] === "merge-base") return base;
    if (args[0] === "diff") return files;
    throw new Error("unexpected git command");
  });
}

describe("push ranges", () => {
  it("keeps NUL-delimited paths and asks git to treat renames as additions and deletions", () => {
    const git = repo();
    expect(changedPushFiles(refs(), "/checkout", git)).toEqual(["server/new\nname.ts", "src/renamed.ts"]);
    expect(git).toHaveBeenCalledWith(["diff", "--name-only", "-z", "--diff-filter=ACMRT", "--no-renames", base, head, "--"], "/checkout");
  });

  it("uses the main merge base for a new branch", () => {
    const git = repo();
    changedPushFiles(refs(zeros), "/checkout", git);
    expect(git).toHaveBeenCalledWith(["merge-base", head, "origin/main"], "/checkout");
  });

  it("does not run git for a deletion-only push", () => {
    const git = repo();
    expect(changedPushFiles(`(delete) ${zeros} refs/heads/old ${base}\n`, "/checkout", git)).toEqual([]);
    expect(git).not.toHaveBeenCalled();
  });

  it("refuses dirty files instead of checking different bytes from the pushed commit", () => {
    expect(() => changedPushFiles(refs(), "/checkout", repo(" M src/changed.ts\n"))).toThrow("commit or move local changes");
  });

  it("does not turn a missing base or a failed diff into an empty selection", () => {
    const missing = repo();
    missing.mockImplementation((args) => { if (args[0] === "diff") throw new Error("bad object"); return args[0] === "status" ? "" : head; });
    expect(() => changedPushFiles(refs(), "/checkout", missing)).toThrow("bad object");
    expect(() => changedPushFiles("refs/heads/work invalid refs/heads/work invalid\n", "/checkout", repo())).toThrow("invalid pushed ref");
  });
});

describe("push check failures", () => {
  it("runs full lint after a lint configuration change and keeps whole-graph types and locale checks", () => {
    const checks = pushChecks([".oxlintrc.json"], new Set<string>());
    expect(checks.find((check: { label: string }) => check.label === "lint")?.args).toEqual(["lint"]);
    expect(checks.filter((check: { label: string }) => ["typecheck", "locale"].includes(check.label)).map((check: { args: string[] }) => check.args)).toEqual([["typecheck"], ["i18n:check"]]);
  });

  it("collects a signal failure while another process finishes", async () => {
    const folder = mkdtempSync(join(tmpdir(), "laterdog-push-process-"));
    const results = await runPushChecks([
      { label: "signal", command: process.execPath, args: ["-e", "process.kill(process.pid, 'SIGTERM')"] },
      { label: "other", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('finished', 'yes')"] },
    ], folder);
    expect(results).toEqual([{ label: "signal", error: "signal SIGTERM" }, { label: "other", error: null }]);
    expect(readFileSync(join(folder, "finished"), "utf8")).toBe("yes");
  });

  it("fails closed when a required executable is missing", async () => {
    const results = await runPushChecks([{ label: "missing", command: "laterdog-required-command-does-not-exist", args: [] }]);
    expect(results[0].error).toContain("ENOENT");
  });
});
