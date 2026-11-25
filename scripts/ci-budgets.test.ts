import { describe, expect, it, vi } from "vitest";
import { evaluateJobs, loadJobs, main } from "./ci-budgets.mjs";

type Step = {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};
type Job = {
  id: number;
  run_id: number;
  run_attempt: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  steps: Step[];
};
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 25) + seconds * 1000).toISOString();
const env = {
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_RUN_ID: "12",
  GITHUB_RUN_ATTEMPT: "3",
  GH_TOKEN: "fixture-read-token",
  NEEDS: JSON.stringify({ scope: { result: "success", outputs: { runtime: "true" } } }),
};

function fixture(): Job[] {
  const names = [
    "scope",
    "lint",
    "typecheck",
    "build",
    "electron-broker",
    ...Array.from({ length: 8 }, (_, i) => `suite ${i + 1}/8`),
    "side deploy/laterdog/home",
    "side deploy/laterdog/computers",
    "side cloudflare/control-plane",
    "interface",
    "CI",
  ];
  return names.map((name, i) => {
    const phases =
      name === "scope"
        ? ["Select docs-only or runtime checks"]
        : name === "lint"
          ? ["Lint", "Check repository rules and hosted-check contracts"]
          : name === "typecheck"
            ? ["Typecheck the app and the server"]
            : name === "build"
              ? ["Build the interface", "Smoke the packaged server"]
              : name === "electron-broker"
                ? ["Electron node tests", "Broker tests"]
                : name.startsWith("suite ")
                  ? [`Main suite, shard ${name.split(" ")[1].split("/")[0]} of 8`]
                  : name.startsWith("side ")
                    ? [`Tests in ${name.slice(5)}`]
                    : name === "interface"
                      ? ["Drive the real renderer"]
                      : ["Check time budgets"];
    return {
      id: i + 1,
      run_id: 12,
      run_attempt: 3,
      name,
      status: "completed",
      conclusion: "success",
      created_at: at(8),
      started_at: at(10),
      completed_at: at(80),
      steps: phases.map((phase, j) => ({
        name: phase,
        status: "completed",
        conclusion: "success",
        started_at: at(15 + j),
        completed_at: at(16 + j),
      })),
    };
  });
}

describe("CI time budgets", () => {
  it("accepts measured jobs below every budget and counts setup wall time once", () => {
    const jobs = fixture();
    jobs[1].steps.unshift({
      name: "Run prepare",
      status: "completed",
      conclusion: "success",
      started_at: at(11),
      completed_at: at(14),
    });
    const result = evaluateJobs(jobs, true);
    expect(result).toMatchObject({ ok: true, problems: [] });
    expect(result.rows.find((row) => row.name === "lint")).toMatchObject({ waiting: 2, setup: 5 });
  });

  it.each([
    ["waiting", 10],
    ["setup", 30],
    ["Lint", 5],
    ["Typecheck the app and the server", 5],
    ["Main suite, shard 1 of 8", 60],
    ["Tests in deploy/laterdog/home", 60],
    ["Drive the real renderer", 60],
    ["Electron node tests", 60],
    ["Broker tests", 60],
    ["Check repository rules and hosted-check contracts", 60],
    ["Smoke the packaged server", 60],
  ] as const)("rejects %s exactly at its strict %i-second boundary", (phase, limit) => {
    const jobs = fixture();
    if (phase === "waiting") jobs[0].created_at = at(0);
    else if (phase === "setup") {
      jobs[0].steps[0].started_at = at(40);
      jobs[0].steps[0].completed_at = at(41);
    } else {
      const step = jobs.flatMap((job) => job.steps).find((item) => item.name === phase)!;
      step.completed_at = new Date(Date.parse(step.started_at!) + limit * 1000).toISOString();
    }
    expect(evaluateJobs(jobs, true)).toMatchObject({
      ok: false,
      problems: [expect.stringContaining(`${phase} ${limit.toFixed(3)}s`)],
    });
  });

  it("collects overruns from several jobs", () => {
    const jobs = fixture();
    jobs[1].steps[0].completed_at = at(22);
    jobs[2].steps[0].completed_at = at(23);
    const result = evaluateJobs(jobs, true);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([
      expect.stringContaining("Lint 7.000s"),
      expect.stringContaining("Typecheck the app and the server 8.000s"),
    ]);
  });

  it("rejects missing, invalid and negative timestamps instead of counting zero", () => {
    for (const value of [null, "bad", at(7)]) {
      const jobs = fixture();
      jobs[0].started_at = value;
      expect(evaluateJobs(jobs, true).problems).toContain("scope: waiting has no valid timing");
    }
    const jobs = fixture();
    jobs[1].steps[0].completed_at = null;
    expect(evaluateJobs(jobs, true).problems).toContain("lint: Lint has no valid timing");
  });

  it("rejects a missing, duplicate, unknown, cancelled or incomplete job", () => {
    const missing = fixture().filter((job) => job.name !== "suite 8/8");
    expect(evaluateJobs(missing, true).ok).toBe(false);
    const duplicate = fixture();
    duplicate[6] = { ...duplicate[5] };
    expect(evaluateJobs(duplicate, true).ok).toBe(false);
    const unknown = fixture();
    unknown.push({ ...unknown[0], id: 99, name: "new test job" });
    expect(evaluateJobs(unknown, true).problems).toContain("Unknown job: new test job");
    for (const status of ["queued", "in_progress", "cancelled"]) {
      const jobs = fixture();
      jobs[0].status = status;
      jobs[0].conclusion = null;
      expect(evaluateJobs(jobs, true).ok).toBe(false);
    }
  });

  it("rejects missing or duplicate phase steps and steps that never ran", () => {
    const jobs = fixture();
    jobs[1].steps.push({ ...jobs[1].steps[0] });
    jobs[2].steps = [];
    jobs[4].steps[1].conclusion = "skipped";
    expect(evaluateJobs(jobs, true).problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("exactly one timed Lint"),
        expect.stringContaining("exactly one timed Typecheck"),
        expect.stringContaining("Broker tests did not finish"),
      ]),
    );
  });

  it("accepts runtime skips only for the docs-only selection", () => {
    const jobs = fixture().filter(
      (job) => !job.name.startsWith("suite ") && !job.name.startsWith("side "),
    );
    jobs.push(
      { ...jobs[0], id: 98, name: "suite ${{ matrix.shard }}/8" },
      { ...jobs[0], id: 99, name: "side ${{ matrix.dir }}" },
    );
    for (const job of jobs.filter(
      (item) => !["scope", "lint", "typecheck", "CI"].includes(item.name),
    )) {
      job.conclusion = "skipped";
      job.steps = [];
    }
    expect(evaluateJobs(jobs, false).ok).toBe(true);
    expect(evaluateJobs(jobs, true).ok).toBe(false);
    jobs[0].conclusion = "skipped";
    expect(evaluateJobs(jobs, false).ok).toBe(false);
  });

  it("checks the current final job's wait and setup while it runs", () => {
    const jobs = fixture();
    const current = jobs.find((job) => job.name === "CI")!;
    current.status = "in_progress";
    current.conclusion = null;
    current.steps = [];
    expect(evaluateJobs(jobs, true, at(15)).ok).toBe(true);
    expect(evaluateJobs(jobs, true, at(40)).problems).toContain(
      "CI: setup 30.000s exceeds the <30s budget",
    );
  });

  it.each([
    "suite placeholder",
    "side placeholder",
    "wrong shard phase",
    "wrong side phase",
    "duplicate build anchor",
    "incomplete scope phase",
    "phase before job",
    "phase after job",
    "missing job end",
  ])("rejects incorrect job/phase identity and chronology: %s", (kind) => {
    const jobs = fixture();
    const suite = jobs.find((job) => job.name === "suite 8/8")!;
    const side = jobs.find((job) => job.name === "side deploy/laterdog/home")!;
    const build = jobs.find((job) => job.name === "build")!;
    if (kind === "suite placeholder") suite.name = "suite ${{ matrix.shard }}/8";
    if (kind === "side placeholder") side.name = "side ${{ matrix.dir }}";
    if (kind === "wrong shard phase") suite.steps[0].name = "Main suite, shard 1 of 8";
    if (kind === "wrong side phase") side.steps[0].name = "Tests in deploy/laterdog/computers";
    if (kind === "duplicate build anchor") build.steps.push({ ...build.steps[0] });
    if (kind === "incomplete scope phase") {
      jobs[0].steps[0].status = "in_progress";
      jobs[0].steps[0].conclusion = null;
      jobs[0].steps[0].completed_at = null;
    }
    if (kind === "phase before job") {
      jobs[1].steps[1].started_at = at(9);
      jobs[1].steps[1].completed_at = at(10);
    }
    if (kind === "phase after job") {
      jobs[1].steps[1].started_at = at(79);
      jobs[1].steps[1].completed_at = at(81);
    }
    if (kind === "missing job end") jobs[0].completed_at = null;
    expect(evaluateJobs(jobs, true).ok).toBe(false);
  });

  it("rejects empty input or an unknown scope", () => {
    expect(evaluateJobs([], true).ok).toBe(false);
    expect(evaluateJobs(fixture(), undefined).ok).toBe(false);
  });
});

describe("workflow timing input", () => {
  it("reads every page for the exact attempt with a read token and no redirect", async () => {
    const rows = Array.from({ length: 101 }, (_, id) => ({
      id: id + 1,
      run_id: 12,
      run_attempt: 3,
    }));
    const fetcher = vi
      .fn(async () => Response.json({ total_count: 101, jobs: rows.slice(0, 100) }))
      .mockResolvedValueOnce(Response.json({ total_count: 101, jobs: rows.slice(0, 100) }))
      .mockResolvedValueOnce(Response.json({ total_count: 101, jobs: rows.slice(100) }));
    expect(await loadJobs(env, fetcher)).toHaveLength(101);
    expect(fetcher.mock.calls[0]).toEqual([
      "https://api.github.com/repos/owner/repo/actions/runs/12/attempts/3/jobs?per_page=100&page=1",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({ Authorization: "Bearer fixture-read-token" }),
      }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed on denied, empty, inconsistent or truncated API responses", async () => {
    await expect(loadJobs(env, async () => new Response("", { status: 403 }))).rejects.toThrow(
      "HTTP 403",
    );
    await expect(
      loadJobs(env, async () => Response.json({ total_count: 0, jobs: [] })),
    ).rejects.toThrow("Incomplete");
    const changing = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ total_count: 2, jobs: [{ id: 1, run_id: 12, run_attempt: 3 }] }),
      )
      .mockResolvedValueOnce(
        Response.json({ total_count: 3, jobs: [{ id: 2, run_id: 12, run_attempt: 3 }] }),
      );
    await expect(loadJobs(env, changing)).rejects.toThrow("Incomplete");
    const truncated = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ total_count: 2, jobs: [{ id: 1, run_id: 12, run_attempt: 3 }] }),
      )
      .mockResolvedValueOnce(Response.json({ total_count: 2, jobs: [] }));
    await expect(loadJobs(env, truncated)).rejects.toThrow("Incomplete");
  });

  it.each([{ run_id: 13, run_attempt: 3 }, { run_id: 12, run_attempt: 2 }, { run_id: 12 }])(
    "rejects metadata from another run/attempt or with missing identity: %j",
    async (identity) => {
      await expect(
        loadJobs(env, async () =>
          Response.json({ total_count: 1, jobs: [{ id: 1, ...identity }] }),
        ),
      ).rejects.toThrow("another run or attempt");
    },
  );

  it("does not request timings without valid workflow context", async () => {
    const fetcher = vi.fn();
    for (const values of [
      { ...env, GH_TOKEN: "" },
      { ...env, GITHUB_REPOSITORY: "../other" },
      { ...env, GITHUB_REPOSITORY: "owner/.." },
      { ...env, GITHUB_REPOSITORY: "owner/." },
      { ...env, GITHUB_RUN_ID: "0" },
      { ...env, GITHUB_RUN_ATTEMPT: "" },
    ])
      await expect(loadJobs(values, fetcher)).rejects.toThrow("context");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a nonzero verdict for slow successful jobs and retains all diagnostics", async () => {
    const jobs = fixture();
    jobs[1].steps[0].completed_at = at(22);
    jobs[2].steps[0].completed_at = at(23);
    const output: string[] = [];
    const code = await main(
      env,
      async () => Response.json({ total_count: jobs.length, jobs }),
      (message: string) => {
        output.push(message);
      },
    );
    expect(code).toBe(1);
    expect(output.join("")).toContain("Lint 7.000s");
    expect(output.join("")).toContain("Typecheck the app and the server 8.000s");
    expect(output.join("")).not.toContain(env.GH_TOKEN);
    expect(
      await main(
        env,
        async () => Response.json({ total_count: fixture().length, jobs: fixture() }),
        () => {},
      ),
    ).toBe(0);
  });
});
