import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { rememberCloudTasks } from "@/lib/cloud-tasks";
import { BotEditorStore, initialState, reducer, type Message } from "@/state/store";
import type { CloudTaskSummary } from "../../shared/cloud-task";
import { CloudTaskCard } from "./CloudTaskCard";

const ID = "6a1f8f2e-1111-4222-8333-944444444444";

function message(jobId = ID): Message {
  return { id: `card-${jobId}`, role: "bot", kind: "activity", at: 1, tool: { name: "Cloud task: Fix the login button", ok: true }, cloudTask: { jobId, title: "Fix the login button", repository: "owner/repo", backend: "laterdog-cloud" } };
}

function render(value: Message) {
  return renderToStaticMarkup(createElement(BotEditorStore, { value: { state: initialState, dispatch: vi.fn() } as never }, createElement(CloudTaskCard, { message: value })));
}

function remember(id: string, patch: Partial<CloudTaskSummary>) {
  rememberCloudTasks([{
    id, title: "Fix the login button", state: "running", backend: "laterdog-cloud", repository: "owner/repo", kind: "implementation",
    createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:05:00.000Z", outputBranch: "laterdog/x", screen: true, stoppable: true, publishable: false, ...patch,
  }]);
}

describe("CloudTaskCard", () => {
  it("shows the task's title straight away, before its status arrives", () => {
    const markup = render(message("11111111-1111-4111-8111-111111111111"));
    expect(markup).toContain("Cloud task");
    expect(markup).toContain("Fix the login button");
    expect(markup).toContain("Checking…");
    expect(markup).toContain('data-testid="cloud-task-card"');
  });

  it("says what a running task is doing right now", () => {
    remember(ID, { stage: "claude", lastStep: { t: 1, k: "tool", tool: "Bash", detail: "pnpm test" } });
    const markup = render(message());
    expect(markup).toContain("Working");
    expect(markup).toContain("Ran pnpm test");
    expect(markup).toContain("animate-spin");
  });

  it("links a finished task's pull request and counts its changes", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    remember(id, { state: "ready", prUrl: "https://github.com/owner/repo/pull/12", prNumber: 12, changes: { files: 3, additions: 40, deletions: 2 }, screen: false, stoppable: false });
    const markup = render(message(id));
    expect(markup).toContain("PR #12");
    expect(markup).toContain("View PR #12");
    expect(markup).toContain("3 files changed · +40 −2");
    expect(markup).not.toContain("animate-spin");
  });

  it("names why a task needs attention", () => {
    const id = "33333333-3333-4333-8333-333333333333";
    remember(id, { state: "needs_attention", blocker: "The job exited 1 during setup", screen: false, stoppable: false });
    const markup = render(message(id));
    expect(markup).toContain("Needs attention");
    expect(markup).toContain("The job exited 1 during setup");
  });
});

describe("the cloud task panel's place", () => {
  it("opens a task in the Computer panel's place and goes back to the dog's computer", () => {
    const opened = reducer({ ...initialState, settingsOpen: true, activityOpen: true }, { type: "openCloudTask", jobId: ID });
    expect(opened).toMatchObject({ computerOpen: true, cloudTaskId: ID, settingsOpen: false, activityOpen: false, inspectorOpen: false });
    const back = reducer(opened, { type: "closeCloudTask" });
    expect(back).toMatchObject({ computerOpen: true, cloudTaskId: null });
    expect(reducer(back, { type: "closeCloudTask" })).toBe(back);
    const reopened = reducer(opened, { type: "toggleComputer", open: false });
    expect(reopened).toMatchObject({ computerOpen: false, cloudTaskId: null });
    expect(reducer(reopened, { type: "toggleComputer", open: true })).toMatchObject({ computerOpen: true, cloudTaskId: null });
  });
});
