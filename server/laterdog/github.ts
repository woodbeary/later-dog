import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathInScopes, type Job, type Repository, type Verification } from "../../shared/laterdog.ts";
import { describeFailure, requireSuccess, runCommand, type CommandRunner } from "./command.ts";

interface GitHubRef { object: { sha: string } }
export interface PublishedResult { headSha: string; prUrl: string; prNumber: number; merged?: boolean }
export interface GitHubAccess { authenticated: boolean; source: "GH_TOKEN" | "gh-login"; login?: string; detail?: string }
const SHA = /^[a-f0-9]{40}$/;

export class GitHubPublisher {
  private readonly root: string;
  private readonly run: CommandRunner;
  constructor(root: string, run: CommandRunner = runCommand) { this.root = root; this.run = run; }
  private async gh(args: string[], input?: unknown) {
    return this.run("gh", args, { ...(input === undefined ? {} : { input: JSON.stringify(input) }), timeoutMs: 60_000 });
  }
  private async git(dir: string, args: string[]) {
    return requireSuccess(await this.run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd: dir, timeoutMs: 120_000 }), "Git operation");
  }
  /** Whether gh can act on GitHub from this host the way publishing will use it: `GH_TOKEN` when set, else gh's stored login. The credential itself is never read. */
  async access(): Promise<GitHubAccess> {
    const source: GitHubAccess["source"] = process.env.GH_TOKEN ? "GH_TOKEN" : "gh-login";
    try {
      const result = await this.run("gh", ["api", "user", "--jq", ".login"], { timeoutMs: 30_000 });
      const login = result.stdout.trim();
      // gh's own advice ("run gh auth login") is about the machine it runs on; on a hosted supervisor the fix is the secret.
      if (result.exitCode !== 0 || !login) {
        return { authenticated: false, source, detail: `No GitHub credential where the supervisor runs. Connect GitHub from the Workspace (or run pnpm laterdog:github) and authorize the code at github.com/login/device. ${describeFailure(result, "gh")}` };
      }
      return { authenticated: true, source, login };
    } catch (error) {
      return { authenticated: false, source, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  async prepare(job: Job, repo: Repository, parent?: Job): Promise<{ baseSha: string; sourceRef: string }> {
    const sourceRef = `laterdog/input/${job.id}`;
    const existing = await this.gh(["api", `repos/${repo.slug}/git/ref/heads/${sourceRef}`]);
    if (existing.exitCode === 0) {
      const ref = JSON.parse(existing.stdout) as GitHubRef;
      if (!SHA.test(ref.object.sha) || (job.baseSha && job.baseSha !== ref.object.sha)) throw new Error("Prepared source ref changed unexpectedly");
      return { baseSha: ref.object.sha, sourceRef };
    }
    if (!/404/.test(existing.stderr)) throw new Error("Could not inspect the immutable input branch");
    const baseRef = parent && (job.kind === "repair" || job.kind === "review") ? parent.outputBranch : repo.baseRef;
    const ref = JSON.parse(requireSuccess(await this.gh(["api", `repos/${repo.slug}/git/ref/heads/${baseRef}`]), "Read starting commit")) as GitHubRef;
    if (!SHA.test(ref.object.sha)) throw new Error("GitHub returned an invalid commit");
    if (job.kind === "review" && parent?.headSha !== ref.object.sha) throw new Error("Parent PR moved before review; inspect its current head first");
    requireSuccess(await this.gh(["api", "--method", "POST", `repos/${repo.slug}/git/refs`, "--input", "-"],
      { ref: `refs/heads/${sourceRef}`, sha: ref.object.sha }), "Create isolated input branch");
    return { baseSha: ref.object.sha, sourceRef };
  }
  async publish(job: Job, repo: Repository, patch: string, summary?: string): Promise<PublishedResult> {
    if (!repo.publish) throw new Error("PR publication is not enabled for this repository");
    if (!job.baseSha || !job.sourceRef) throw new Error("Job has no pinned starting commit");
    // git apply rejects a diff without its final newline as corrupt; artifacts collected before that was fixed lack it.
    if (patch.trim() && !patch.endsWith("\n")) patch = `${patch}\n`;
    const dir = join(this.root, job.id);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!existsSync(join(dir, ".git"))) {
      try {
        requireSuccess(await this.gh(["repo", "clone", repo.slug, dir, "--", "--no-checkout", "--filter=blob:none"]), "Clone publishing checkout");
        await this.git(dir, ["fetch", "origin", job.sourceRef]);
        if (await this.git(dir, ["rev-parse", "FETCH_HEAD"]) !== job.baseSha) throw new Error("Cloud input ref no longer matches the recorded starting commit");
        await this.git(dir, ["checkout", "-b", job.outputBranch, job.baseSha]);
      } catch (error) {
        // A half-built checkout would block every retry with "unstaged changes" or a missing branch; only a completed checkout is worth keeping.
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
    }
    let head = await this.git(dir, ["rev-parse", "HEAD"]);
    if (head === job.baseSha) {
      if (!patch.trim().startsWith("diff --git ")) throw new Error("The cloud result has no publishable Git diff");
      const patchPath = join(this.root, `${job.id}.patch`);
      writeFileSync(patchPath, patch, { mode: 0o600 });
      if (await this.git(dir,["diff","--name-only"])) throw new Error("Publishing checkout has unstaged changes; inspect before retrying");
      const staged = await this.git(dir,["diff","--cached","--name-only"]);
      if (staged) await this.git(dir,["apply","--reverse","--check","--index",patchPath]);
      else {
        await this.git(dir, ["apply", "--check", "--index", patchPath]);
        await this.git(dir, ["apply", "--index", patchPath]);
      }
      const paths = (await this.git(dir, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
      if (!paths.length || paths.some((path) => !pathInScopes(path, job.writeScopes))) throw new Error("Cloud changes exceed the declared write scopes; checkout retained for inspection");
      await this.git(dir, ["-c", "user.name=later.dog", "-c", "user.email=agent@later.dog", "commit", "-m", job.title]);
      head = await this.git(dir, ["rev-parse", "HEAD"]);
    } else {
      if (await this.git(dir, ["rev-parse", `${head}^`]) !== job.baseSha || await this.git(dir, ["status", "--porcelain"])) throw new Error("Interrupted publishing checkout needs inspection before reuse");
    }
    const prs = JSON.parse(requireSuccess(await this.gh(["pr", "list", "--repo", repo.slug, "--head", job.outputBranch, "--state", "all", "--json", "number,url,headRefOid,state"]), "Find existing PR")) as { number: number; url: string; headRefOid: string; state: string }[];
    const existing = prs[0];
    if (existing && existing.state !== "OPEN") {
      if (existing.state === "MERGED" && existing.headRefOid === head) return { headSha: head, prUrl: existing.url, prNumber: existing.number, merged: true };
      throw new Error("Output PR was closed or merged; create a new implementation job instead of changing its branch");
    }
    const remote = await this.git(dir, ["ls-remote", "--heads", "origin", `refs/heads/${job.outputBranch}`]);
    const previousHead = remote.split(/\s+/)[0];
    if (previousHead && previousHead !== head && previousHead !== job.baseSha) throw new Error("Output branch moved; refusing to overwrite another writer");
    await this.git(dir, ["push", "origin", `HEAD:refs/heads/${job.outputBranch}`]);
    if (existing) return { headSha: head, prUrl: existing.url, prNumber: existing.number };
    const body = `${summary ?? job.title}\n\nJob: ${job.id}\nWrite scopes: ${job.writeScopes.join(", ")}\nRequirements are retained in the private workspace.\n\nCreated by later.dog.\n\nCloud task: ${job.taskUrl ?? job.taskId}\nStarting commit: ${job.baseSha}\nVerification and independent review are tracked separately; this PR is not yet marked verified.`;
    const bodyPath = join(this.root, `${job.id}-pr.md`); writeFileSync(bodyPath, body, { mode: 0o600 });
    requireSuccess(await this.gh(["pr", "create", "--repo", repo.slug, "--head", job.outputBranch, "--base", repo.baseRef,
      "--title", job.title, "--body-file", bodyPath, "--draft"]), "Open draft PR");
    const created = JSON.parse(requireSuccess(await this.gh(["pr", "view", job.outputBranch, "--repo", repo.slug, "--json", "number,url,headRefOid"]), "Read published PR")) as { number: number; url: string; headRefOid: string };
    return { headSha: created.headRefOid, prUrl: created.url, prNumber: created.number };
  }
  async inspectPublished(job: Job): Promise<{ headSha: string; state: "OPEN" | "CLOSED" | "MERGED" }> {
    if (!job.prNumber) throw new Error("Publish a PR before verification");
    const pr = JSON.parse(requireSuccess(await this.gh(["pr", "view", String(job.prNumber), "--repo", job.repository, "--json", "headRefOid,state"]), "Read current PR commit")) as { headRefOid: string; state: "OPEN" | "CLOSED" | "MERGED" };
    if (!SHA.test(pr.headRefOid) || !["OPEN","CLOSED","MERGED"].includes(pr.state)) throw new Error("GitHub returned an invalid PR snapshot");
    return { headSha: pr.headRefOid, state: pr.state };
  }
  async currentHead(job: Job): Promise<string> { return (await this.inspectPublished(job)).headSha; }
  async verify(job: Job, repo: Repository, evidenceDir: string): Promise<Verification> {
    const headSha = await this.currentHead(job); const at = new Date().toISOString();
    mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    const evidence = join(evidenceDir, `${job.id}-${headSha}-verification.json`);
    let verdict: Verification["verdict"] = "blocked";
    const checks = JSON.parse(requireSuccess(await this.gh(["api", `repos/${repo.slug}/commits/${headSha}/check-runs?per_page=100`]), "Read check runs")) as { total_count?: number; check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[] };
    const statuses = JSON.parse(requireSuccess(await this.gh(["api", `repos/${repo.slug}/commits/${headSha}/status?per_page=100`]), "Read commit statuses")) as { total_count?: number; statuses: { context: string; state: string; target_url: string }[] };
    // Both APIs can truncate; incomplete evidence never qualifies a commit.
    const incomplete = (checks.total_count ?? checks.check_runs.length) > checks.check_runs.length || (statuses.total_count ?? statuses.statuses.length) > statuses.statuses.length;
    const latestStatuses = [...new Map(statuses.statuses.slice().reverse().map((status) => [status.context,status])).values()];
    const results: { command: string[]; exitCode: number; output: string }[] = [];
    const checkStates = [...checks.check_runs.map((c) => c.status !== "completed" ? "pending" : c.conclusion), ...latestStatuses.map((s) => s.state)];
    const acceptable = (state: string | null) => ["success","neutral","skipped"].includes(state ?? "");
    const behavioral = repo.behavioralChecks.length > 0 && repo.behavioralChecks.every(name => checks.check_runs.some(check => check.name === name && check.status === "completed" && check.conclusion === "success") || latestStatuses.some(status => status.context === name && status.state === "success"));
    if (behavioral && checkStates.every(acceptable)) verdict = "passed";
    if (checkStates.some((s) => ["failure", "cancelled", "timed_out", "action_required", "error"].includes(s ?? ""))) verdict = "failed";
    if (repo.verification.length) {
      const dir = join(this.root, `${job.id}-verify-${headSha}`);
      if (!existsSync(join(dir, ".git"))) requireSuccess(await this.gh(["repo", "clone", repo.slug, dir, "--", "--no-checkout"]), "Clone verification checkout");
      await this.git(dir, ["fetch", "origin", headSha]); await this.git(dir, ["checkout", "--detach", headSha]);
      let commandVerdict: Verification["verdict"] = "passed";
      for (const command of repo.verification) {
        const result = await this.run("docker", ["run", "--rm", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=256", "--memory=2g", "--cpus=2",
          "--mount", `type=bind,source=${dir},target=/workspace`, "--workdir", "/workspace", process.env.LATERDOG_VERIFY_IMAGE ?? "laterdog-verify:local", ...command], { timeoutMs: 600_000 });
        results.push({ command, exitCode: result.exitCode, output: `${result.stdout}\n${result.stderr}` });
        if (result.exitCode === 125 || result.timedOut) commandVerdict = "blocked";
        else if (result.exitCode !== 0) commandVerdict = "failed";
        if (commandVerdict !== "passed") break;
      }
      if (verdict !== "failed") verdict = checkStates.some((s) => !acceptable(s)) ? "blocked" : commandVerdict;
    }
    if (incomplete || await this.currentHead(job) !== headSha) verdict = "blocked";
    writeFileSync(evidence, JSON.stringify({ headSha, at, verdict, behavioralChecks: repo.behavioralChecks, coverage: repo.verification.length || behavioral ? "Configured behavioral recipe" : "No configured behavioral evidence; CI alone does not qualify a result", checks, statuses, results }, null, 2), { mode: 0o600 });
    return { headSha, at, verdict, commands: repo.verification, evidence };
  }
  async merge(job: Job): Promise<void> {
    if (!job.headSha || job.verification?.headSha !== job.headSha || job.verification.verdict !== "passed" || job.review?.headSha !== job.headSha || job.review.verdict !== "pass") throw new Error("Current-commit verification and independent review are required");
    if (await this.currentHead(job) !== job.headSha) throw new Error("PR head changed; rerun verification and review");
    requireSuccess(await this.gh(["pr", "ready", String(job.prNumber), "--repo", job.repository]), "Mark PR ready");
    requireSuccess(await this.gh(["pr", "merge", String(job.prNumber), "--repo", job.repository, "--squash", "--match-head-commit", job.headSha]), "Merge PR under repository protections");
  }
}
