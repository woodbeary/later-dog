import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadUserSkills, parseSkillManifest, renderSkillInstructions, selectBundledSkills, type BundledSkill } from "./skill-library.ts";

const instructionsFor = (text: string, capabilities: string[], skills: BundledSkill[], options?: { includeRoot?: boolean }) =>
  renderSkillInstructions(selectBundledSkills(text, capabilities, skills), options);

const expenses: BundledSkill = {
  directory: "/skills/file-expense",
  instructions: "---\nname: file-expense\ndescription: test\n---\nFile it safely.",
  manifest: {
    id: "file-expense",
    name: "File expense",
    version: "0.1.0",
    description: "File expenses",
    defaultEnabled: true,
    triggerTerms: ["expense", "receipt"],
    requiredCapabilities: ["skillAuthoring"],
  },
};

describe("skill library", () => {
  it("selects a skill only when both its trigger and capability are present", () => {
    const rendered = instructionsFor("File this expense", ["skillAuthoring"], [expenses]);
    expect(rendered).toContain("File it safely");
    expect(rendered).not.toContain('root="/skills/file-expense"');
    expect(instructionsFor("File this expense", ["skillAuthoring"], [expenses], { includeRoot: true }))
      .toContain('root="/skills/file-expense"');
    expect(instructionsFor("File this expense", [], [expenses])).toBe("");
    expect(instructionsFor("Write a poem", ["skillAuthoring"], [expenses])).toBe("");
  });

  it("requires the manifest id to match its isolated folder", () => {
    expect(() => parseSkillManifest({
      ...expenses.manifest,
      id: "other-skill",
    }, "/skills/file-expense")).toThrow(/invalid id/);
  });

  it("loads a user skill without letting a broken sibling disable it", () => {
    const root = mkdtempSync(join(tmpdir(), "laterdog-skills-"));
    const valid = join(root, "file-expense");
    mkdirSync(valid);
    writeFileSync(join(valid, "manifest.json"), JSON.stringify({
      id: "file-expense", name: "File expense", version: "1.0.0", description: "File expenses",
      defaultEnabled: true, triggerTerms: ["expense"], requiredCapabilities: [],
    }));
    writeFileSync(join(valid, "SKILL.md"), "---\nname: file-expense\ndescription: File expenses\n---\nDo it safely.\n");
    const broken = join(root, "broken");
    mkdirSync(broken);
    writeFileSync(join(broken, "manifest.json"), "not json");
    writeFileSync(join(broken, "SKILL.md"), "broken");

    expect(loadUserSkills(root).map((skill) => skill.manifest.id)).toEqual(["file-expense"]);
  });

  it("treats a non-directory user skill root as empty", () => {
    const root = mkdtempSync(join(tmpdir(), "laterdog-skills-root-"));
    const file = join(root, "not-a-directory");
    writeFileSync(file, "nope");
    expect(loadUserSkills(file)).toEqual([]);
  });
});

