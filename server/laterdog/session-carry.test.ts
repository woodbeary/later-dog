import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeTempDir } from "../testing/cleanup.ts";
import { claudeProjectSlug } from "./engine-placement.ts";
import { carryClaudeSession } from "./session-carry.ts";

const SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), "laterdog-carry-")); dirs.push(dir); return dir; };
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function accounts() {
  const root = scratch();
  const cwd = join(root, "task-workspaces", "dog", "chat");
  const from = join(root, "providers", "cover");
  const to = join(root, "providers", "own");
  const project = join(from, "projects", claudeProjectSlug(cwd));
  mkdirSync(join(project, SESSION, "subagents"), { recursive: true });
  writeFileSync(join(project, `${SESSION}.jsonl`), "{\"type\":\"user\",\"message\":\"the whole history\"}\n");
  writeFileSync(join(project, SESSION, "subagents", "helper.jsonl"), "{}\n");
  mkdirSync(join(from, "file-history", SESSION), { recursive: true });
  writeFileSync(join(from, "file-history", SESSION, "edit-1"), "before");
  return { cwd, from, to, project, toProject: join(to, "projects", claudeProjectSlug(cwd)) };
}

describe("carrying a Claude session to another Claude account", () => {
  it("copies the native transcript, its helper transcripts and its file history, so the other account resumes the same session", () => {
    const { cwd, from, to, toProject } = accounts();
    expect(carryClaudeSession({ sessionId: SESSION, cwd, fromConfigDir: from, toConfigDir: to })).toEqual({
      sessionId: SESSION, copied: [join("projects", claudeProjectSlug(cwd), `${SESSION}.jsonl`), join("projects", claudeProjectSlug(cwd), SESSION), join("file-history", SESSION)],
    });
    expect(readFileSync(join(toProject, `${SESSION}.jsonl`), "utf8")).toContain("the whole history");
    expect(existsSync(join(toProject, SESSION, "subagents", "helper.jsonl"))).toBe(true);
    expect(readFileSync(join(to, "file-history", SESSION, "edit-1"), "utf8")).toBe("before");
  });

  it.each(["physical", "logical"])("carries a %s native project from an aliased workspace into the next account's native project", (spelling) => {
    const root = scratch();
    const physical = join(root, "real-workspace"), alias = join(root, "workspace-alias");
    mkdirSync(physical);
    symlinkSync(physical, alias, "dir");
    const from = join(root, "account-one"), to = join(root, "account-two");
    const source = join(from, "projects", claudeProjectSlug(spelling === "physical" ? realpathSync(physical) : alias));
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, `${SESSION}.jsonl`), "original history");
    expect(carryClaudeSession({ sessionId: SESSION, cwd: alias, fromConfigDir: from, toConfigDir: to })?.sessionId).toBe(SESSION);
    expect(readFileSync(join(to, "projects", claudeProjectSlug(realpathSync(physical)), `${SESSION}.jsonl`), "utf8")).toBe("original history");
  });

  it("leaves a linked destination project and its outside transcript untouched", () => {
    const { cwd, from, to, project, toProject } = accounts();
    const outside = join(scratch(), "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, `${SESSION}.jsonl`), "unrelated");
    mkdirSync(join(to, "projects"), { recursive: true });
    symlinkSync(outside, toProject, "dir");
    expect(carryClaudeSession({ sessionId: SESSION, cwd, fromConfigDir: from, toConfigDir: to })).toBeUndefined();
    expect(readFileSync(join(outside, `${SESSION}.jsonl`), "utf8")).toBe("unrelated");
    expect(readFileSync(join(project, `${SESSION}.jsonl`), "utf8")).toContain("whole history");
  });

  it("replaces an older copy on the account it goes back to with the newer history", () => {
    const { cwd, from, to, project, toProject } = accounts();
    mkdirSync(toProject, { recursive: true });
    writeFileSync(join(toProject, `${SESSION}.jsonl`), "older");
    writeFileSync(join(project, `${SESSION}.jsonl`), "newer");
    carryClaudeSession({ sessionId: SESSION, cwd, fromConfigDir: from, toConfigDir: to });
    expect(readFileSync(join(toProject, `${SESSION}.jsonl`), "utf8")).toBe("newer");
  });

  it("carries nothing without a real session file, for a strange session id, to the same folder, or through a link", () => {
    const { cwd, from, to, project, toProject } = accounts();
    expect(carryClaudeSession({ sessionId: "11111111-2222-4333-8444-555555555555", cwd, fromConfigDir: from, toConfigDir: to })).toBeUndefined();
    expect(carryClaudeSession({ sessionId: "../escape", cwd, fromConfigDir: from, toConfigDir: to })).toBeUndefined();
    expect(carryClaudeSession({ sessionId: { sessionId: SESSION }, cwd, fromConfigDir: from, toConfigDir: to })).toBeUndefined();
    expect(carryClaudeSession({ sessionId: SESSION, cwd, fromConfigDir: from, toConfigDir: from })).toBeUndefined();
    const linked = "22222222-3333-4444-8555-666666666666";
    symlinkSync(join(project, `${SESSION}.jsonl`), join(project, `${linked}.jsonl`));
    expect(carryClaudeSession({ sessionId: linked, cwd, fromConfigDir: from, toConfigDir: to })).toBeUndefined();
    symlinkSync(join(project, `${SESSION}.jsonl`), join(project, SESSION, "outside.jsonl"));
    carryClaudeSession({ sessionId: SESSION, cwd, fromConfigDir: from, toConfigDir: to });
    expect(existsSync(join(toProject, SESSION, "outside.jsonl"))).toBe(false);
  });
});
