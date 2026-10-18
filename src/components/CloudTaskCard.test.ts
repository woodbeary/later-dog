import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { rememberCloudTasks } from "@/lib/cloud-tasks";
import { BotEditorStore, initialState, reducer, type Message } from "@/state/store";
import type { CloudTaskSummary } from "../../shared/cloud-task";
import { CloudTaskCard, CloudTaskUpdateRow } from "./CloudTaskCard";

const ID = "6a1f8f2e-1111-4222-8333-944444444444";

function message(jobId = ID): Message {
  return { id: `card-${jobId}`, role: "bot", kind: "activity", at: 1, tool: { name: "Cloud task: Fix the login button", ok: true }, cloudTask: { jobId, title: "Fix the login button", repository: "owner/repo", backend: "laterdog-cloud" } };
}

function render(value: Message) {
  return renderToStaticMarkup(createElement(BotEditorStore, { value: { state: initialState, dispatch: vi.fn() } as never, children: createElement(CloudTaskCard, { message: value }) }));
}

function remember(id: string, patch: Partial<CloudTaskSummary>) {
  rememberCloudTasks([{
    id, title: "Fix the login button", state: "running", backend: "laterdog-cloud", repository: "owner/repo", kind: "implementation",
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:05:00.000Z", outputBranch: "laterdog/x", screen: true, stoppable: true, publishable: false, ...patch,
  }]);
}

let next = 0;
function card(patch: Partial<CloudTaskSummary> | null): string {
  next += 1;
  const id = `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  if (patch) remember(id, patch);
  return render(message(id));
}

const words = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const STATES: Record<string, Partial<CloudTaskSummary> | null> = {
  loading: null,
  waiting: { state: "queued", blocker: "All configured execution slots are occupied" },
  working: { stage: "claude", lastStep: { t: 1, k: "tool", tool: "Edit", detail: "src/login.tsx" } },
  review: { state: "ready", prUrl: "https://github.com/owner/repo/pull/12", prNumber: 12, changes: { files: 3, additions: 40, deletions: 2 }, screen: false, stoppable: false },
  done: { state: "merged", prUrl: "https://github.com/owner/repo/pull/12", prNumber: 12, screen: false, stoppable: false },
  stopped: { state: "cancelled", screen: false, stoppable: false },
  attention: { state: "needs_attention", blocker: "The job exited 1 during setup", screen: false, stoppable: false },
};

describe("CloudTaskCard", () => {
  it("shows the task's title straight away, before its status arrives", () => {
    const markup = card(null);
    expect(words(markup)).toContain("Fix the login button");
    expect(words(markup)).toContain("Checking…");
    expect(markup).toContain('data-testid="cloud-task-card"');
    expect(markup).toContain('data-phase="checking"');
  });

  it("says what the dog is working on and what it is doing, in plain words", () => {
    const markup = card(STATES.working!);
    const text = words(markup);
    expect(text).toContain("Working on: Fix the login button");
    expect(text).toContain("Working · Making changes");
    expect(markup).toContain("thinking-shimmer");
    expect(text).not.toContain("src/login.tsx");
    expect(markup).toContain('aria-label="Open Fix the login button"');
  });

  it("offers one button, and makes it Review changes once there is something to review", () => {
    const working = card(STATES.working!);
    const review = card(STATES.review!);
    const unpublished = card({ state: "ready", publishable: true, changes: { files: 2, additions: 5, deletions: 1 }, screen: false, stoppable: false });
    expect(words(review)).toContain("Ready to review · 3 files changed");
    expect(words(review)).toContain("Review changes");
    expect(words(unpublished)).toContain("Review changes");
    expect(words(working)).toContain("Open");
    expect(words(working)).not.toContain("Review changes");
    for (const markup of [working, review, unpublished]) {
      expect(markup.match(/bg-accent/g)).toHaveLength(1);
    }
  });

  it("settles into Done, Stopped or Needs you", () => {
    expect(words(card(STATES.done!))).toContain("Done · Added to the project");
    expect(words(card(STATES.stopped!))).toContain("Stopped");
    const attention = card(STATES.attention!);
    expect(words(attention)).toContain("Needs you");
    expect(words(attention)).not.toContain("exited 1");
  });

  it("never shows a pull request number, a branch, a repository slug or a diff count", () => {
    for (const [state, patch] of Object.entries(STATES)) {
      const text = words(card(patch));
      expect(text, state).not.toMatch(/\bPR\b|#12|laterdog\/x|owner\/repo|\+40|−2|\bmerged?\b|\bbranch/i);
    }
    expect(words(card(STATES.review!))).toContain("repo");
  });

  it("is as wide as a message, in ink only", () => {
    for (const patch of Object.values(STATES)) {
      const markup = card(patch);
      expect(markup).toContain("max-w-[min(42rem,max(78%,18rem))]");
      expect(markup).not.toMatch(/(?:text|bg|ring|border)-(?:success|danger|warning)/);
    }
  });

  it("keeps one fixed shape from the first paint to the last state, so nothing in the chat jumps", () => {
    for (const [state, patch] of Object.entries(STATES)) {
      const markup = card(patch);
      expect(markup.match(/data-cloud-task-status/g), state).toHaveLength(1);
      expect(markup, state).toMatch(/data-cloud-task-status="true" class="[^"]*\bh-\[18px\]/);
      expect(markup.match(/data-cloud-task-progress/g), state).toHaveLength(1);
      expect(markup, state).toContain('class="flex h-8 items-center');
      expect(markup, state).toContain("h-7 shrink-0 rounded-full bg-accent");
    }
  });

  it("keeps its steps folded away until asked", () => {
    const markup = card(STATES.working!);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-label="Steps for Fix the login button"');
    expect(markup).not.toContain("data-cloud-task-steps");
  });
});

describe("CloudTaskUpdateRow", () => {
  it("shows a cloud task's wake-up as one quiet centred line that names the task, never as the person's words", () => {
    remember(ID, { state: "ready", changes: { files: 1, additions: 2, deletions: 0 }, screen: false, stoppable: false });
    const wakeup: Message = { id: "wake-1", role: "user", kind: "text", at: 2, sendId: `laterdog_${ID.replaceAll("-", "")}_9`, text: `later.dog job ${ID}: collected. Provider diff retained\nState: ready.` };
    const markup = renderToStaticMarkup(createElement(BotEditorStore, { value: { state: initialState, dispatch: vi.fn() } as never, children: createElement(CloudTaskUpdateRow, { message: wakeup }) }));
    expect(words(markup)).toBe("Cloud task finished · Fix the login button");
    expect(markup).toContain("justify-center");
    expect(markup).not.toContain("later.dog job");
  });
});

describe("the cloud task panel's place", () => {
  it("opens a task in the Computer panel's place and goes back to the dog's computer", () => {
    const opened = reducer({ ...initialState, settingsOpen: true }, { type: "openCloudTask", jobId: ID });
    expect(opened).toMatchObject({ computerOpen: true, cloudTaskId: ID, settingsOpen: false });
    const back = reducer(opened, { type: "closeCloudTask" });
    expect(back).toMatchObject({ computerOpen: true, cloudTaskId: null });
    expect(reducer(back, { type: "closeCloudTask" })).toBe(back);
    const reopened = reducer(opened, { type: "toggleComputer", open: false });
    expect(reopened).toMatchObject({ computerOpen: false, cloudTaskId: null });
    expect(reducer(reopened, { type: "toggleComputer", open: true })).toMatchObject({ computerOpen: true, cloudTaskId: null });
  });
});
