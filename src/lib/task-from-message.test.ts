import { describe, expect, it } from "vitest";
import { quotedReply, taskDraft } from "./task-from-message";

describe("starting a task from a reply", () => {
  it("quotes the reply under a plain lead, ready for the person's instruction", () => {
    expect(taskDraft("Start a task about this:", "Three cafés nearby.\n\nBlue Bottle is closest.")).toBe(
      "Start a task about this:\n> Three cafés nearby.\n>\n> Blue Bottle is closest.\n\n",
    );
  });

  it("leaves code out and keeps long replies short", () => {
    expect(quotedReply("Run this:\n```sh\nrm -rf build\n```\nThen restart.")).toBe("> Run this:\n>\n> Then restart.");
    expect(quotedReply("x".repeat(700)).endsWith("…")).toBe(true);
    expect(taskDraft("Start a task about this:", "```\nonly code\n```")).toBe("");
  });
});
