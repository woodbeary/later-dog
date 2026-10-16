import { describe, expect, it } from "vitest";
import { githubApi, requiredReleaseJobs, REQUIRED_RELEASE_JOBS, waitForReleaseCi } from "./release-ci.mjs";

const SHA = "a".repeat(40);
const run = (id = 1, status = "completed", event = "push", sha = SHA) => ({ id, status, event, conclusion: status === "completed" ? "success" : null, head_sha: sha, created_at: `2026-10-16T10:${String(id).padStart(2, "0")}:00Z` });

describe("release CI gate", () => {
  it("requires all concrete jobs derived from the actual workflow", () => {
    expect(REQUIRED_RELEASE_JOBS).toContain("vitest (shard 4/4)");
    expect(REQUIRED_RELEASE_JOBS).toContain("renderer tests (Ubuntu 24.04)");
    expect(requiredReleaseJobs({ jobs: { verify: {}, tests: { name: "test ${{ matrix.shard }}", strategy: { matrix: { shard: [1, 2] } } } } })).toEqual(["verify", "test 1", "test 2"]);
    expect(() => requiredReleaseJobs({ jobs: { other: { strategy: { matrix: { os: ["linux"] } } } } })).toThrow("Unsupported");
  });

  it("accepts successful CI only for the exact source commit", async () => {
    const result = await waitForReleaseCi({ sha: SHA, api: { runsForCommit: async () => [run()], gateConclusion: async () => "success" }, log: () => {} });
    expect(result).toEqual({ ok: true, runId: 1 });
    for (const runs of [[], [run(1, "completed", "pull_request")], [run(1, "completed", "push", "b".repeat(40))]]) {
      expect(await waitForReleaseCi({ sha: SHA, api: { runsForCommit: async () => runs, gateConclusion: async () => "success" } })).toMatchObject({ ok: false, reason: expect.stringContaining("No source-commit") });
    }
  });

  it("never uses an earlier success to hide a newer failed run", async () => {
    expect(await waitForReleaseCi({ sha: SHA, api: { runsForCommit: async () => [run(1), run(2)], gateConclusion: async (id: number) => id === 1 ? "success" : "failure" } })).toMatchObject({ ok: false, reason: expect.stringContaining("run 2") });
    for (const conclusion of ["cancelled", "failure", null]) expect(await waitForReleaseCi({ sha: SHA, api: { runsForCommit: async () => [{ ...run(), conclusion }], gateConclusion: async () => "success" } })).toMatchObject({ ok: false, reason: expect.stringContaining("did not succeed") });
  });

  it("waits for existing CI without creating branches or dispatching workflows", async () => {
    let calls = 0;
    let time = 0;
    const api = { runsForCommit: async () => [run(1, ++calls === 1 ? "in_progress" : "completed")], gateConclusion: async () => "success" };
    expect(await waitForReleaseCi({ sha: SHA, api, now: () => time, sleep: async (ms: number) => { time += ms; }, log: () => {} })).toMatchObject({ ok: true });
    expect(calls).toBe(2);
  });

  it("fails closed for missing, skipped, cancelled and failed jobs", async () => {
    for (const status of [null, "skipped", "cancelled", "failure"]) {
      const api = githubApi({ token: "fixture", repository: "o/r", fetchImpl: async () => Response.json({ jobs: REQUIRED_RELEASE_JOBS.map((name: string, index: number) => ({ name, conclusion: index ? "success" : status })) }) });
      expect(await api.gateConclusion(1)).not.toBe("success");
    }
    const missing = githubApi({ token: "fixture", repository: "o/r", fetchImpl: async () => Response.json({ jobs: [] }) });
    expect(await missing.gateConclusion(1)).toContain("missing");
  });

  it("retries transient read failures and never repeats a forbidden call", async () => {
    let count = 0;
    const api = githubApi({ token: "fixture", repository: "o/r", retryDelaysMs: [1], sleep: async () => {}, fetchImpl: async () => ++count === 1 ? new Response(null, { status: 500 }) : Response.json({ workflow_runs: [run()] }) });
    expect(await api.runsForCommit(SHA)).toHaveLength(1);
    expect(count).toBe(2);
    const forbidden = githubApi({ token: "fixture", repository: "o/r", fetchImpl: async () => new Response(null, { status: 403 }) });
    await expect(forbidden.runsForCommit(SHA)).rejects.toThrow("HTTP 403");
  });
});
