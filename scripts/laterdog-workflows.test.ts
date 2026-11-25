import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);

type Step = {
  uses?: string;
  run?: string;
  if?: unknown;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
  "continue-on-error"?: unknown;
};
type Job = {
  "runs-on"?: unknown;
  if?: unknown;
  needs?: unknown;
  steps?: Step[];
  "continue-on-error"?: unknown;
  permissions?: unknown;
};
type Workflow = {
  on?: unknown;
  permissions?: unknown;
  concurrency?: { group?: string; "cancel-in-progress"?: unknown };
  jobs?: Record<string, Job>;
};

const ALLOWED_WORKFLOWS = ["pr.yml", "seed.yml"];
const ALLOWED_ACTIONS = ["prepare"];
const workflowDir = new URL(".github/workflows/", root);
const actionDir = new URL(".github/actions/", root);

const read = (url: URL) => readFileSync(url, "utf8");
const workflows = () =>
  ALLOWED_WORKFLOWS.map((file) => ({
    file,
    text: read(new URL(file, workflowDir)),
    data: parse(read(new URL(file, workflowDir))) as Workflow,
  }));
const actionFiles = () =>
  ALLOWED_ACTIONS.map((name) => ({
    file: `actions/${name}/action.yml`,
    text: read(new URL(`${name}/action.yml`, actionDir)),
    data: parse(read(new URL(`${name}/action.yml`, actionDir))) as { runs: { steps: Step[] } },
  }));
const allSteps = (): Step[] => [
  ...workflows().flatMap(({ data }) =>
    Object.values(data.jobs ?? {}).flatMap((job) => job.steps ?? []),
  ),
  ...actionFiles().flatMap(({ data }) => data.runs.steps),
];
const triggers = (data: Workflow) =>
  Object.keys(
    typeof data.on === "string" ? { [data.on]: null } : (data.on as Record<string, unknown>),
  );

describe("later.dog's hosted checks run on free standard runners and release stays on Jacob's Mac", () => {
  it("allows exactly the pull request checks, the cache seeder and the prepare action", () => {
    expect(readdirSync(workflowDir).sort()).toEqual(ALLOWED_WORKFLOWS);
    expect(readdirSync(actionDir).sort()).toEqual(ALLOWED_ACTIONS);
    expect(readdirSync(new URL("prepare/", actionDir)).sort()).toEqual(["action.yml"]);
  });

  it("runs every job on ubuntu-latest and nothing else", () => {
    const runners = workflows().flatMap(({ data }) =>
      Object.values(data.jobs ?? {}).map((job) => job["runs-on"]),
    );
    expect(runners.length).toBeGreaterThan(0);
    expect(new Set(runners)).toEqual(new Set(["ubuntu-latest"]));
  });

  it("triggers only on pull_request, and on push to main for the seeder", () => {
    const [pr, seed] = workflows();
    expect(triggers(pr.data)).toEqual(["pull_request"]);
    expect(triggers(seed.data)).toEqual(["push"]);
    expect((seed.data.on as { push: { branches: string[] } }).push.branches).toEqual(["main"]);
    for (const { text } of workflows()) expect(text).not.toContain("pull_request_target");
  });

  it("grants read-only contents, with timing reads only in the final job", () => {
    for (const { file, data } of workflows()) {
      expect(data.permissions).toEqual({ contents: "read" });
      for (const [name, job] of Object.entries(data.jobs ?? {})) {
        if (file === "pr.yml" && name === "CI")
          expect(job.permissions).toEqual({ contents: "read", actions: "read" });
        else expect(job.permissions).toBeUndefined();
      }
    }
  });

  it("uses no secrets and exposes a read token only to the timing inspector", () => {
    for (const { text } of [...workflows(), ...actionFiles()]) {
      expect(text).not.toMatch(/\bsecrets\b|GITHUB_TOKEN/);
      expect(text.match(/github\.token/g) ?? []).toHaveLength(
        text.includes("node scripts/ci-budgets.mjs") ? 1 : 0,
      );
    }
    for (const step of allSteps()) {
      if (step.run === "node scripts/ci-budgets.mjs")
        expect(step.env).toEqual({
          GH_TOKEN: "${{ github.token }}",
          NEEDS: "${{ toJSON(needs) }}",
        });
      else expect(JSON.stringify(step.env ?? {})).not.toMatch(/GH_TOKEN|github\.token/);
    }
  });

  it("hides no failure: no continue-on-error, no retry wrapper, none of the gate's gap variables", () => {
    for (const { text } of [...workflows(), ...actionFiles()]) {
      expect(text).not.toMatch(/continue-on-error/);
      expect(text).not.toMatch(
        /retry|nick-fields|attempt_limit|max_attempts|max-attempts|rerun|--retries|\|\| true/i,
      );
      for (const name of [
        "LATERDOG_GATE_OFFLINE",
        "LATERDOG_GATE_NO_BROWSER",
        "LATERDOG_GATE_UNAVAILABLE",
      ])
        expect(text).not.toContain(name);
    }
  });

  it("pins every action to a full commit hash, or to this repository's own prepare action", () => {
    const uses = allSteps().flatMap((step) => (step.uses ? [step.uses] : []));
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      if (reference.startsWith("./")) expect(reference).toBe("./.github/actions/prepare");
      else expect(reference).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it("checks out a blobless clone of the whole history, never a shallow one", () => {
    const checkouts = allSteps().filter((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.with?.filter).toBe("blob:none");
      expect(step.with?.["fetch-depth"]).toBe(0);
    }
  });

  it("groups pull request runs as pr-<number> and cancels superseded ones, never by github.ref", () => {
    const { data } = workflows()[0];
    expect(data.concurrency?.group).toMatch(/-pr-\$\{\{ github\.event\.pull_request\.number \}\}$/);
    expect(data.concurrency?.["cancel-in-progress"]).toBe(true);
    for (const { data: workflow } of workflows())
      expect(workflow.concurrency?.group).not.toContain("github.ref");
  });

  it("ends the pull request checks in one job named CI that needs every other job", () => {
    const { data } = workflows()[0];
    const jobs = data.jobs ?? {};
    const needs = (jobs.CI as unknown as { needs: string[] }).needs;
    expect([...needs].sort()).toEqual(
      Object.keys(jobs)
        .filter((name) => name !== "CI")
        .sort(),
    );
  });

  it("runs the selection, verdict and workflow contracts even when runtime checks are omitted", () => {
    const { data } = workflows()[0];
    const lint = data.jobs?.lint;
    expect(lint).toBeDefined();
    expect(lint?.if).toBeUndefined();
    expect(lint?.needs).toBeUndefined();
    for (const file of [
      "scripts/ci-scope.test.ts",
      "scripts/ci-verdict.test.ts",
      "scripts/laterdog-workflows.test.ts",
      "scripts/ci-budgets.test.ts",
    ]) {
      const steps = lint?.steps?.filter(
        (step) =>
          step.run?.startsWith("pnpm exec vitest run ") && step.run.split(/\s+/).includes(file),
      );
      expect(steps).toHaveLength(1);
      expect(steps?.[0].if).toBeUndefined();
    }
  });

  it("blocks the final verdict on time budgets and still collects every job result", () => {
    const job = workflows()[0].data.jobs?.CI;
    expect(job?.if).toBe("always()");
    const steps = job?.steps ?? [];
    const budget = steps.find((step) => step.run === "node scripts/ci-budgets.mjs");
    const verdict = steps.find((step) => step.run === "node scripts/ci-verdict.mjs");
    expect(budget).toBeDefined();
    expect(budget?.if).toBe("always()");
    expect(verdict?.if).toBe("always()");
    expect(steps.indexOf(budget!)).toBeLessThan(steps.indexOf(verdict!));
    expect(budget?.["continue-on-error"]).toBeUndefined();
    expect(job?.permissions).toEqual({ contents: "read", actions: "read" });
    expect(
      workflows()[0].data.jobs?.lint?.steps?.some((step) =>
        step.run?.split(/\s+/).includes("scripts/ci-budgets.test.ts"),
      ),
    ).toBe(true);
  });

  it("uses the public full-graph typecheck command in hosted CI", () => {
    const job = workflows()[0].data.jobs?.typecheck;
    expect(job?.if).toBeUndefined();
    expect(job?.needs).toBeUndefined();
    expect(job?.steps?.filter((step) => step.run).map((step) => step.run)).toEqual([
      "pnpm typecheck",
    ]);
  });

  it("keeps the cache written by the seeder and by misses only, keyed on the lockfiles", () => {
    const [, seed] = workflows();
    expect(JSON.stringify(seed.data.jobs)).toContain("./.github/actions/prepare");
    const [prepare] = actionFiles();
    const text = prepare.text;
    for (const part of [
      "RUNNER_OS",
      "RUNNER_ARCH",
      ".nvmrc",
      "packageManager",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "deploy/laterdog/home/pnpm-lock.yaml",
      "deploy/laterdog/computers/pnpm-lock.yaml",
    ])
      expect(text).toContain(part);
    expect(text).toContain("pnpm install --frozen-lockfile --offline");
    const save = prepare.data.runs.steps.find((step) =>
      step.uses?.startsWith("actions/cache/save@"),
    ) as (Step & { if?: string }) | undefined;
    expect(save?.if).toBe("steps.restore.outputs.cache-hit != 'true'");
  });

  it("ships the desktop release from an executable Mac script that notarizes before publishing", () => {
    const script = new URL("scripts/laterdog-release-mac.sh", root);
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const text = readFileSync(script, "utf8");
    const notarized = text.indexOf('xcrun stapler staple "$DMG"');
    const published = text.indexOf("gh release create");
    expect(notarized).toBeGreaterThan(0);
    expect(published).toBeGreaterThan(notarized);
    expect(text).toContain("refusing to replace its binaries");
    expect(text).toContain("scripts/laterdog-release-files.mjs");
  });

  it("refuses to release an app without its dictation helper, before anything is notarized", () => {
    const text = readFileSync(new URL("scripts/laterdog-release-mac.sh", root), "utf8");
    const refused = text.indexOf("Refusing to release without dictation");
    expect(refused).toBeGreaterThan(
      text.indexOf("later.dog Speech.app/Contents/MacOS/speech-helper"),
    );
    expect(text.indexOf("== Notarize and staple the app")).toBeGreaterThan(refused);
  });

  it("compares the stapled app's files with the previous release before the disk image is built, and publishes its own list", () => {
    const text = readFileSync(new URL("scripts/laterdog-release-mac.sh", root), "utf8");
    const compared = text.indexOf("node scripts/release-file-list.mjs");
    expect(compared).toBeGreaterThan(text.indexOf('xcrun stapler staple "$APP"'));
    expect(text.indexOf("== Build, sign, notarize and staple the disk image")).toBeGreaterThan(
      compared,
    );
    expect(text).toMatch(/assets=\([^)]*out\/later\.dog-macOS-arm64-files\.txt/);
  });

  it("points the release doc at the Mac script, not a workflow", () => {
    const doc = readFileSync(new URL("docs/laterdog/releasing.md", root), "utf8");
    expect(doc).toContain("scripts/laterdog-release-mac.sh");
    expect(doc).not.toContain("gh workflow run");
  });
});
