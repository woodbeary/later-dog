#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SETUP_STEP =
  /^(Set up job|Run actions\/(checkout|setup-node|cache|download-artifact)|Run pnpm\/action-setup|Run pnpm install|Run \.\/\.github\/actions\/prepare(?:$|@)|Install$|Install what the desktop fixture runs on$|Prepare .*runtime|Let Chrome use its sandbox)/i;
const TEARDOWN_STEP = /^(Post Run |Complete job)/i;
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const TEST_FILE_LINE =
  /^\S+Z\s+[✓×❯↓]\s+(\S+\.(?:test|spec)\.\S+)\s+\((\d+) tests?[^)]*\)(?:\s+(\d+)ms)?/;

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function seconds(from, to) {
  if (!from || !to) return null;
  const value = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function runnerOs(labels = []) {
  const joined = labels.join(',').toLowerCase();
  if (joined.includes('windows')) return 'Windows';
  if (joined.includes('macos')) return 'macOS';
  if (joined.includes('ubuntu') || joined.includes('linux')) return 'Linux';
  return 'unknown';
}

export function splitJob(job) {
  const measured = (job.steps ?? []).some((step) => ["success", "failure", "cancelled"].includes(step.conclusion));
  const waiting = measured ? seconds(job.created_at, job.started_at) : null;
  let setup = 0;
  let running = 0;
  let teardown = 0;
  let ranWork = false;
  let failedInSetup = false;
  let failedStep = null;
  for (const step of job.steps ?? []) {
    const duration = seconds(step.started_at, step.completed_at) ?? 0;
    if (step.conclusion === 'failure' && failedStep === null) failedStep = step.name;
    if (TEARDOWN_STEP.test(step.name)) teardown += duration;
    else if (SETUP_STEP.test(step.name)) {
      setup += duration;
      if (step.conclusion === 'failure') failedInSetup = true;
    } else {
      running += duration;
      if (step.conclusion === 'success' || step.conclusion === 'failure') ranWork = true;
    }
  }
  return {
    name: job.name,
    os: runnerOs(job.labels),
    conclusion: job.conclusion,
    waiting,
    setup: measured ? setup : null,
    running: measured ? running : null,
    teardown: measured ? teardown : null,
    ranWork,
    failedInSetup,
    failedStep,
  };
}

function deriveConclusion(jobs) {
  const conclusions = jobs.map((job) => job.conclusion);
  if (conclusions.includes('failure')) return 'failure';
  const incomplete = conclusions.findIndex((value) => !['success', 'skipped'].includes(value));
  if (incomplete >= 0) return conclusions[incomplete] || 'in_progress';
  return conclusions.every((value) => value === 'skipped') ? 'skipped' : 'success';
}

export function loadRuns(dir) {
  const metaPath = path.join(dir, 'runs.json');
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : [];
  const metaById = new Map(meta.map((run) => [String(run.id), run]));
  const runs = new Map(meta.map((run) => [String(run.id), { id: String(run.id), jobs: [], meta: run }]));
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || file === 'runs.json') continue;
    const id = file.slice(0, -'.json'.length);
    const body = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    const jobs = Array.isArray(body) ? body : (body.jobs ?? []);
    runs.set(id, { id, jobs, meta: metaById.get(id) ?? null });
  }
  return [...runs.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function analyze(runs) {
  const jobRows = [];
  const runRows = [];
  for (const run of runs) {
    const jobs = run.jobs.map((job) => ({ job, split: splitJob(job) }));
    for (const { split } of jobs) jobRows.push({ runId: run.id, ...split });
    const oses = [...new Set(jobs.map(({ split }) => split.os))];
    const created = run.meta?.run_started_at ?? run.meta?.created_at ?? run.jobs.map((job) => job.created_at).sort()[0];
    const finished = run.jobs
      .map((job) => job.completed_at)
      .filter(Boolean)
      .sort()
      .at(-1);
    const active = (run.meta?.status && run.meta.status !== 'completed') || run.jobs.some((job) => ['queued', 'waiting', 'in_progress', 'pending'].includes(job.status));
    const conclusion = active ? 'in_progress' : run.meta?.conclusion || (jobs.length ? deriveConclusion(run.jobs) : 'unknown');
    runRows.push({
      id: run.id,
      workflow: run.meta?.name ?? run.meta?.workflowName ?? 'unknown',
      ranWork: jobs.some(({ split }) => split.ranWork),
      allJobsPassed: jobs.every(({ job }) => ['success', 'skipped'].includes(job.conclusion)),
      jobCount: jobs.length,
      event: run.meta?.event ?? 'unknown',
      conclusion,
      os: oses.length === 1 ? oses[0] : oses.length === 0 ? 'none' : 'mixed',
      wall: jobs.length && !active ? seconds(created, finished) : null,
    });
  }
  return { jobRows, runRows };
}

function stats(values) {
  const numbers = values.filter((value) => value !== null && value !== undefined);
  return { n: numbers.length, p50: percentile(numbers, 50), p95: percentile(numbers, 95) };
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return groups;
}

function fmt(value) {
  return value === null || value === undefined ? '-' : value.toFixed(0);
}

function minutes(value) {
  return value === null || value === undefined ? '-' : (value / 60).toFixed(1);
}

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

export function renderReport({ jobRows, runRows }) {
  const out = [];
  const withJobs = runRows.filter((run) => run.jobCount > 0);

  out.push(`## Runs`, '');
  out.push(
    `${runRows.length} runs read, ${withJobs.length} with job data, ${runRows.length - withJobs.length} without.`,
    '',
  );
  const conclusions = groupBy(runRows, (run) => run.conclusion);
  out.push(
    table(
      ['conclusion', 'runs'],
      [...conclusions.entries()].sort().map(([name, rows]) => [name, String(rows.length)]),
    ),
    '',
  );
  const byEvent = groupBy(runRows, (run) => `${run.event}|${run.conclusion}`);
  out.push(
    table(
      ['event', 'conclusion', 'runs'],
      [...byEvent.entries()].sort().map(([key, rows]) => [...key.split('|'), String(rows.length)]),
    ),
    '',
  );

  out.push(`## Run wall time (seconds, completed attempts including failures and cancellations; latest attempt start to last job completed)`, '');
  const wallRows = [];
  for (const [label, key] of [
    ['event', (run) => run.event],
    ['runner OS', (run) => run.os],
    ['all', () => 'all'],
  ]) {
    for (const [value, rows] of [...groupBy(withJobs, key).entries()].sort()) {
      const s = stats(rows.map((run) => run.wall));
      wallRows.push([label, value, String(s.n), fmt(s.p50), fmt(s.p95), minutes(s.p50), minutes(s.p95)]);
    }
  }
  out.push(table(['split', 'value', 'n runs', 'p50 s', 'p95 s', 'p50 min', 'p95 min'], wallRows), '');

  out.push('## Successful runs that executed work', '');
  out.push('Successful attempts with at least one completed work step. Runs with no job data, no executed work, or an unfinished attempt do not qualify. Groups with no successful sample are absent; absence does not meet a budget.', '');
  const successRows = [];
  for (const [key, rows] of [...groupBy(runRows.filter((row) => row.conclusion === 'success' && row.allJobsPassed && row.ranWork && row.wall !== null), (row) => `${row.workflow}|${row.event}`).entries()].sort()) {
    const s = stats(rows.map((row) => row.wall));
    successRows.push([...key.split('|'), String(s.n), fmt(s.p50), fmt(s.p95)]);
  }
  out.push(table(['workflow', 'event', 'n runs', 'p50 s', 'p95 s'], successRows), '');


  out.push(`## Buckets per job (seconds)`, '');
  out.push(
    `waiting: created to started; a job whose started time precedes its created time (a re-run keeps the earlier created time) is left out of that bucket. failed in setup: the job's own setup step failed. setup: set up, checkout, package manager, Node, install, the composite prepare action, runtime preparation. Jobs without any executed steps have no measured timing buckets. running: every other step, counted only for jobs that ran at least one work step. teardown (post steps, complete job) is listed for reconciliation.`,
    '',
  );
  const jobTable = [];
  for (const [name, rows] of [...groupBy(jobRows, (row) => `${row.os}|${row.name}`).entries()].sort()) {
    const [os, jobName] = name.split('|');
    const worked = rows.filter((row) => row.ranWork);
    const waiting = stats(rows.map((row) => row.waiting));
    const setup = stats(rows.map((row) => row.setup));
    const running = stats(worked.map((row) => row.running));
    const teardown = stats(rows.map((row) => row.teardown));
    jobTable.push([
      os,
      jobName,
      `${waiting.n}`,
      `${fmt(waiting.p50)} / ${fmt(waiting.p95)}`,
      `${setup.n}`,
      `${fmt(setup.p50)} / ${fmt(setup.p95)}`,
      `${running.n}`,
      `${fmt(running.p50)} / ${fmt(running.p95)}`,
      `${rows.length - worked.length}`,
      `${rows.filter((row) => row.failedInSetup).length}`,
      `${fmt(teardown.p50)} / ${fmt(teardown.p95)}`,
    ]);
  }
  out.push(
    table(
      [
        'OS',
        'job',
        'n wait',
        'waiting p50 / p95',
        'n setup',
        'setup p50 / p95',
        'n ran work',
        'running p50 / p95',
        'no work step ran',
        'failed in setup',
        'teardown p50 / p95',
      ],
      jobTable,
    ),
    '',
  );

  out.push(`## Buckets across all jobs (seconds)`, '');
  const allTable = [];
  for (const [os, rows] of [...groupBy(jobRows, (row) => row.os).entries()].sort()) {
    const worked = rows.filter((row) => row.ranWork);
    for (const [bucket, values] of [
      ['waiting', rows.map((row) => row.waiting)],
      ['setup', rows.map((row) => row.setup)],
      ['running (ran work)', worked.map((row) => row.running)],
    ]) {
      const s = stats(values);
      allTable.push([os, bucket, String(s.n), fmt(s.p50), fmt(s.p95)]);
    }
  }
  out.push(table(['OS', 'bucket', 'n jobs', 'p50 s', 'p95 s'], allTable), '');

  const failures = groupBy(
    jobRows.filter((row) => row.failedStep !== null),
    (row) => `${row.name}|${row.failedStep}`,
  );
  out.push(`## First failed step per failed job`, '');
  out.push(
    table(
      ['job', 'step', 'jobs'],
      [...failures.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([key, rows]) => [...key.split('|'), String(rows.length)]),
    ),
    '',
  );

  const totals = { waiting: 0, setup: 0, running: 0, teardown: 0 };
  for (const row of jobRows) {
    totals.waiting += row.waiting ?? 0;
    totals.setup += row.setup;
    totals.teardown += row.teardown;
    totals.running += row.running;
  }
  const sum = totals.waiting + totals.setup + totals.running + totals.teardown;
  out.push(`## Share of summed job time`, '');
  out.push(
    table(
      ['bucket', 'job-hours', 'share'],
      Object.entries(totals).map(([bucket, value]) => [
        bucket,
        (value / 3600).toFixed(1),
        sum ? `${((value / sum) * 100).toFixed(1)}%` : '-',
      ]),
    ),
    '',
  );
  return out.join('\n');
}

export function parseTestDurations(logText) {
  const files = [];
  for (const raw of logText.split('\n')) {
    const match = TEST_FILE_LINE.exec(raw.replace(ANSI, '').replace(/^﻿/, ''));
    if (match) files.push({ file: match[1], tests: Number(match[2]), ms: match[3] ? Number(match[3]) : null });
  }
  return files;
}

export function analyzeLogs(runs, logDir) {
  const jobById = new Map();
  for (const run of runs) for (const job of run.jobs) jobById.set(String(job.id), job);
  const perOs = new Map();
  let logsRead = 0;
  for (const file of fs.readdirSync(logDir).sort()) {
    const id = file.replace(/\.(log|txt)$/, '');
    const job = jobById.get(id);
    if (!job) continue;
    const os = runnerOs(job.labels);
    const parsed = parseTestDurations(fs.readFileSync(path.join(logDir, file), 'utf8'));
    logsRead += 1;
    if (!perOs.has(os)) perOs.set(os, new Map());
    const files = perOs.get(os);
    for (const entry of parsed) {
      if (entry.ms === null) continue;
      if (!files.has(entry.file)) files.set(entry.file, []);
      files.get(entry.file).push(entry.ms);
    }
  }
  return { logsRead, perOs };
}

export function renderLogReport({ logsRead, perOs }, top = 15) {
  const out = [`## Slowest test files (from ${logsRead} job logs)`, ''];
  out.push(
    `Only files Vitest printed a duration for are counted (it prints one above its slow-test threshold). n is the number of logs a file's duration appeared in.`,
    '',
  );
  for (const [os, files] of [...perOs.entries()].sort()) {
    const rows = [...files.entries()]
      .map(([file, values]) => ({ file, n: values.length, p50: percentile(values, 50), max: Math.max(...values) }))
      .sort((a, b) => b.p50 - a.p50)
      .slice(0, top);
    out.push(`### ${os}`, '');
    out.push(
      table(
        ['file', 'n logs', 'p50 s', 'max s'],
        rows.map((row) => [row.file, String(row.n), (row.p50 / 1000).toFixed(1), (row.max / 1000).toFixed(1)]),
      ),
      '',
    );
  }
  return out.join('\n');
}

export function main(argv) {
  const args = argv.slice(2);
  const logsFlag = args.indexOf('--logs');
  const logDir = logsFlag >= 0 ? args.splice(logsFlag, 2)[1] : null;
  const dir = args[0];
  if (!dir) {
    process.stderr.write('usage: node scripts/ci-audit.mjs <dir of run job files> [--logs <dir of job logs>]\n');
    return 2;
  }
  const runs = loadRuns(dir);
  process.stdout.write(`${renderReport(analyze(runs))}\n`);
  if (logDir) process.stdout.write(`${renderLogReport(analyzeLogs(runs, logDir))}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv);
}
