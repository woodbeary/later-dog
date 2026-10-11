import { describe, expect, it } from "vitest";

import { cloudTaskStep, cloudTaskSummary, lastMeaningfulStep, parseCloudTaskSteps, patchChanges, patchFiles } from "./cloud-task.ts";
import type { Job } from "./laterdog.ts";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,2 +1,2 @@",
  "-old",
  "+new",
  " same",
  "diff --git a/docs/new.md b/docs/new.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/docs/new.md",
  "@@ -0,0 +1,2 @@",
  "+# Title",
  "+line",
  "diff --git a/logo.png b/logo.png",
  "Binary files a/logo.png and b/logo.png differ",
  "",
].join("\n");

function job(patch: Partial<Job> = {}): Job {
  return {
    id: "6a1f8f2e-1111-4222-8333-944444444444", requestKey: "request-key-1", repository: "owner/repo", title: "Do the thing", brief: "b",
    standingInstructions: "", writeScopes: ["src"], dependencies: [], profileId: "cloud", kind: "implementation",
    state: "running", backend: "laterdog-cloud", attempt: 1, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:05:00.000Z",
    outputBranch: "laterdog/x", taskId: "cmp_abc", ...patch,
  };
}

describe("cloud task steps", () => {
  it("keeps only well-formed steps and bounds their text", () => {
    expect(cloudTaskStep({ t: 1, k: "stage", stage: "setup" })).toEqual({ t: 1, k: "stage", stage: "setup" });
    expect(cloudTaskStep({ t: 1, k: "stage", stage: "Bad Stage!" })).toBeNull();
    expect(cloudTaskStep({ t: 1, k: "say", text: "   " })).toBeNull();
    expect((cloudTaskStep({ t: 1, k: "say", text: "x".repeat(10_000) }) as { text: string }).text).toHaveLength(4000);
    expect(cloudTaskStep({ t: 1, k: "tool", tool: "Bash", detail: "pnpm test" })).toEqual({ t: 1, k: "tool", tool: "Bash", detail: "pnpm test" });
    expect(cloudTaskStep({ t: 1, k: "plan", todos: [{ text: "one", status: "completed" }, { text: "two", status: "weird" }, { nope: true }] }))
      .toEqual({ t: 1, k: "plan", todos: [{ text: "one", status: "completed" }, { text: "two", status: "pending" }] });
    expect(cloudTaskStep({ t: 1, k: "done", ok: false, turns: 3 })).toEqual({ t: 1, k: "done", ok: false, turns: 3 });
    expect(cloudTaskStep({ t: 1, k: "unknown" })).toBeNull();
    expect(cloudTaskStep("text")).toBeNull();
  });

  it("parses complete lines only and counts the bytes it consumed", () => {
    const first = `${JSON.stringify({ t: 1, k: "say", text: "héllo ✓" })}\n`;
    const second = `${JSON.stringify({ t: 2, k: "tool", tool: "Read", detail: "a.ts" })}\n`;
    const partial = '{"t":3,"k":"say","te';
    const parsed = parseCloudTaskSteps(first + "not json\n" + second + partial);
    expect(parsed.steps.map((step) => step.k)).toEqual(["say", "tool"]);
    expect(parsed.consumedBytes).toBe(new TextEncoder().encode(`${first}not json\n${second}`).length);
    expect(parseCloudTaskSteps(partial)).toEqual({ steps: [], consumedBytes: 0 });
  });

  it("finds the latest step that is not a plan", () => {
    expect(lastMeaningfulStep([{ t: 1, k: "say", text: "a" }, { t: 2, k: "plan", todos: [{ text: "x", status: "pending" }] }])).toEqual({ t: 1, k: "say", text: "a" });
  });
});

describe("cloud task changes", () => {
  it("counts files, additions and deletions", () => {
    expect(patchChanges(PATCH)).toEqual({ files: 3, additions: 3, deletions: 1 });
    expect(patchChanges("")).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  it("splits a patch into files with their own hunks", () => {
    const files = patchFiles(PATCH);
    expect(files.map(({ path, additions, deletions, binary }) => ({ path, additions, deletions, binary }))).toEqual([
      { path: "src/a.ts", additions: 1, deletions: 1, binary: false },
      { path: "docs/new.md", additions: 2, deletions: 0, binary: false },
      { path: "logo.png", additions: 0, deletions: 0, binary: true },
    ]);
    expect(files[0].hunks).toBe("@@ -1,2 +1,2 @@\n-old\n+new\n same");
  });
});

describe("cloud task summary", () => {
  it("offers the screen and Stop only while a later.dog Cloud task runs", () => {
    expect(cloudTaskSummary(job())).toMatchObject({ screen: true, stoppable: true, publishable: false });
    expect(cloudTaskSummary(job({ backend: "codex-cloud" }))).toMatchObject({ screen: false, stoppable: false });
    expect(cloudTaskSummary(job({ state: "queued", taskId: undefined }))).toMatchObject({ screen: false, stoppable: true });
    expect(cloudTaskSummary(job({ cancelRequested: true }))).toMatchObject({ stoppable: false });
  });

  it("offers a draft PR only for a collected diff with changes and no PR yet", () => {
    const ready = { state: "ready" as const, patchArtifact: "/tmp/x.patch", changes: { files: 2, additions: 3, deletions: 1 } };
    expect(cloudTaskSummary(job(ready)).publishable).toBe(true);
    expect(cloudTaskSummary(job({ ...ready, changes: { files: 0, additions: 0, deletions: 0 } })).publishable).toBe(false);
    expect(cloudTaskSummary(job({ ...ready, prUrl: "https://github.com/owner/repo/pull/1" })).publishable).toBe(false);
    expect(cloudTaskSummary(job({ ...ready, kind: "review" })).publishable).toBe(false);
  });

  it("leaves the brief and artifacts out", () => {
    const summary = cloudTaskSummary(job({ brief: "secret plan", patchArtifact: "/data/x.patch", activityArtifact: "/data/x.activity.jsonl" }));
    expect(JSON.stringify(summary)).not.toMatch(/secret plan|\/data\//);
  });
});
