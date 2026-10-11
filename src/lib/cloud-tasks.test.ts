import { describe, expect, it } from "vitest";

import type { CloudTaskSummary } from "../../shared/cloud-task";
import { changesLabel, cloudTaskActive, cloudTaskStatus, elapsedLabel, filesChangedLabel, stepHeadline } from "./cloud-tasks";

function summary(patch: Partial<CloudTaskSummary> = {}): CloudTaskSummary {
  return {
    id: "6a1f8f2e-1111-4222-8333-944444444444", title: "Fix the login button", state: "running", backend: "laterdog-cloud", repository: "owner/repo",
    kind: "implementation", createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:05:00.000Z", outputBranch: "laterdog/x",
    screen: true, stoppable: true, publishable: false, ...patch,
  };
}

describe("cloud task status", () => {
  it("says what the task is doing in plain words", () => {
    expect(cloudTaskStatus(undefined)).toMatchObject({ label: "Checking…", live: false });
    expect(cloudTaskStatus({ missing: true })).toMatchObject({ label: "Not found" });
    expect(cloudTaskStatus({ error: "offline" })).toMatchObject({ label: "Can't reach the cloud", tone: "warning", detail: "offline" });
    expect(cloudTaskStatus({ summary: summary({ state: "queued" }) })).toMatchObject({ label: "Queued", live: true });
    expect(cloudTaskStatus({ summary: summary({ state: "queued", blocker: "Waiting for dependency x" }) })).toMatchObject({ label: "Waiting", detail: "Waiting for dependency x" });
    expect(cloudTaskStatus({ summary: summary({ state: "preparing" }) })).toMatchObject({ label: "Starting", tone: "accent", live: true });
    expect(cloudTaskStatus({ summary: summary({ stage: "clone" }) })).toMatchObject({ label: "Setting up", live: true });
    expect(cloudTaskStatus({ summary: summary({ stage: "claude" }) })).toMatchObject({ label: "Working", live: true });
    expect(cloudTaskStatus({ summary: summary({ stage: "done" }) })).toMatchObject({ label: "Wrapping up" });
    expect(cloudTaskStatus({ summary: summary({ state: "collecting" }) })).toMatchObject({ label: "Collecting changes" });
    expect(cloudTaskStatus({ summary: summary({ state: "ready", changes: { files: 2, additions: 3, deletions: 1 } }) })).toMatchObject({ label: "Ready for review", tone: "success", live: false });
    expect(cloudTaskStatus({ summary: summary({ state: "ready", changes: { files: 0, additions: 0, deletions: 0 } }) })).toMatchObject({ label: "Finished, no changes" });
    expect(cloudTaskStatus({ summary: summary({ state: "ready", prUrl: "https://github.com/o/r/pull/12", prNumber: 12 }) })).toMatchObject({ label: "PR #12", tone: "success" });
    expect(cloudTaskStatus({ summary: summary({ state: "needs_attention", blocker: "The job exited 1" }) })).toMatchObject({ label: "Needs attention", tone: "danger", detail: "The job exited 1" });
    expect(cloudTaskStatus({ summary: summary({ state: "cancelled" }) })).toMatchObject({ label: "Stopped", live: false });
    expect(cloudTaskStatus({ summary: summary({ state: "merged" }) })).toMatchObject({ label: "Merged" });
  });

  it("knows which tasks are still moving", () => {
    expect(cloudTaskActive(summary())).toBe(true);
    expect(cloudTaskActive(summary({ state: "ready" }))).toBe(false);
    expect(cloudTaskActive(undefined)).toBe(false);
  });
});

describe("cloud task steps and labels", () => {
  it("turns a step into one readable line", () => {
    expect(stepHeadline({ t: 1, k: "tool", tool: "Bash", detail: "pnpm test" })).toBe("Ran pnpm test");
    expect(stepHeadline({ t: 1, k: "tool", tool: "Edit", detail: "src/a.ts" })).toBe("Edited src/a.ts");
    expect(stepHeadline({ t: 1, k: "tool", tool: "TodoRead" })).toBe("TodoRead");
    expect(stepHeadline({ t: 1, k: "say", text: "\n  First line.\nSecond line." })).toBe("First line.");
    expect(stepHeadline({ t: 1, k: "stage", stage: "setup" })).toBe("Setting up the project");
    expect(stepHeadline({ t: 1, k: "done", ok: false })).toBe("Stopped");
  });

  it("counts changes with the right singular", () => {
    expect(changesLabel({ files: 1, additions: 4, deletions: 2 })).toBe("1 file changed · +4 −2");
    expect(changesLabel({ files: 3, additions: 10, deletions: 0 })).toBe("3 files changed · +10 −0");
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
