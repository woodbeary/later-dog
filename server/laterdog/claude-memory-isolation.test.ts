import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { machineClaudeMemoryExcludes } from "./claude-memory-isolation.ts";

describe("the CLAUDE.md files a dog never inherits from the person's machine", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("covers the home folder and every folder above it, never the folders inside it", () => {
    const excludes = machineClaudeMemoryExcludes({ HOME: "/Users/sam" });
    expect(excludes).toEqual(expect.arrayContaining([
      "/Users/sam/CLAUDE.md",
      "/Users/sam/CLAUDE.local.md",
      "/Users/sam/.claude/CLAUDE.md",
      "/Users/sam/.claude/rules/**",
      "/Users/CLAUDE.md",
      "/Users/.claude/CLAUDE.md",
      "/CLAUDE.md",
      "/.claude/CLAUDE.md",
    ]));
    expect(excludes.filter((pattern) => pattern.startsWith("/Users/sam/") && !pattern.startsWith("/Users/sam/.claude/") && !/^\/Users\/sam\/CLAUDE(\.local)?\.md$/.test(pattern))).toEqual([]);
    expect(new Set(excludes).size).toBe(excludes.length);
  });

  it("names the home folder both as given and as it really sits on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "laterdog-claude-memory-"));
    made.push(root);
    const home = join(root, "home");
    mkdirSync(home);
    const excludes = machineClaudeMemoryExcludes({ HOME: home });
    expect(excludes).toContain(`${home.replaceAll("\\", "/")}/.claude/CLAUDE.md`);
    expect(excludes).toContain(`${realpathSync(home).replaceAll("\\", "/")}/.claude/CLAUDE.md`);
  });

  it("escapes glob characters so an odd home folder name matches only itself", () => {
    const excludes = machineClaudeMemoryExcludes({ HOME: "/Users/sam (work)" });
    expect(excludes).toContain("/Users/sam \\(work\\)/.claude/CLAUDE.md");
    expect(excludes).not.toContain("/Users/sam (work)/.claude/CLAUDE.md");
  });
});
