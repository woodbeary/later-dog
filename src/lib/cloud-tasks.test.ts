import { describe, expect, it } from "vitest";

import type { CloudTaskStep, CloudTaskSummary } from "../../shared/cloud-task";
import {
  cloudTaskActive, cloudTaskStatus, cloudTaskStatusClass, cloudWakeupOf, codingJobLine, dogCloudTasksPath, doingNote, elapsedLabel, filesChangedLabel, plainStep, plainSteps, projectName, wakeupLine,
} from "./cloud-tasks";

function summary(patch: Partial<CloudTaskSummary> = {}): CloudTaskSummary {
  return {
    id: "6a1f8f2e-1111-4222-8333-944444444444", title: "Fix the login button", state: "running", backend: "laterdog-cloud", repository: "owner/repo",
    kind: "implementation", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:05:00.000Z", outputBranch: "laterdog/x",
    screen: true, stoppable: true, publishable: false, ...patch,
  };
}

const status = (patch: Partial<CloudTaskSummary>) => cloudTaskStatus({ summary: summary(patch) });

const TECHNICAL = /\bPR\b|#\d|\bbranch|\bmerged?\b|\bcommit|\bdiff\b|\bgit\b|\bqueued\b|laterdog\/|owner\/repo/i;

describe("cloud task status", () => {
  it("names five plain states, and two while it is still being read", () => {
    expect(cloudTaskStatus(undefined)).toMatchObject({ phase: "checking", label: "Checking…", live: false, progress: 0 });
    expect(cloudTaskStatus({ missing: true })).toMatchObject({ phase: "unknown", label: "Not found" });
    expect(cloudTaskStatus({ error: "offline" })).toMatchObject({ phase: "unknown", label: "Can't check right now", detail: "offline" });
    expect(status({ stage: "claude" })).toMatchObject({ phase: "working", label: "Working", live: true });
    expect(status({ state: "ready", changes: { files: 2, additions: 3, deletions: 1 } })).toMatchObject({ phase: "review", label: "Ready to review", live: false, note: "2 files changed" });
    expect(status({ state: "merged" })).toMatchObject({ phase: "done", label: "Done", note: "Added to the project" });
    expect(status({ state: "cancelled" })).toMatchObject({ phase: "stopped", label: "Stopped", live: false });
    expect(status({ state: "needs_attention", blocker: "The job exited 1" })).toMatchObject({ phase: "attention", label: "Needs you", detail: "The job exited 1" });
    expect(status({ state: "submission_unknown", blocker: "Supervisor restarted" })).toMatchObject({ phase: "attention", label: "Needs you" });
  });

  it("calls every step of a running task Working, and says which step in plain words", () => {
    expect(status({ state: "preparing" })).toMatchObject({ label: "Working", note: "Getting a computer ready" });
    expect(status({ state: "submitting" })).toMatchObject({ label: "Working", note: "Getting a computer ready" });
    expect(status({})).toMatchObject({ label: "Working", note: "Starting its computer" });
    expect(status({ stage: "install" })).toMatchObject({ note: "Getting its tools ready" });
    expect(status({ stage: "clone" })).toMatchObject({ note: "Getting the code" });
    expect(status({ stage: "setup" })).toMatchObject({ note: "Setting up the project" });
    expect(status({ stage: "claude", lastStep: { t: 1, k: "tool", tool: "Edit", detail: "src/a.ts" } })).toMatchObject({ note: "Making changes" });
    expect(status({ stage: "done" })).toMatchObject({ note: "Wrapping up" });
    expect(status({ state: "collecting" })).toMatchObject({ label: "Working", note: "Gathering the changes" });
    expect(status({ state: "publishing" })).toMatchObject({ label: "Working", note: "Putting the changes on GitHub" });
    expect(status({ state: "verifying" })).toMatchObject({ label: "Working", note: "Checking the changes" });
    expect(status({ stage: "claude", blocker: "Reading job status on computer x exited 1" }).detail).toBeUndefined();
  });

  it("says why a task is waiting to start without the supervisor's wording", () => {
    expect(status({ state: "queued" })).toMatchObject({ phase: "waiting", label: "Waiting", live: true });
    expect(status({ state: "queued" }).note).toBeUndefined();
    expect(status({ state: "queued", blocker: "Waiting for dependency 1 (running); inspect that job before proceeding" }))
      .toMatchObject({ note: "Another task goes first", detail: "Waiting for dependency 1 (running); inspect that job before proceeding" });
    expect(status({ state: "queued", blocker: "Waiting for conflicting writer 2 to settle" })).toMatchObject({ note: "Another task goes first" });
    expect(status({ state: "queued", blocker: "All configured execution slots are occupied" })).toMatchObject({ note: "All cloud computers are busy" });
  });

  it("is ready to review once there are changes, with or without a draft, and done when nothing changed", () => {
    expect(status({ state: "ready", prUrl: "https://github.com/o/r/pull/12", prNumber: 12, changes: { files: 1, additions: 1, deletions: 0 } }))
      .toMatchObject({ phase: "review", label: "Ready to review", note: "1 file changed" });
    expect(status({ state: "ready", publishable: true, changes: { files: 3, additions: 40, deletions: 2 } })).toMatchObject({ phase: "review" });
    expect(status({ state: "ready", changes: { files: 0, additions: 0, deletions: 0 }, blocker: "Cloud task finished without a diff" }))
      .toMatchObject({ phase: "done", label: "Done", note: "No changes", detail: "Cloud task finished without a diff" });
    expect(status({ state: "ready", kind: "review" })).toMatchObject({ phase: "done", label: "Done" });
  });

  it("never puts a pull request number, a branch, a repository slug or a git word in the status", () => {
    const states: Array<Partial<CloudTaskSummary>> = [
      { state: "queued", blocker: "All configured execution slots are occupied" }, { state: "preparing" }, { stage: "clone" }, { stage: "claude", lastStep: { t: 1, k: "tool", tool: "Bash", detail: "git push origin laterdog/x" } },
      { state: "collecting" }, { state: "publishing" }, { state: "verifying" },
      { state: "ready", prUrl: "https://github.com/owner/repo/pull/12", prNumber: 12, changes: { files: 3, additions: 40, deletions: 2 } },
      { state: "ready", changes: { files: 0, additions: 0, deletions: 0 } }, { state: "merged", prNumber: 12 }, { state: "cancelled" }, { state: "needs_attention" },
    ];
    for (const patch of states) {
      const view = status(patch);
      expect(`${view.label} ${view.note ?? ""}`).not.toMatch(TECHNICAL);
    }
  });

  it("fills its progress by phase: a little while setting up, half while working, all once it is over", () => {
    const at = (patch: Partial<CloudTaskSummary>) => status(patch).progress;
    expect(at({ state: "queued" })).toBeLessThan(at({ state: "preparing" }));
    expect(at({ state: "preparing" })).toBeLessThan(at({ stage: "clone" }));
    expect(at({ stage: "clone" })).toBeLessThan(at({ stage: "claude" }));
    expect(at({ stage: "claude" })).toBeLessThan(at({ stage: "done" }));
    expect(at({ stage: "done" })).toBeLessThan(at({ state: "collecting" }));
    expect(at({ state: "ready" })).toBe(1);
    expect(at({ state: "merged" })).toBe(1);
    expect(at({ state: "needs_attention", stage: "setup" })).toBe(at({ stage: "setup" }));
    expect(at({ state: "cancelled" })).toBe(0);
    expect(cloudTaskStatus(undefined).progress).toBe(0);
  });

  it("draws the status in ink: the app's working sheen while live, full ink when it needs the person", () => {
    expect(cloudTaskStatusClass(status({ stage: "claude" }))).toBe("thinking-shimmer animate-shimmer");
    expect(cloudTaskStatusClass(status({ state: "needs_attention" }))).toBe("font-medium text-ink");
    expect(cloudTaskStatusClass(status({ state: "ready" }))).toBe("text-ink-secondary");
    expect(cloudTaskStatusClass(cloudTaskStatus(undefined))).toBe("text-ink-tertiary");
    for (const patch of [{ stage: "claude" }, { state: "ready" as const }, { state: "needs_attention" as const }, { state: "cancelled" as const }]) {
      expect(cloudTaskStatusClass(status(patch))).not.toMatch(/success|danger|warning|accent/);
    }
  });

  it("knows which tasks are still moving", () => {
    expect(cloudTaskActive(summary())).toBe(true);
    expect(cloudTaskActive(summary({ state: "ready" }))).toBe(false);
    expect(cloudTaskActive(undefined)).toBe(false);
  });
});

describe("what a task is doing, in plain words", () => {
  it("names the kind of work, never the file or the command", () => {
    expect(doingNote({ t: 1, k: "tool", tool: "Read", detail: "src/a.ts" })).toBe("Reading the code");
    expect(doingNote({ t: 1, k: "tool", tool: "Grep", detail: "login" })).toBe("Reading the code");
    expect(doingNote({ t: 1, k: "tool", tool: "Write", detail: "src/b.ts" })).toBe("Making changes");
    expect(doingNote({ t: 1, k: "tool", tool: "Bash", detail: "pnpm test" })).toBe("Running commands");
    expect(doingNote({ t: 1, k: "tool", tool: "WebSearch", detail: "react 19" })).toBe("Looking things up");
    expect(doingNote({ t: 1, k: "tool", tool: "Task", detail: "explore" })).toBe("Working with a helper");
    expect(doingNote({ t: 1, k: "tool", tool: "mcp__github__create_issue" })).toBe("Working on it");
    expect(doingNote({ t: 1, k: "plan", todos: [{ text: "Fix it", status: "in_progress" }] })).toBe("Planning its steps");
    expect(doingNote({ t: 1, k: "say", text: "Let me look at `src/a.ts`." })).toBe("Working on it");
    expect(doingNote({ t: 1, k: "stage", stage: "claude" })).toBe("Working on it");
    expect(doingNote(undefined)).toBe("Working on it");
  });
});

describe("cloud task steps and labels", () => {
  it("turns a step into a plain sentence with the exact file or command beside it", () => {
    expect(plainStep({ t: 1, k: "tool", tool: "Bash", detail: "pnpm test" })).toEqual({ text: "Ran a command", detail: "pnpm test" });
    expect(plainStep({ t: 1, k: "tool", tool: "Edit", detail: "src/a.ts" })).toEqual({ text: "Changed a file", detail: "src/a.ts" });
    expect(plainStep({ t: 1, k: "tool", tool: "Read", detail: "src/a.ts" })).toEqual({ text: "Looked at a file", detail: "src/a.ts" });
    expect(plainStep({ t: 1, k: "tool", tool: "Write" })).toEqual({ text: "Wrote a file" });
    expect(plainStep({ t: 1, k: "tool", tool: "WebFetch", detail: "https://example.com" })).toEqual({ text: "Opened a web page", detail: "https://example.com" });
    expect(plainStep({ t: 1, k: "tool", tool: "mcp__linear__create_issue", detail: "{}" })).toEqual({ text: "Used a tool", detail: "create issue" });
    expect(plainStep({ t: 1, k: "say", text: "\n  ## First `line`.\nSecond line." })).toEqual({ text: "First line." });
    expect(plainStep({ t: 1, k: "say", text: "  \n " })).toBeNull();
    expect(plainStep({ t: 1, k: "stage", stage: "setup" })).toEqual({ text: "Setting up the project" });
    expect(plainStep({ t: 1, k: "stage", stage: "claude" })).toEqual({ text: "Working on it" });
    expect(plainStep({ t: 1, k: "plan", todos: [{ text: "a", status: "pending" }] })).toEqual({ text: "Updated its plan" });
    expect(plainStep({ t: 1, k: "error", text: "ENOENT: no such file" })).toEqual({ text: "A step didn't work", detail: "ENOENT: no such file" });
    expect(plainStep({ t: 1, k: "done", ok: true })).toEqual({ text: "Finished" });
    expect(plainStep({ t: 1, k: "done", ok: false })).toEqual({ text: "Stopped" });
  });

  it("says a repeated step once and leaves the closing words to the finish line", () => {
    const steps: CloudTaskStep[] = [
      { t: 1, k: "stage", stage: "clone" }, { t: 2, k: "stage", stage: "clone" },
      { t: 3, k: "tool", tool: "Read", detail: "a.ts" }, { t: 4, k: "tool", tool: "Read", detail: "a.ts" }, { t: 5, k: "tool", tool: "Read", detail: "b.ts" },
      { t: 6, k: "say", text: "All done: the button works." }, { t: 7, k: "done", ok: true, text: "All done: the button works." },
    ];
    expect(plainSteps(steps)).toEqual([
      { text: "Getting the code" }, { text: "Looked at a file", detail: "a.ts" }, { text: "Looked at a file", detail: "b.ts" }, { text: "Finished" },
    ]);
    expect(plainSteps(Array.from({ length: 250 }, (_, index): CloudTaskStep => ({ t: index, k: "tool", tool: "Read", detail: `f${index}.ts` })))).toHaveLength(200);
  });

  it("names the project by its repository's name alone", () => {
    expect(projectName("woodbeary/later-dog")).toBe("later-dog");
    expect(projectName("later-dog")).toBe("later-dog");
    expect(projectName(undefined)).toBe("");
  });

  it("counts changed files with the right singular", () => {
    expect(filesChangedLabel(1)).toBe("1 file changed");
    expect(filesChangedLabel(7)).toBe("7 files changed");
  });

  it("measures how long a task has run", () => {
    const now = Date.parse("2026-10-10T01:15:00.000Z");
    expect(elapsedLabel(summary({ startedAt: "2026-10-10T01:14:40.000Z" }), now)).toBe("under a minute");
    expect(elapsedLabel(summary({ startedAt: "2026-10-10T01:03:00.000Z" }), now)).toBe("12 min");
    expect(elapsedLabel(summary({ startedAt: "2026-10-10T00:00:00.000Z" }), now)).toBe("1 h 15 min");
    expect(elapsedLabel(summary({ state: "ready", startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T00:07:00.000Z" }), now)).toBe("7 min");
    expect(elapsedLabel(undefined, now)).toBeNull();
  });
});

describe("cloud task wake-ups in the chat", () => {
  const sendId = `laterdog_${"6a1f8f2e-1111-4222-8333-944444444444".replaceAll("-", "")}_17`;
  it("recognises the supervisor's wake-up and the job it is about", () => {
    const text = "later.dog job 6a1f8f2e-1111-4222-8333-944444444444: collected. Provider diff retained\nState: ready.";
    expect(cloudWakeupOf({ role: "user", kind: "text", sendId, text })).toEqual({ jobId: "6a1f8f2e-1111-4222-8333-944444444444", event: "collected" });
    expect(cloudWakeupOf({ role: "user", kind: "text", sendId, text: "odd" })).toEqual({ jobId: "6a1f8f2e-1111-4222-8333-944444444444", event: "updated" });
    expect(cloudWakeupOf({ role: "user", kind: "text", sendId: "client-send-1", text })).toBeNull();
    expect(cloudWakeupOf({ role: "bot", kind: "text", sendId, text })).toBeNull();
    expect(cloudWakeupOf({ role: "user", kind: "text", text })).toBeNull();
  });

  it("says what happened in plain words, without pull requests or merges", () => {
    expect(wakeupLine("collected")).toBe("Cloud task finished");
    expect(wakeupLine("published")).toBe("Cloud task is ready to review");
    expect(wakeupLine("verified")).toBe("Cloud task's changes were checked");
    expect(wakeupLine("merged")).toBe("Cloud task is done");
    expect(wakeupLine("provider_failed")).toBe("Cloud task needs you");
    expect(wakeupLine("wakeup_dropped")).toBe("Cloud task update");
    for (const event of ["collected", "published", "verified", "reviewed", "merged", "publication_blocked", "other"]) {
      expect(wakeupLine(event)).not.toMatch(TECHNICAL);
    }
  });
});

describe("a dog's coding jobs", () => {
  it("asks the jobs service for one dog's newest jobs", () => {
    expect(dogCloudTasksPath("dog 1")).toBe("/api/laterdog/jobs?bot=dog%201&limit=20");
  });

  it("sums each job up in one plain line: project, status, time", () => {
    const now = Date.parse("2026-10-10T00:08:00.000Z");
    expect(codingJobLine(summary({ state: "ready", startedAt: "2026-10-10T00:00:00.000Z", finishedAt: "2026-10-10T00:05:00.000Z", changes: { files: 2, additions: 3, deletions: 1 } }), now))
      .toBe("repo · Ready to review · 5 min");
    expect(codingJobLine(summary({ state: "cancelled" }), now)).toMatch(/^repo · Stopped/);
  });
});
