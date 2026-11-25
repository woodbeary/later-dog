import { pathToFileURL } from "node:url";

const POLICIES = [
  { group: "scope", match: /^scope$/, start: "Select docs-only or runtime checks", phases: [] },
  {
    group: "lint",
    match: /^lint$/,
    start: "Lint",
    phases: [
      ["Lint", 5],
      ["Check repository rules and hosted-check contracts", 60],
    ],
  },
  {
    group: "typecheck",
    match: /^typecheck$/,
    start: "Typecheck the app and the server",
    phases: [["Typecheck the app and the server", 5]],
  },
  {
    group: "build",
    match: /^build$/,
    start: "Build the interface",
    phases: [["Smoke the packaged server", 60]],
  },
  {
    group: "electron-broker",
    match: /^electron-broker$/,
    start: "Electron node tests",
    phases: [
      ["Electron node tests", 60],
      ["Broker tests", 60],
    ],
  },
  {
    group: "suite",
    match: /^suite (?:[1-8]|\$\{\{ matrix\.shard \}\})\/8$/,
    start: /^Main suite, shard [1-8] of 8$/,
    phases: [[/^Main suite, shard [1-8] of 8$/, 60]],
  },
  {
    group: "side",
    match:
      /^side (?:deploy\/laterdog\/(?:home|computers)|cloudflare\/control-plane|\$\{\{ matrix\.dir \}\})$/,
    start: /^Tests in /,
    phases: [[/^Tests in /, 60]],
  },
  {
    group: "interface",
    match: /^interface$/,
    start: "Drive the real renderer",
    phases: [["Drive the real renderer", 60]],
  },
  {
    group: "CI",
    match: /^CI$/,
    start: /^(Check time budgets|Judge every needed job)$/,
    phases: [],
  },
];
const STATIC = new Set(["scope", "lint", "typecheck", "CI"]);
const matches = (value, pattern) =>
  typeof pattern === "string" ? value === pattern : pattern.test(value);

function seconds(from, to) {
  if (typeof from !== "string" || typeof to !== "string") return null;
  const elapsed = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
}

function insideJob(step, job) {
  return (
    seconds(job.started_at, step.started_at) !== null &&
    seconds(step.started_at, step.completed_at) !== null &&
    seconds(step.completed_at, job.completed_at) !== null
  );
}

export function evaluateJobs(jobs, runtime, now = new Date().toISOString()) {
  const problems = [];
  const rows = [];
  const groups = new Map();
  const ids = new Set();
  const names = new Set();
  if (!Array.isArray(jobs) || !jobs.length)
    return { ok: false, rows, problems: ["No job timings were returned"] };
  if (typeof runtime !== "boolean")
    return { ok: false, rows, problems: ["The scope did not provide a runtime selection"] };
  for (const job of jobs) {
    if (!Number.isSafeInteger(job?.id) || job.id < 1 || ids.has(job.id))
      problems.push("Missing or duplicate job id");
    ids.add(job?.id);
    if (names.has(job?.name)) problems.push(`Duplicate job name: ${job?.name}`);
    names.add(job?.name);
    let policy = POLICIES.find((item) => item.match.test(job?.name));
    if (!policy) {
      problems.push(`Unknown job: ${job?.name}`);
      continue;
    }
    const members = groups.get(policy.group) ?? [];
    members.push(job);
    groups.set(policy.group, members);
    if (runtime && job.name.includes("${{"))
      problems.push(`${job.name}: runtime matrix member was not resolved`);
    if (job.conclusion === "skipped") {
      if (runtime || STATIC.has(policy.group))
        problems.push(`${job.name}: an expected job was skipped`);
      continue;
    }
    if (!runtime && !STATIC.has(policy.group))
      problems.push(`${job.name}: runtime work disagrees with the scope`);
    if (policy.group === "suite") {
      const start = `Main suite, shard ${job.name.split(" ")[1].split("/")[0]} of 8`;
      policy = { ...policy, start, phases: [[start, 60]] };
    } else if (policy.group === "side") {
      const start = `Tests in ${job.name.slice(5)}`;
      policy = { ...policy, start, phases: [[start, 60]] };
    }
    const current = policy.group === "CI" && job.status === "in_progress";
    if (!current && job.status !== "completed")
      problems.push(`${job.name}: job timings are incomplete`);
    if (!current && job.conclusion !== "success")
      problems.push(`${job.name}: ${job.conclusion ?? "no conclusion"}`);
    if (!current && seconds(job.started_at, job.completed_at) === null)
      problems.push(`${job.name}: job has no valid completion time`);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    let anchors = steps.filter((step) => matches(step.name, policy.start));
    if (policy.group === "CI" && anchors.some((step) => step.name === "Check time budgets"))
      anchors = anchors.filter((step) => step.name === "Check time budgets");
    if (anchors.length !== 1 && !(current && anchors.length === 0))
      problems.push(`${job.name}: expected exactly one first-work step`);
    const firstWork = anchors[0];
    const workStarted = firstWork?.started_at ?? (current ? now : null);
    if (
      firstWork &&
      !current &&
      (firstWork.status !== "completed" ||
        firstWork.conclusion !== "success" ||
        !insideJob(firstWork, job))
    )
      problems.push(`${job.name}: first-work step did not complete inside its job`);
    if (current && seconds(workStarted, now) === null)
      problems.push(`${job.name}: first-work time is in the future or invalid`);
    const row = {
      name: job.name,
      waiting: seconds(job.created_at, job.started_at),
      setup: seconds(job.started_at, workStarted),
      phases: [],
    };
    const check = (name, elapsed, limit) => {
      if (elapsed === null) problems.push(`${job.name}: ${name} has no valid timing`);
      else if (elapsed >= limit)
        problems.push(`${job.name}: ${name} ${elapsed.toFixed(3)}s exceeds the <${limit}s budget`);
    };
    check("waiting", row.waiting, 10);
    check("setup", row.setup, 30);
    for (const [pattern, limit] of policy.phases) {
      const selected = steps.filter((step) => matches(step.name, pattern));
      if (selected.length !== 1) {
        problems.push(`${job.name}: expected exactly one timed ${String(pattern)} step`);
        continue;
      }
      const step = selected[0];
      const elapsed = seconds(step.started_at, step.completed_at);
      if (step.status !== "completed" || step.conclusion !== "success")
        problems.push(`${job.name}: ${step.name} did not finish successfully`);
      if (!insideJob(step, job) || seconds(workStarted, step.started_at) === null)
        problems.push(`${job.name}: ${step.name} is outside its work interval`);
      check(step.name, elapsed, limit);
      row.phases.push({ name: step.name, seconds: elapsed, limit });
    }
    rows.push(row);
  }
  for (const policy of POLICIES) {
    const expected =
      !runtime || !["suite", "side"].includes(policy.group) ? 1 : policy.group === "suite" ? 8 : 3;
    const count = groups.get(policy.group)?.length ?? 0;
    if (count !== expected)
      problems.push(`${policy.group}: expected ${expected} jobs, got ${count}`);
    const required =
      runtime && policy.group === "suite"
        ? Array.from({ length: 8 }, (_, i) => `suite ${i + 1}/8`)
        : runtime && policy.group === "side"
          ? [
              "side deploy/laterdog/home",
              "side deploy/laterdog/computers",
              "side cloudflare/control-plane",
            ]
          : [];
    for (const name of required)
      if ((groups.get(policy.group) ?? []).filter((job) => job.name === name).length !== 1)
        problems.push(`${name}: expected exactly one matrix member`);
  }
  return { ok: problems.length === 0, rows, problems };
}

export async function loadJobs(env, fetcher = fetch) {
  const repository = env.GITHUB_REPOSITORY ?? "";
  if (
    !/^[a-z\d][a-z\d-]*\/[\w.-]+$/i.test(repository) ||
    [".", ".."].includes(repository.split("/")[1]) ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ||
    !env.GH_TOKEN
  )
    throw new Error("Missing workflow-run context or read token");
  const jobs = [];
  let total;
  for (let page = 1; page <= 100; page++) {
    const url = `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}/jobs?per_page=100&page=${page}`;
    const response = await fetcher(url, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`Job timings request failed: HTTP ${response.status}`);
    const body = await response.json();
    if (
      !Number.isSafeInteger(body.total_count) ||
      body.total_count < 1 ||
      !Array.isArray(body.jobs) ||
      body.jobs.length === 0 ||
      (total !== undefined && total !== body.total_count)
    )
      throw new Error("Incomplete job timing response");
    if (
      body.jobs.some(
        (job) =>
          !Number.isSafeInteger(job?.run_id) ||
          !Number.isSafeInteger(job?.run_attempt) ||
          String(job.run_id) !== env.GITHUB_RUN_ID ||
          String(job.run_attempt) !== env.GITHUB_RUN_ATTEMPT,
      )
    )
      throw new Error("Job timings belong to another run or attempt");
    total = body.total_count;
    jobs.push(...body.jobs);
    if (jobs.length === total) return jobs;
    if (jobs.length > total) throw new Error("Job count exceeds the reported total");
  }
  throw new Error("Job timing pagination did not finish");
}

export async function main(
  env,
  fetcher = fetch,
  write = (message) => {
    process.stdout.write(message);
  },
  now = new Date().toISOString(),
) {
  try {
    const needs = JSON.parse(env.NEEDS ?? "");
    const selected = needs?.scope?.outputs?.runtime;
    if (needs?.scope?.result !== "success" || !["true", "false"].includes(selected))
      throw new Error("The scope did not provide a successful runtime selection");
    const report = evaluateJobs(await loadJobs(env, fetcher), selected === "true", now);
    for (const row of report.rows)
      write(
        `${row.name}: wait=${row.waiting ?? "unknown"}s setup=${row.setup ?? "unknown"}s${row.phases.map((phase) => ` ${phase.name}=${phase.seconds ?? "unknown"}s`).join("")}\n`,
      );
    write(
      report.ok
        ? "CI time budgets passed\n"
        : `CI time budgets failed:\n${report.problems.map((problem) => `  ${problem}`).join("\n")}\n`,
    );
    return report.ok ? 0 : 1;
  } catch (error) {
    write(
      `CI time budgets could not be checked: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main(process.env);
