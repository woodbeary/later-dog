import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const RELEASE_EVENTS = new Set(["push", "merge_group", "workflow_dispatch"]);
export function requiredReleaseJobs(workflow) {
  return Object.entries(workflow.jobs).flatMap(([id, job]) => {
    const name = job.name ?? id;
    const shards = job.strategy?.matrix?.shard;
    if (job.strategy && (!Array.isArray(shards) || Object.keys(job.strategy.matrix).some(key => key !== "shard"))) throw new Error(`Unsupported release CI matrix: ${id}`);
    const names = shards ? shards.map(shard => name.replace(/\$\{\{\s*matrix\.shard\s*\}\}/g, String(shard))) : [name];
    if (names.some(value => value.includes("${{"))) throw new Error(`Unresolved release CI name: ${id}`);
    return names;
  });
}
export const REQUIRED_RELEASE_JOBS = requiredReleaseJobs(parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
export const POLL_MS = 60_000;
export const MAX_WAIT_MS = 170 * 60_000;

export async function waitForReleaseCi({ api, sha, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, log = console.log, maxWaitMs = MAX_WAIT_MS }) {
  const started = now();
  while (now() - started < maxWaitMs) {
    const run = (await api.runsForCommit(sha)).filter(run => RELEASE_EVENTS.has(run.event) && run.head_sha === sha)
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0];
    if (!run) return { ok: false, reason: `No source-commit CI run exists for ${sha}. Push this commit to a CI branch before promotion.` };
    if (run.status === "completed") {
      if (run.conclusion !== "success") return { ok: false, reason: `Source-commit CI did not succeed (${run.conclusion ?? "missing conclusion"}): run ${run.id}` };
      const gate = await api.gateConclusion(run.id);
      if (gate !== "success") return { ok: false, reason: `CI did not pass every required job (${gate ?? "missing jobs"}): run ${run.id}` };
      log(`CI passed on ${sha} (run ${run.id}).`);
      return { ok: true, runId: run.id };
    }
    log(`CI run ${run.id} on ${sha} is ${run.status}; waiting.`);
    await sleep(POLL_MS);
  }
  return { ok: false, reason: `No CI verdict on ${sha} within ${Math.round(maxWaitMs / 60_000)} minutes.` };
}

export function githubApi({ token, repository, apiUrl = "https://api.github.com", fetchImpl = fetch,
  retryDelaysMs = [5_000, 15_000, 45_000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const call = async (method, path, body) => {
    for (let attempt = 0; ; attempt++) {
      let response;
      try {
        response = await fetchImpl(`${apiUrl}/repos/${repository}${path}`, {
          method,
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (cause) {
        if (attempt < retryDelaysMs.length) { await sleep(retryDelaysMs[attempt]); continue; }
        throw new Error(`${method} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      if (response.status >= 500 && attempt < retryDelaysMs.length) { await sleep(retryDelaysMs[attempt]); continue; }
      if (!response.ok) {
        const error = new Error(`${method} ${path}: HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      return response.status === 204 ? null : response.json();
    }
  };
  return {
    async runsForCommit(sha) {
      return (await call("GET", `/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`)).workflow_runs;
    },
    async gateConclusion(runId) {
      const { jobs } = await call("GET", `/actions/runs/${runId}/jobs?per_page=100`);
      for (const name of REQUIRED_RELEASE_JOBS) {
        const job = jobs.find(job => job.name === name);
        if (!job) return `missing ${name}`;
        if (job.conclusion !== "success") return job.conclusion ?? "in_progress";
      }
      return "success";
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { GH_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, SHA, VERSION } = process.env;
  if (!GH_TOKEN || !GITHUB_REPOSITORY || !/^[0-9a-f]{40}$/.test(SHA ?? "") || !/^\d+\.\d+\.\d+$/.test(VERSION ?? "")) {
    console.error("::error::release-ci needs GH_TOKEN, GITHUB_REPOSITORY, a full SHA and an X.Y.Z VERSION");
    process.exit(1);
  }
  const result = await waitForReleaseCi({
    api: githubApi({ token: GH_TOKEN, repository: GITHUB_REPOSITORY, apiUrl: GITHUB_API_URL }),
    sha: SHA, version: VERSION,
  });
  if (!result.ok) {
    console.error(`::error::${result.reason}. Fix main or re-run CI, then re-run this job.`);
    process.exit(1);
  }
}
