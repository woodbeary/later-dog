import { describe, expect, it } from "vitest";

import { listLearnedFacts } from "../profile-learned.ts";
import { importedFacts, importIntoAboutMe } from "./profile-import.ts";

describe("bringing memories from another assistant", () => {
  it("keeps one fact per line, without bullets, numbers, headings or the assistant's preamble", () => {
    const pasted = [
      "Sure! Here's what I remember about you:",
      "",
      "## Work",
      "- **Works** on later.dog, an app for AI helpers",
      "2. Lives in Oakland, CA",
      "• Prefers short answers",
      "* ok",
      "Here are a few more:",
      "   Has a dog named Waffles   ",
    ].join("\n");
    expect(importedFacts(pasted)).toEqual([
      "Work",
      "Works on later.dog, an app for AI helpers",
      "Lives in Oakland, CA",
      "Prefers short answers",
      "Has a dog named Waffles",
    ]);
    expect(importedFacts(Array.from({ length: 300 }, (_, i) => `Fact number ${i}`).join("\n"))).toHaveLength(200);
  });

  it("adds only new facts to About me, marked as brought from another assistant", () => {
    const saved: string[] = [];
    const before = "Likes tea\n- 2026-10-01 · learned by Memo · Lives in Oakland, CA";
    const result = importIntoAboutMe("Likes tea\nLives in Oakland, CA\nRuns on Sundays\nPassword is hunter2xyz with key sk-abc123def456ghi789", before, "2026-10-30", (next) => saved.push(next));
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.full).toBe(false);
    expect(result.aboutMe.startsWith(`${before}\n- 2026-10-30 · learned by another assistant · Runs on Sundays`)).toBe(true);
    expect(result.aboutMe).not.toContain("sk-abc123def456ghi789");
    expect(saved).toEqual([result.aboutMe]);
    expect(listLearnedFacts().slice(0, 2).map((fact) => fact.botName)).toEqual(["another assistant", "another assistant"]);
  });

  it("adds what fits when About me is nearly full, and nothing when no new fact fits", () => {
    const nearlyFull = "x".repeat(23_900);
    const fit = importIntoAboutMe("First new fact here\nSecond new fact that will not fit in the space left", nearlyFull, "2026-10-30", () => {});
    expect(fit).toMatchObject({ added: 1, full: true });
    const full = importIntoAboutMe("Another brand new fact", "x".repeat(24_000), "2026-10-30", () => { throw new Error("must not save"); });
    expect(full).toMatchObject({ added: 0, full: true });
  });
});
