import { describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../system-prompt.ts";
import { dogGuidance, guidancePart, HELPER_BRIEF, SAVE_STATE } from "./dog-guidance.ts";

const engines = [
  { engine: "claude", model: "claude-fable-5-2" },
  { engine: "codex", model: "gpt-6.1-sol" },
  { engine: "other", model: "local-model" },
] as const;

describe("continuity in a dog's delivered instructions", () => {
  it.each(engines)("keeps a usable checkpoint on $engine", (input) => {
    const built = buildSystemPrompt("You are Scout.", "", [guidancePart({ ...input, agents: true })], "Sam");
    expect(built.stable).toContain(SAVE_STATE);
    expect(SAVE_STATE).toMatch(/goal.*decisions.*changed files.*checks.*blockers.*next step/);
    expect(SAVE_STATE).toMatch(/After compaction.*resume/);
  });

  it.each(engines)("preserves outstanding work when a new message arrives on $engine", (input) => {
    const text = dogGuidance({ ...input, agents: true });
    expect(text).toMatch(/new message from the person steers the current task/i);
    expect(text).toMatch(/continue outstanding work unless the person cancels or replaces it/);
  });

  it.each(engines)("keeps command waits separate from teammate completion on $engine", (input) => {
    const text = dogGuidance({ ...input, agents: true });
    expect(text).toMatch(/command's result.*wait\/output tool/);
    expect(text).toMatch(/After coordinate_bots, finish independent work and end the turn/);
    expect(text).toMatch(/Never poll or sleep for another dog's result/);
  });

  it.each(engines)("omits team delegation rules without the team's tools on $engine", (input) => {
    expect(dogGuidance({ ...input, agents: false })).not.toContain(HELPER_BRIEF);
    expect(dogGuidance({ ...input, agents: true })).toContain(HELPER_BRIEF);
  });

  it.each(engines)("keeps the working section within its size budget on $engine", (input) => {
    const text = dogGuidance({ ...input, agents: true });
    const working = text.slice(text.indexOf("<working>"), text.indexOf("</working>"));
    expect(Buffer.byteLength(working, "utf8")).toBeLessThanOrEqual(3700);
  });
});
