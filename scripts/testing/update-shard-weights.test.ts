import { describe, expect, it, vi } from "vitest";
import { planShards } from "./duration-sequencer.ts";
import * as updater from "./update-shard-weights.mjs";

function ghFor(jobs: { name: string; databaseId: number }[]) {
  return vi.fn((...args: string[]) =>
    args.includes("--json")
      ? JSON.stringify({ jobs })
      : `2026-11-25T05:00:00Z  ✓ server/job-${args.at(-1)?.match(/jobs\/(\d+)\/logs$/)?.[1]}.test.ts (1 test) 9000ms`,
  );
}

describe("hosted shard timings", () => {
  it("reads the current Linux suite jobs by default", () => {
    const jobs = Array.from({ length: 8 }, (_, index) => ({
      name: `suite ${index + 1}/8`,
      databaseId: index + 1,
    }));
    const gh = ghFor([
      ...jobs,
      { name: "lint", databaseId: 90 },
      { name: "vitest (windows-latest, shard 1/4)", databaseId: 91 },
    ]);
    const sample = updater.collectRun("45549371601", undefined, gh);
    expect([...sample.keys()]).toEqual(jobs.map((job) => `server/job-${job.databaseId}.test.ts`));
    expect(gh).toHaveBeenCalledTimes(9);
  });

  it("reads historical Linux vitest shards", () => {
    const gh = ghFor([
      { name: "vitest (shard 1/4)", databaseId: 1 },
      { name: "vitest (ubuntu-latest, shard 2/4)", databaseId: 2 },
      { name: "vitest (ubuntu-24.04, shard 3/4)", databaseId: 3 },
      { name: "vitest (windows-latest, shard 1/4)", databaseId: 90 },
    ]);
    expect([...updater.collectRun("123", "linux", gh).keys()]).toEqual([
      "server/job-1.test.ts",
      "server/job-2.test.ts",
      "server/job-3.test.ts",
    ]);
  });

  it("selects only Windows timings when requested", () => {
    const gh = ghFor([
      { name: "suite 1/8", databaseId: 90 },
      { name: "vitest (shard 1/4)", databaseId: 91 },
      { name: "vitest (windows-latest, shard 1/4)", databaseId: 1 },
      { name: "vitest (windows-2022, shard 2/4)", databaseId: 2 },
    ]);
    expect([...updater.collectRun("123", "windows", gh).keys()]).toEqual([
      "server/job-1.test.ts",
      "server/job-2.test.ts",
    ]);
  });

  it("refuses a run with no jobs for the requested platform", () => {
    expect(() =>
      updater.collectRun("123", "linux", ghFor([{ name: "lint", databaseId: 1 }])),
    ).toThrow("run 123 has no linux vitest jobs");
  });

  it("refuses a selected shard whose log contains no file timings", () => {
    const gh = vi.fn((...args: string[]) =>
      args.includes("--json")
        ? JSON.stringify({ jobs: [{ name: "suite 1/8", databaseId: 1 }] })
        : "2026-11-25T05:00:00Z Set up job",
    );
    expect(() => updater.collectRun("123", "linux", gh)).toThrow(
      "run 123 job suite 1/8 has no file timings",
    );
  });

  it("retains existing weights for files missing from a partial sample", () => {
    expect(
      updater.buildWeights(
        [new Map([["server/observed.test.ts", 8]])],
        (file: string) => file !== "server/gone.test.ts",
        {
          "server/unobserved.test.ts": 60,
          "server/observed.test.ts": 30,
          "server/gone.test.ts": 50,
        },
      ),
    ).toEqual({
      "server/observed.test.ts": 8,
      "server/unobserved.test.ts": 60,
    });
  });

  it("retains an existing weight when the file only reports a skip", () => {
    expect(
      updater.buildWeights([new Map([["server/skipped.e2e.test.ts", 0]])], () => true, {
        "server/skipped.e2e.test.ts": 40,
      }),
    ).toEqual({ "server/skipped.e2e.test.ts": 40 });
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, -1, undefined])(
    "leaves a new e2e file unweighted without a positive finite duration (%s)",
    (duration) => {
      const weights = updater.buildWeights(
        [new Map([["server/new.e2e.test.ts", duration]])],
        () => true,
      );
      expect(weights).toEqual({});
      expect(
        planShards(
          ["server/new.e2e.test.ts"],
          {
            "server/a.e2e.test.ts": 10,
            "server/b.e2e.test.ts": 30,
            ...weights,
          },
          1,
        ).loads,
      ).toEqual([20]);
    },
  );

  it("uses positive finite timings when a file also has unmeasured samples", () => {
    expect(
      updater.buildWeights(
        [
          new Map([["server/new.e2e.test.ts", 0]]),
          new Map([["server/new.e2e.test.ts", Number.NaN]]),
          new Map([["server/new.e2e.test.ts", 8]]),
        ],
        () => true,
      ),
    ).toEqual({ "server/new.e2e.test.ts": 8 });
  });

  it("replaces an old slow-file weight when measured runs are now light", () => {
    expect(
      updater.buildWeights([new Map([["server/light.test.ts", 2]])], () => true, {
        "server/light.test.ts": 40,
      }),
    ).toEqual({});
  });
});
