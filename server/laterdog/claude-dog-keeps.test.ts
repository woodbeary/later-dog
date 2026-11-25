import { describe, expect, it } from "vitest";

import { dogGuidance } from "./dog-guidance.ts";
import {
  KEEP_GOING_PROMPT,
  KEEP_GOING_WITH_BACKGROUND_PROMPT,
  workUpdatesPrompt,
} from "./work-updates.ts";

const KEPT_FOR_CLAUDE: Readonly<Record<string, { model: string; text: string }>> = {
  VERIFIED_OR_ASSUMED: {
    model: "claude-opus-5-5",
    text: "In reports, say plainly what you verified and what you assumed.",
  },
  FINISH_WORK: {
    model: "claude-opus-5-5",
    text: "Finish the requested work: errors, timeouts and empty results are ordinary obstacles.",
  },
  DECIDE_YOURSELF: {
    model: "claude-opus-5-5",
    text: "Make engineering choices yourself with current best practice and say what you chose.",
  },
  ANSWER_FIRST_OPENING: {
    model: "claude-opus-5-5",
    text: "For a person's request that needs tools, say in one line what you are doing before the first call",
  },
  ASK_BEFORE_HARD_TO_UNDO: {
    model: "claude-opus-5-5",
    text: "Where no setting or rule covers it, ask first before anything that is hard to undo, visible to other people (sending, posting, publishing) or that spends money.",
  },
  FABLE_KEEP_GOING: {
    model: "claude-fable-5-2",
    text: "If you catch yourself offering to wait or asking whether to go on, do the next part instead.",
  },
  FABLE_REPORTS: {
    model: "claude-fable-5-2",
    text: "Write reports for a reader who has not seen your tool calls or files: key points first, one idea per sentence, the same word for the same thing.",
  },
  CARRY_THROUGH: {
    model: "claude-sonnet-5-5",
    text: "Keep working until everything the person asked for is done, and only stop to ask when you can't go on without them or before a risky step.",
  },
};

const NO_NARRATION =
  "The app already shows that you are working, so between your one-line updates do not narrate each step, tool, file or search.";

describe("what a Claude dog is still told though its engine may say something like it", () => {
  it("keeps every line whose engine counterpart only loads under conditions", () => {
    for (const [name, { model, text }] of Object.entries(KEPT_FOR_CLAUDE)) {
      expect([name, dogGuidance({ engine: "claude", agents: true, model }).includes(text)]).toEqual(
        [name, true],
      );
    }
  });

  it("keeps the no-narration and keep-going lines in a Claude dog's progress updates", () => {
    const quiet = workUpdatesPrompt({ background: false, react: true, engine: "claude" });
    const background = workUpdatesPrompt({ background: true, react: true, engine: "claude" });
    expect([
      "NO_NARRATION_PROMPT",
      quiet.includes(NO_NARRATION),
      background.includes(NO_NARRATION),
    ]).toEqual(["NO_NARRATION_PROMPT", true, true]);
    expect(["KEEP_GOING_PROMPT", quiet.includes(KEEP_GOING_PROMPT)]).toEqual([
      "KEEP_GOING_PROMPT",
      true,
    ]);
    expect([
      "KEEP_GOING_WITH_BACKGROUND_PROMPT",
      background.includes(KEEP_GOING_WITH_BACKGROUND_PROMPT),
    ]).toEqual(["KEEP_GOING_WITH_BACKGROUND_PROMPT", true]);
  });
});
