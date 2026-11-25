import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  analyze,
  analyzeLogs,
  loadRuns,
  parseTestDurations,
  percentile,
  renderLogReport,
  renderReport,
  runnerOs,
  splitJob,
} from "./ci-audit.mjs";

const folders = [];

afterEach(() => {
  while (folders.length) fs.rmSync(folders.pop(), { recursive: true, force: true });
});

function folder() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-audit-"));
  folders.push(dir);
  return dir;
}

function step(name, start, end, conclusion = "success") {
  return {
    name,
    conclusion,
    started_at: `2026-11-01T00:00:${start}Z`,
    completed_at: `2026-11-01T00:00:${end}Z`,
  };
}

function job(overrides = {}) {
  return {
    id: 1,
    name: "vitest (shard 1/4)",
    labels: ["ubuntu-24.04"],
    conclusion: "success",
    created_at: "2026-11-01T00:00:00Z",
    started_at: "2026-11-01T00:00:10Z",
    completed_at: "2026-11-01T00:00:59Z",
    steps: [
      step("Set up job", "10", "12"),
      step("Run actions/checkout@v4", "12", "15"),
      step("Run pnpm install --frozen-lockfile", "15", "25"),
      step("Run pnpm exec vitest run --shard=1/4", "25", "55"),
      step("Post Run actions/checkout@v4", "55", "57"),
      step("Complete job", "57", "58"),
    ],
    ...overrides,
  };
}

describe("percentile", () => {
  it("uses nearest rank and returns null for no data", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
    expect(percentile([7], 95)).toBe(7);
  });
});

describe("splitJob", () => {
  it("splits a job into waiting, setup, running and teardown", () => {
    expect(splitJob(job())).toMatchObject({
      waiting: 10,
      setup: 15,
      running: 30,
      teardown: 3,
      ranWork: true,
      os: "Linux",
    });
  });

  it("marks a job whose work steps were all skipped", () => {
    const skipped = job({
      conclusion: "failure",
      steps: [
        step("Set up job", "10", "12"),
        step("Prepare Electron test runtime", "12", "40", "failure"),
        step("Broker and Electron unit tests", "40", "40", "skipped"),
        step("Complete job", "40", "41"),
      ],
    });
    expect(splitJob(skipped)).toMatchObject({
      setup: 30,
      running: 0,
      ranWork: false,
      failedInSetup: true,
    });
  });
});

describe("runnerOs", () => {
  it("names the operating system from labels", () => {
    expect(runnerOs(["windows-2025"])).toBe("Windows");
    expect(runnerOs(["macos-15"])).toBe("macOS");
    expect(runnerOs(["ubuntu-24.04"])).toBe("Linux");
    expect(runnerOs([])).toBe("unknown");
  });
});

describe("report", () => {
  function write(dir) {
    fs.writeFileSync(
      path.join(dir, "runs.json"),
      JSON.stringify([
        { id: 10, event: "push", conclusion: "success", created_at: "2026-11-01T00:00:00Z" },
        {
          id: 11,
          event: "pull_request",
          conclusion: "failure",
          created_at: "2026-11-01T00:00:00Z",
        },
      ]),
    );
    fs.writeFileSync(path.join(dir, "10.json"), JSON.stringify({ total_count: 1, jobs: [job()] }));
    fs.writeFileSync(
      path.join(dir, "11.json"),
      JSON.stringify({
        total_count: 1,
        jobs: [
          job({
            id: 2,
            conclusion: "failure",
            steps: [
              step("Set up job", "10", "12"),
              step("Run pnpm install --frozen-lockfile", "12", "20", "failure"),
              step("Complete job", "20", "21"),
            ],
          }),
        ],
      }),
    );
    fs.writeFileSync(path.join(dir, "12.json"), JSON.stringify({ total_count: 0, jobs: [] }));
  }

  it("reads one file per run and tables conclusions, wall time and buckets with sample sizes", () => {
    const dir = folder();
    write(dir);
    const runs = loadRuns(dir);
    expect(runs.map((run) => run.id)).toEqual(["10", "11", "12"]);
    const { runRows } = analyze(runs);
    expect(runRows.find((run) => run.id === "10")).toMatchObject({
      event: "push",
      os: "Linux",
      wall: 59,
    });
    const text = renderReport(analyze(runs));
    expect(text).toContain("3 runs read, 2 with job data, 1 without.");
    expect(text).toContain("| pull_request | failure | 1 |");
    expect(text).toContain("| vitest (shard 1/4) | Run pnpm install --frozen-lockfile | 1 |");
    expect(text).toContain("| event | push | 1 | 59 | 59 |");
    expect(text).toContain(
      "| Linux | vitest (shard 1/4) | 2 | 10 / 10 | 2 | 10 / 15 | 1 | 30 / 30 | 1 | 1 | 1 / 3 |",
    );
  });

  it("prints from the command line", () => {
    const dir = folder();
    write(dir);
    const run = spawnSync(process.execPath, ["scripts/ci-audit.mjs", dir], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("## Buckets per job (seconds)");
    expect(spawnSync(process.execPath, ["scripts/ci-audit.mjs"], { encoding: "utf8" }).status).toBe(
      2,
    );
  });
});

describe("test durations from logs", () => {
  const log = [
    "﻿2026-11-04T05:27:08.0Z noise",
    "2026-11-04T05:29:34.6Z  \u001b[32m✓\u001b[39m scripts/testing/thinking-timer-ui.e2e.test.ts \u001b[2m(\u001b[22m\u001b[2m2 tests\u001b[22m\u001b[2m)\u001b[22m\u001b[33m 47114\u001b[2mms\u001b[22m\u001b[39m",
    "2026-11-04T05:29:35.0Z      \u001b[2m✓\u001b[22m a test inside the file \u001b[33m 23856\u001b[2mms\u001b[22m",
    "2026-11-04T05:30:00.0Z  ✓ src/fast.test.ts (4 tests)",
  ].join("\n");

  it("reads file lines and ignores the tests inside them", () => {
    expect(parseTestDurations(log)).toEqual([
      { file: "scripts/testing/thinking-timer-ui.e2e.test.ts", tests: 2, ms: 47114 },
      { file: "src/fast.test.ts", tests: 4, ms: null },
    ]);
  });

  it("ranks files per runner OS by job id", () => {
    const dir = folder();
    const logs = folder();
    fs.writeFileSync(path.join(dir, "10.json"), JSON.stringify({ jobs: [job({ id: 77 })] }));
    fs.writeFileSync(path.join(logs, "77.log"), log);
    const result = analyzeLogs(loadRuns(dir), logs);
    expect(result.logsRead).toBe(1);
    expect(renderLogReport(result)).toContain(
      "| scripts/testing/thinking-timer-ui.e2e.test.ts | 1 | 47.1 | 47.1 |",
    );
  });
});

describe("current hosted measurements", () => {
  it("counts the composite preparation action as setup", () => {
    expect(
      splitJob(
        job({
          steps: [
            step("Set up job", "10", "12"),
            step("Run ./.github/actions/prepare", "12", "44"),
            step("Lint", "44", "55"),
          ],
        }),
      ),
    ).toMatchObject({ setup: 34, running: 11 });
  });

  it("does not report a runner that never executed as zero-second setup", () => {
    const empty = job({ runner_id: 0, conclusion: "failure", steps: [] });
    expect(splitJob(empty)).toMatchObject({
      waiting: null,
      setup: null,
      running: null,
      teardown: null,
      ranWork: false,
    });
    const text = renderReport(
      analyze([
        { id: "empty", jobs: [empty], meta: { event: "pull_request", conclusion: "failure" } },
      ]),
    );
    expect(text).toContain("| Linux | setup | 0 | - | - |");
  });

  it("keeps unfinished runs out of completed wall-time samples", () => {
    const { runRows } = analyze([
      {
        id: "live",
        jobs: [job()],
        meta: { status: "in_progress", event: "pull_request", conclusion: null },
      },
    ]);
    expect(runRows[0]).toMatchObject({ conclusion: "in_progress", wall: null });
  });

  it("does not infer success from timeout or unstarted jobs", () => {
    const result = analyze([
      { id: "timeout", jobs: [job({ conclusion: "timed_out" })] },
      { id: "queued", jobs: [job({ conclusion: null, status: "queued", steps: [] })] },
      { id: "missing", jobs: [job({ conclusion: undefined, steps: [] })] },
      { id: "skip", jobs: [job({ conclusion: "skipped", steps: [] })] },
    ]).runRows;
    expect(result.map((row) => row.conclusion)).toEqual([
      "timed_out",
      "in_progress",
      "in_progress",
      "skipped",
    ]);
  });

  it("records an Install failure as setup rather than executed checks", () => {
    expect(
      splitJob(
        job({
          steps: [
            step("Install", "10", "30", "failure"),
            step("Full tests", "30", "30", "skipped"),
          ],
        }),
      ),
    ).toMatchObject({ setup: 20, running: 0, failedInSetup: true, ranWork: false });
  });

  it("retains listed runs with no downloaded job data", () => {
    const dir = folder();
    fs.writeFileSync(
      path.join(dir, "runs.json"),
      JSON.stringify([{ id: 99, event: "pull_request", conclusion: "failure" }]),
    );
    expect(loadRuns(dir)).toEqual([
      { id: "99", jobs: [], meta: { id: 99, event: "pull_request", conclusion: "failure" } },
    ]);
  });

  it("reports completed successful work separately by workflow", () => {
    const text = renderReport(
      analyze([
        {
          id: "good",
          jobs: [job()],
          meta: { name: "Checks", event: "pull_request", conclusion: "success" },
        },
        {
          id: "bad",
          jobs: [job()],
          meta: { name: "Checks", event: "pull_request", conclusion: "failure" },
        },
        {
          id: "inconsistent",
          jobs: [job({ conclusion: "failure" })],
          meta: { name: "Checks", event: "pull_request", conclusion: "success" },
        },
        {
          id: "empty",
          jobs: [job({ steps: [] })],
          meta: { name: "Checks", event: "pull_request", conclusion: "success" },
        },
      ]),
    );
    expect(text).toContain("## Successful runs that executed work");
    expect(text).toContain("| Checks | pull_request | 1 | 59 | 59 |");
  });
});
