import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import { skillsCall, skillsPromptReady, skillWorkers } from "./skills-thread.ts";
import { workspaceDir } from "./workspace.ts";

const SKILL = (name: string, description = "Reviews a PR the way this team reviews PRs.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing.\n`;
const scratch = join(DATA_DIR, "..", `skills-thread-${process.pid}`);
let sequence = 0;
const freshBot = () => `thread-dog-${process.pid}-${++sequence}`;
const outside = (name: string) => { const path = join(scratch, `${name}-${sequence}`); mkdirSync(path, { recursive: true }); return path; };

beforeAll(() => {
  vi.stubEnv("LATERDOG_CLOUD_ROLE", "home");
  vi.stubEnv("LATERDOG_WORK_FOLDER_LAYOUT", "fixture");
  mkdirSync(scratch, { recursive: true });
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

describe("skills on a mounted dog folder run off the main thread with the same safety checks", () => {
  it("installs, enables and indexes a skill for the turn prompt", async () => {
    const bot = freshBot();
    expect(await skillsCall(bot, "installSkill", bot, "src", [{ path: "SKILL.md", content: SKILL("reviewer") }])).toMatchObject({ name: "reviewer" });
    expect(await skillsCall(bot, "setSkillEnabled", bot, "reviewer", true)).toMatchObject({ enabled: true });
    expect(await skillsPromptReady(bot)).toContain(`- reviewer: Reviews a PR the way this team reviews PRs. Read ${JSON.stringify(join(workspaceDir(bot), "skills", "reviewer", "SKILL.md"))}`);
    expect(await skillsCall(bot, "readSkillFile", bot, "reviewer")).toBe(SKILL("reviewer"));
    expect(lstatSync(join(workspaceDir(bot), ".claude", "skills", "reviewer")).isSymbolicLink()).toBe(true);
    expect(await skillsCall(bot, "removeSkill", bot, "reviewer")).toEqual({ removed: true });
    expect(await skillsCall(bot, "listSkills", bot)).toEqual([]);
    expect(skillWorkers()).toBeGreaterThan(0);
  });

  it("refuses a symlinked skills root", async () => {
    const bot = freshBot();
    const root = workspaceDir(bot);
    mkdirSync(root, { recursive: true });
    const away = outside("outside-root");
    symlinkSync(away, join(root, "skills"), "dir");
    expect(await skillsCall(bot, "installSkill", bot, "src", [{ path: "SKILL.md", content: SKILL("escaped") }])).toMatchObject({ error: expect.stringContaining("real directory") });
    expect(existsSync(join(away, "escaped"))).toBe(false);
  });

  it("refuses a symlinked skill directory and a SKILL.md changed after review", async () => {
    const bot = freshBot();
    const root = workspaceDir(bot);
    mkdirSync(join(root, "skills"), { recursive: true });
    const content = SKILL("linked-skill");
    const away = outside("outside-skill");
    writeFileSync(join(away, "SKILL.md"), content);
    symlinkSync(away, join(root, "skills", "linked-skill"), "dir");
    const state = join(DATA_DIR, "skill-state", bot);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "skills.json"), JSON.stringify({ "linked-skill": {
      description: "x", enabled: false, source: "src", sha256: createHash("sha256").update(content).digest("hex"),
      importedAt: "2026-01-01T00:00:00.000Z", warnings: [], skippedFiles: [],
    } }));
    expect(await skillsCall(bot, "readSkillFile", bot, "linked-skill")).toBeNull();
    expect(await skillsCall(bot, "setSkillEnabled", bot, "linked-skill", true)).toMatchObject({ error: expect.stringContaining("changed after review") });

    const other = freshBot();
    await skillsCall(other, "installSkill", other, "src", [{ path: "SKILL.md", content: SKILL("edited") }]);
    writeFileSync(join(workspaceDir(other), "skills", "edited", "SKILL.md"), SKILL("edited", "Something else entirely."));
    expect(await skillsCall(other, "setSkillEnabled", other, "edited", true)).toMatchObject({ error: expect.stringContaining("changed after review") });
  });

  it("skips a native discovery directory that is a symlink", async () => {
    const bot = freshBot();
    await skillsCall(bot, "installSkill", bot, "src", [{ path: "SKILL.md", content: SKILL("native-boundary") }]);
    const root = workspaceDir(bot);
    const away = outside("outside-native");
    mkdirSync(join(root, ".claude"), { recursive: true });
    symlinkSync(away, join(root, ".claude", "skills"), "dir");
    expect(await skillsCall(bot, "setSkillEnabled", bot, "native-boundary", true)).toMatchObject({ enabled: true });
    expect(existsSync(join(away, "native-boundary"))).toBe(false);
    expect(existsSync(join(root, ".agents", "skills", "native-boundary"))).toBe(true);
  });

  it("never writes through a pre-existing revision symlink, and runs the receipt on the main thread before cleanup", async () => {
    const bot = freshBot();
    const original = SKILL("revision-target", "Original.");
    const created = await skillsCall(bot, "stageSkillWrite", bot, { action: "create", files: [{ path: "SKILL.md", content: original }] });
    if ("error" in created) throw new Error(created.error);
    const receipts: string[] = [];
    const applied = await skillsCall(bot, "applySkillWriteWithReceipt", bot, created, (skill) => { receipts.push(skill.name); });
    expect(applied).toMatchObject({ result: { name: "revision-target" } });
    expect(receipts).toEqual(["revision-target"]);
    const staged = await skillsCall(bot, "stageSkillWrite", bot, { action: "update", targetName: "revision-target", files: [{ path: "SKILL.md", content: SKILL("revision-target", "Replacement.") }] });
    if ("error" in staged) throw new Error(staged.error);
    const revisions = join(workspaceDir(bot), "skills", ".revisions");
    mkdirSync(revisions);
    const away = outside("outside-revision");
    writeFileSync(join(away, "SKILL.md"), "outside stays untouched");
    symlinkSync(away, join(revisions, createHash("sha256").update(staged.id).digest("hex")), "dir");
    expect(await skillsCall(bot, "applyStagedSkillWrite", bot, staged.id, {})).toMatchObject({ error: expect.stringContaining("already exists with different content") });
    expect(readFileSync(join(away, "SKILL.md"), "utf8")).toBe("outside stays untouched");
    expect(await skillsCall(bot, "readSkillFile", bot, "revision-target")).toBe(original);
  });

  it("passes a failed receipt back as the error it threw", async () => {
    const bot = freshBot();
    const created = await skillsCall(bot, "stageSkillWrite", bot, { action: "create", files: [{ path: "SKILL.md", content: SKILL("card-gone") }] });
    if ("error" in created) throw new Error(created.error);
    const result = await skillsCall(bot, "applyStagedSkillWrite", bot, created.id, { onApplied: () => { throw new Error("the card is no longer available"); } }).catch((error: Error) => error.message);
    expect(result).toBe("the card is no longer available");
  });
});
