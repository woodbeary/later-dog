import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { repositorySchema, type Profile } from "../../shared/laterdog.ts";
import { configSchema } from "./config.ts";
import { SubmissionUnknown, type JobContext } from "./codex-cloud.ts";
import { GitHubPublisher } from "./github.ts";
import { WorkspaceStore } from "./store.ts";
import { Supervisor } from "./supervisor.ts";
import { AUTO_SETUP_SCRIPT, SETUP_FAILED_NOTE } from "./cloud-task-files.ts";
import { StateTraceStore, jobTraceStoreFromEnv } from "./job-trace.ts";
import { FakeTraceState, slurp } from "./trace-state-fake.ts";
import {
  COMPUTER_PREFIX, ComputerSubmissionUnknown, claudeOptions, INTERNAL_COMPUTERS_API, LATERDOG_CLOUD_CAPABILITIES, LaterdogCloudAdapter, laterdogCloudSettings, shellQuote, taskScript,
} from "./laterdog-cloud.ts";

const CLAUDE_TOKEN = `sk-ant-oat01-fixture_claude_secret_${"x".repeat(80)}`;
const GITHUB_TOKEN = "ghp_fixtureGithubSecret0000";
const COMPUTERS_KEY = "ldc_fixtureComputersKey000";
const API = "https://computers.fixture.test/v1";
const SECRETS = [CLAUDE_TOKEN, GITHUB_TOKEN, COMPUTERS_KEY];
const profile: Profile = { id: "cloud", label: "later.dog Cloud", backend: "laterdog-cloud" };
const DEFAULT_CLAUDE = [
  'cat > "$HOME/task/prompt.seen"',
  'printf \'%s\\n\' "$@" > "$HOME/task/claude.args"',
  'printf \'oauth=%s gh=%s sandbox=%s traffic=%s\\n\' "${CLAUDE_CODE_OAUTH_TOKEN:+set}" "${GH_TOKEN:+set}" "${IS_SANDBOX:-}" "${CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:-}" > "$HOME/task/claude.env"',
  "mkdir -p src && printf 'new\\n' > src/a.ts",
  "echo '{\"type\":\"result\"}'",
].join("\n");

const STREAM_CLAUDE = [
  'cat > "$HOME/task/prompt.seen"',
  'if grep -q "keep running" "$HOME/task/prompt.seen"; then',
  `  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Still at it."}]}}'`,
  '  while [ -d "$HOME/task" ] && [ ! -f "$HOME/task/stop" ]; do sleep 0.1; done',
  "fi",
  "mkdir -p src && printf 'new\\n' > src/a.ts",
  `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Changing src/a.ts now."}]}}'`,
  `echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"'"$HOME"'/work/src/a.ts"}}]}}'`,
  `echo '{"type":"result","is_error":false,"result":"Changed it.","num_turns":2,"duration_ms":50}'`,
].join("\n");

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })); });

interface FakeComputer { id: string; name: string; size: string; state: string; error?: string; startingReads: number; home: string }
interface Recorded { method: string; url: string; headers: Record<string, string>; body: string }

function shim(dir: string, name: string, body: string) { const file = join(dir, name); writeFileSync(file, `#!/bin/bash\n${body}\n`); chmodSync(file, 0o755); }
const gitEnv = (root: string) => ({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: root, GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" });

class FakeComputersApi {
  readonly root: string;
  readonly bare: string;
  readonly baseSha: string;
  readonly computers = new Map<string, FakeComputer>();
  readonly idempotency = new Map<string, string>();
  readonly requests: Recorded[] = [];
  readonly execs: { command: string; env?: Record<string, string> }[] = [];
  key: string | undefined = COMPUTERS_KEY;
  envSupported = true;
  dropFirstCreateAnswer = false;
  startingReads = 2;
  maxExecStdout = 0;
  constructor(claude = DEFAULT_CLAUDE, options: { seed?: Record<string, string>; failing?: string[] } = {}) {
    this.root = mkdtempSync(join(tmpdir(), "laterdog-cloud-")); roots.push(this.root);
    const bin = join(this.root, "bin"); mkdirSync(bin);
    shim(bin, "node", `exec "${process.execPath}" "$@"`);
    for (const name of options.failing ?? []) shim(bin, name, `echo "$*" >> "$HOME/task/${name}.calls"\nexit 3`);
    shim(bin, "setsid", '[ "$1" = "-f" ] && shift\n"$@" &');
    shim(bin, "timeout", 'while [ "${1#-}" != "$1" ]; do shift; done\nshift\nexec "$@"');
    shim(bin, "claude", `exec bash "${join(this.root, "claude-behaviour.sh")}" "$@"`);
    writeFileSync(join(this.root, "claude-behaviour.sh"), `${claude}\n`);
    writeFileSync(join(this.root, "gitconfig"), `[url "file://${join(this.root, "remotes")}/"]\n\tinsteadOf = https://github.com/\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n`);
    this.bare = join(this.root, "remotes", "fixture", "repo.git"); mkdirSync(this.bare, { recursive: true });
    const seed = join(this.root, "seed"); mkdirSync(join(seed, "src"), { recursive: true });
    const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, env: gitEnv(this.root), encoding: "utf8" }).trim();
    git(this.bare, ["init", "-q", "--bare"]);
    git(seed, ["init", "-q"]); writeFileSync(join(seed, "src", "a.ts"), "old\n"); writeFileSync(join(seed, ".gitignore"), "node_modules\n");
    for (const [name, content] of Object.entries(options.seed ?? {})) writeFileSync(join(seed, name), content);
    git(seed, ["add", "-A"]); git(seed, ["commit", "-q", "-m", "seed"]); git(seed, ["push", "-q", this.bare, "HEAD:refs/heads/main"]);
    this.baseSha = git(seed, ["rev-parse", "HEAD"]);
  }
  inputBranch(jobId: string) { execFileSync("git", ["branch", `laterdog/input/${jobId}`, this.baseSha], { cwd: this.bare, env: gitEnv(this.root) }); }
  private json(status: number, body: unknown, headers: Record<string, string> = {}) { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }); }
  private refuse(status: number, code: string, message: string) { return this.json(status, { error: { code, message } }); }
  private view(computer: FakeComputer) { return { id: computer.id, name: computer.name, size: computer.size, state: computer.state, ...(computer.error ? { error: computer.error } : {}) }; }
  private run(computer: FakeComputer, command: string, timeoutMs: number, env?: Record<string, string>) {
    return new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn("bash", ["-c", command], { cwd: computer.home, timeout: timeoutMs,
        env: { HOME: computer.home, PATH: `${join(this.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`, GIT_CONFIG_GLOBAL: join(this.root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", LANG: "C", ...(this.envSupported ? env : {}) } });
      let stdout = ""; let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("close", (code, signal) => resolve({ exitCode: code, stdout, stderr, timedOut: signal === "SIGTERM" }));
    });
  }
  readonly fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value]));
    const body = init.body === undefined || init.body === null ? "" : typeof init.body === "string" ? init.body : Buffer.from(init.body as Uint8Array).toString("utf8");
    this.requests.push({ method, url: url.toString(), headers, body });
    if (headers.origin) return this.refuse(403, "browser_origin", "no browsers");
    if (this.key ? headers.authorization !== `Bearer ${this.key}` : headers.authorization !== undefined) return this.refuse(401, "unauthorized", "bad key");
    const path = url.pathname.replace(/^\/v1/, "");
    if (method === "POST" && path === "/computers") {
      const request = JSON.parse(body) as { name: string; size: string };
      if (!["small", "standard", "large", "xlarge"].includes(request.size)) return this.refuse(400, "invalid_size", "unknown size");
      const key = headers["idempotency-key"]; const existing = key ? this.idempotency.get(key) : undefined;
      if (existing) return this.json(201, { computer: this.view(this.computers.get(existing)!) }, { "idempotent-replayed": "true" });
      const id = `cmp_${randomUUID().replace(/-/g, "").slice(0, 12)}`; const home = join(this.root, "computers", id, "home"); mkdirSync(home, { recursive: true });
      const computer = { id, name: request.name, size: request.size, state: "starting", startingReads: this.startingReads, home };
      this.computers.set(id, computer); if (key) this.idempotency.set(key, id);
      if (this.dropFirstCreateAnswer) { this.dropFirstCreateAnswer = false; return this.refuse(502, "start_failed", "connection reset"); }
      return this.json(201, { computer: this.view(computer) });
    }
    if (method === "GET" && path === "/computers") return this.json(200, { computers: [...this.computers.values()].map((computer) => this.view(computer)) });
    const match = /^\/computers\/(cmp_[A-Za-z0-9_-]+)(\/[a-z]+)?$/.exec(path);
    const computer = match ? this.computers.get(match[1]) : undefined;
    if (!match || !computer) return this.refuse(404, "not_found", "no such computer");
    const action = match[2] ?? "";
    if (action === "" && method === "GET") {
      if (computer.state === "starting" && --computer.startingReads <= 0) computer.state = "running";
      return this.json(200, { computer: this.view(computer) });
    }
    if (action === "" && method === "DELETE") { this.computers.delete(computer.id); return this.json(200, { deleted: true }); }
    if (action === "/wake" && method === "POST") { computer.state = "starting"; computer.startingReads = 1; return this.json(200, { computer: this.view(computer) }); }
    if (computer.state !== "running") return this.refuse(409, "asleep", "computer is not running");
    if (action === "/desktop" && method === "POST") return this.json(200, { url: `https://computers.fixture.test/desktop/${computer.id}/signed-token/`, expiresAt: Date.now() + 7_200_000 });
    if (action === "/exec" && method === "POST") {
      const request = JSON.parse(body) as { command: string; timeoutMs?: number; env?: Record<string, string> };
      this.execs.push({ command: request.command, ...(request.env ? { env: request.env } : {}) });
      const result = await this.run(computer, request.command, request.timeoutMs ?? 120_000, request.env);
      this.maxExecStdout = Math.max(this.maxExecStdout, result.stdout.length);
      return this.json(200, { ...result, stdout: result.stdout.slice(0, 1024 * 1024), stderr: result.stderr.slice(0, 1024 * 1024) });
    }
    if (action === "/files") {
      const relative = url.searchParams.get("path") ?? ""; const file = relative.startsWith("/") ? relative : join(computer.home, relative);
      if (method === "PUT") { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, body); return this.json(200, { ok: true }); }
      if (method === "GET") return existsSync(file) ? new Response(readFileSync(file), { status: 200 }) : this.refuse(404, "file_not_found", "no such file");
    }
    return this.refuse(405, "method_not_allowed", "no");
  }) as unknown as typeof fetch;
  sleepState(id: string, state: string, error?: string) { const computer = this.computers.get(id)!; computer.state = state; computer.error = error; }
  file(id: string, path: string) { return readFileSync(join(this.computers.get(id)!.home, path), "utf8"); }
}

function setup(options: { claude?: string; env?: NodeJS.ProcessEnv; seed?: Record<string, string>; failing?: string[] } = {}) {
  const api = new FakeComputersApi(options.claude, { seed: options.seed, failing: options.failing });
  const env = options.env ?? { LATERDOG_COMPUTERS_URL: API, LATERDOG_COMPUTERS_KEY: COMPUTERS_KEY, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN, GH_TOKEN: GITHUB_TOKEN };
  const adapter = new LaterdogCloudAdapter(profile, { fetch: api.fetch, env, pollMs: 0 });
  const jobId = randomUUID(); api.inputBranch(jobId);
  const context: JobContext = { jobId, repository: "fixture/repo", sourceRef: `laterdog/input/${jobId}`, baseSha: api.baseSha, createdAt: new Date().toISOString() };
  return { api, adapter, context, env };
}

async function settle(adapter: LaterdogCloudAdapter, taskId: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const state = await adapter.inspect(taskId);
    if (state !== "running") return state;
    if (Date.now() > deadline) throw new Error("the fixture job did not settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function expectNoSecretOutsideEnv(api: FakeComputersApi) {
  for (const request of api.requests) {
    const outsideEnv = request.url.includes("/exec") ? JSON.stringify({ ...JSON.parse(request.body) as object, env: undefined }) : request.body;
    for (const secret of SECRETS) { expect(request.url).not.toContain(secret); expect(outsideEnv).not.toContain(secret); }
  }
  for (const exec of api.execs) for (const secret of SECRETS) expect(exec.command).not.toContain(secret);
}

describe("later.dog Cloud adapter", () => {
  it("boots a job computer, runs Claude Code on the pinned commit, collects the diff through the files API and deletes the computer", async () => {
    const { api, adapter, context } = setup();
    const { taskId, taskUrl } = await adapter.submit("echo ran > \"$HOME/task/setup.out\"", context.sourceRef!, "Change src/a.ts", context);
    expect(taskUrl).toBe("");
    const create = api.requests.find((request) => request.method === "POST" && request.url.endsWith("/computers"))!;
    expect(JSON.parse(create.body)).toEqual({ name: `${COMPUTER_PREFIX}${context.jobId}`, size: "small" });
    expect(create.headers["idempotency-key"]).toBe(context.jobId);
    expect(api.requests.filter((request) => request.method === "GET" && request.url.endsWith(`/computers/${taskId}`)).length).toBeGreaterThanOrEqual(2);
    const launch = api.execs.find((exec) => exec.env)!;
    expect(launch.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN, GH_TOKEN: GITHUB_TOKEN });
    expect(launch.command).toContain("setsid -f bash");
    expect(await settle(adapter, taskId)).toBe("ready");
    expect(api.file(taskId, "task/prompt.seen")).toBe("Change src/a.ts");
    expect(api.file(taskId, "task/claude.args").split("\n")).toEqual(expect.arrayContaining(["-p", "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"]));
    expect(api.file(taskId, "task/claude.env").trim()).toBe("oauth=set gh= sandbox=1 traffic=1");
    expect(api.file(taskId, "task/setup.out").trim()).toBe("ran");
    expect(api.file(taskId, "task/base").trim()).toBe(api.baseSha);
    const patch = await adapter.collect(taskId);
    expect(patch).toContain("diff --git a/src/a.ts b/src/a.ts"); expect(patch).toContain("-old"); expect(patch).toContain("+new"); expect(patch.endsWith("\n")).toBe(true);
    expect(api.requests.some((request) => request.method === "GET" && request.url.includes("/files?path=task%2Fpatch.diff"))).toBe(true);
    expect(api.computers.has(taskId)).toBe(false);
    expectNoSecretOutsideEnv(api);
  });

  it("replays the same computer for a retried create and never launches a job twice", async () => {
    const { api, adapter, context } = setup();
    api.dropFirstCreateAnswer = true;
    const first = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    const second = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    expect(second.taskId).toBe(first.taskId);
    expect(api.computers.size).toBe(1);
    expect(api.requests.filter((request) => request.method === "POST" && request.url.endsWith("/computers"))).toHaveLength(3);
    expect(api.execs.filter((exec) => exec.env)).toHaveLength(1);
    expect(await settle(adapter, first.taskId)).toBe("ready");
  });

  it("reports a failing job as failed with its stage and keeps the computer for inspection", async () => {
    const { api, adapter, context } = setup({ claude: "cat > /dev/null\nexit 3" });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    expect(await settle(adapter, taskId)).toBe("failed");
    expect(adapter.failure(taskId)).toMatch(/exited 3 during claude/);
    expect(api.computers.has(taskId)).toBe(true);
    const broken = setup();
    const job = await broken.adapter.submit("exit 7", broken.context.sourceRef!, "Prompt", broken.context);
    expect(await settle(broken.adapter, job.taskId)).toBe("failed");
    expect(broken.adapter.failure(job.taskId)).toMatch(/exited 7 during setup/);
  });

  it("reads a sleeping, failed or deleted computer as failed without waking it", async () => {
    const { api, adapter, context } = setup({ claude: 'cat > /dev/null\nwhile [ -d "$HOME/task" ] && [ ! -f "$HOME/task/stop" ]; do sleep 0.1; done' });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    const home = api.computers.get(taskId)!.home;
    cleanups.push(() => writeFileSync(join(home, "task", "stop"), ""));
    expect(await adapter.inspect(taskId)).toBe("running");
    const before = api.execs.length;
    api.sleepState(taskId, "sleeping");
    expect(await adapter.inspect(taskId)).toBe("failed");
    expect(adapter.failure(taskId)).toMatch(/fell asleep/);
    expect(api.requests.some((request) => request.url.endsWith("/wake"))).toBe(false);
    expect(api.execs.length).toBe(before);
    api.sleepState(taskId, "error", "host restarted");
    expect(await adapter.inspect(taskId)).toBe("failed");
    expect(adapter.failure(taskId)).toMatch(/error state \(host restarted\)/);
    api.computers.delete(taskId);
    expect(await adapter.inspect(taskId)).toBe("failed");
    expect(adapter.failure(taskId)).toMatch(/no longer exists/);
  });

  it("returns an empty diff when nothing changed and still deletes the computer", async () => {
    const { api, adapter, context } = setup({ claude: "cat > /dev/null" });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    expect(await settle(adapter, taskId)).toBe("ready");
    expect(await adapter.collect(taskId)).toBe("");
    expect(api.computers.has(taskId)).toBe(false);
  });

  it("collects a diff larger than the exec output cap through the files API", async () => {
    const { api, adapter, context } = setup({ claude: "cat > /dev/null\nmkdir -p data\nfor i in $(seq 1 40000); do printf 'line %06d of a large generated change\\n' \"$i\"; done > data/big.txt" });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    expect(await settle(adapter, taskId)).toBe("ready");
    const patch = await adapter.collect(taskId);
    expect(patch.length).toBeGreaterThan(1024 * 1024);
    expect(patch).toContain("+line 040000 of a large generated change");
    expect(api.maxExecStdout).toBeLessThan(1000);
  });

  it("refuses to launch when the computers service drops the exec env", async () => {
    const { api, adapter, context } = setup();
    api.envSupported = false;
    const error = await adapter.submit("none", context.sourceRef!, "Prompt", context).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ComputerSubmissionUnknown);
    expect(error).toBeInstanceOf(SubmissionUnknown);
    expect((error as Error).message).toMatch(/did not pass the exec env/);
    expect((error as ComputerSubmissionUnknown).computerId).toMatch(/^cmp_/);
  });

  it("defaults to the hosted supervisor's internal computers binding without a key, and reports its configuration", async () => {
    const api = new FakeComputersApi(); api.key = undefined;
    const env = { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN };
    expect(laterdogCloudSettings(env)).toEqual({ api: INTERNAL_COMPUTERS_API, claudeToken: CLAUDE_TOKEN });
    const wrapped = `${CLAUDE_TOKEN.slice(0, 10)}\n ${CLAUDE_TOKEN.slice(10)}\n`;
    expect(laterdogCloudSettings({ CLAUDE_CODE_OAUTH_TOKEN: wrapped }).claudeToken).toBe(CLAUDE_TOKEN);
    expect(() => laterdogCloudSettings({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN.slice(0, 80) })).toThrow(/not a whole Claude token \(80 characters/);
    expect(() => laterdogCloudSettings({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN.slice(0, 80) })).not.toThrow(new RegExp(CLAUDE_TOKEN.slice(13, 40)));
    const adapter = new LaterdogCloudAdapter(profile, { fetch: api.fetch, env });
    expect(await adapter.list()).toEqual({ tasks: [] });
    expect(api.requests[0].url).toBe(`${INTERNAL_COMPUTERS_API}/computers`);
    expect(api.requests[0].headers.authorization).toBeUndefined();
    expect((await adapter.doctor()).authenticated).toBe(true);
    await expect(new LaterdogCloudAdapter(profile, { env: {} }).doctor()).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN/);
    await expect(new LaterdogCloudAdapter(profile, { env: { ...env, LATERDOG_COMPUTERS_KEY: "not-a-key" } }).doctor()).rejects.toThrow(/ldc_/);
    await expect(new LaterdogCloudAdapter(profile, { env: { ...env, LATERDOG_COMPUTERS_URL: "http://example.com/v1" } }).doctor()).rejects.toThrow(/credential-free/);
    expect(() => laterdogCloudSettings({ ...env, LATERDOG_COMPUTERS_URL: `https://user:${COMPUTERS_KEY}@example.com/v1` })).toThrow(/credential-free/);
  });

  it("writes a progress log the desktop pages through, keeps it before the computer goes, and offers its screen", async () => {
    const { api, adapter, context } = setup({ claude: STREAM_CLAUDE });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "Change src/a.ts", context);
    expect(await settle(adapter, taskId)).toBe("ready");
    expect(adapter.progress(taskId)).toMatchObject({ stage: "done", lastStep: { k: "stage", stage: "done" } });
    const page = await adapter.activity(taskId, 0);
    expect(page).toMatchObject({ available: true, live: false });
    expect(page.steps.map((step) => (step.k === "stage" ? `stage:${step.stage}` : step.k))).toEqual(["stage:install", "stage:clone", "stage:setup", "stage:claude", "say", "tool", "done", "stage:done"]);
    expect(page.steps.find((step) => step.k === "tool")).toMatchObject({ tool: "Edit", detail: "src/a.ts" });
    const log = api.file(taskId, "task/activity.jsonl");
    expect(page.cursor).toBe(Buffer.byteLength(log));
    expect((await adapter.activity(taskId, page.cursor)).steps).toEqual([]);
    const middle = log.indexOf("\n", 10) + 1;
    expect((await adapter.activity(taskId, middle)).steps.length).toBe(page.steps.length - 1);
    expect(await adapter.transcript(taskId)).toBe(log);
    expect(api.file(taskId, "task/out.jsonl")).toContain('"type":"result"');
    expect((await adapter.screen(taskId)).url).toBe(`https://computers.fixture.test/desktop/${taskId}/signed-token/`);
    await adapter.collect(taskId);
    await expect(adapter.screen(taskId)).rejects.toThrow(/gone/);
    expect(await adapter.activity(taskId, 0)).toMatchObject({ available: false, live: false, steps: [] });
    expect(await adapter.transcript(taskId)).toBe("");
    expectNoSecretOutsideEnv(api);
  });

  it("installs a project's dependencies by itself, and tells Claude instead of failing when that does not work", async () => {
    const { api, adapter, context } = setup({ seed: { "package-lock.json": "{}\n", "package.json": "{}\n" }, failing: ["npm"] });
    const { taskId } = await adapter.submit("", context.sourceRef!, "Prompt", context);
    expect(await settle(adapter, taskId)).toBe("ready");
    expect(api.file(taskId, "task/setup.sh")).toBe(AUTO_SETUP_SCRIPT);
    expect(api.file(taskId, "task/npm.calls").trim()).toBe("ci");
    expect(api.file(taskId, "task/setup-failed")).toBe("");
    expect(api.file(taskId, "task/prompt.seen")).toBe(`Prompt${SETUP_FAILED_NOTE}`);
    const fine = setup();
    const job = await fine.adapter.submit("auto", fine.context.sourceRef!, "Prompt", fine.context);
    expect(await settle(fine.adapter, job.taskId)).toBe("ready");
    expect(fine.api.file(job.taskId, "task/prompt.seen")).toBe("Prompt");
  });

  it("stops a running job for real by deleting its computer", async () => {
    const { api, adapter, context } = setup({ claude: STREAM_CLAUDE });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "keep running", context);
    const home = api.computers.get(taskId)!.home;
    cleanups.push(() => writeFileSync(join(home, "task", "stop"), ""));
    const deadline = Date.now() + 10_000;
    while (!(await adapter.activity(taskId, 0)).steps.some((step) => step.k === "say") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await adapter.inspect(taskId)).toBe("running");
    expect(adapter.progress(taskId)?.stage).toBe("claude");
    api.sleepState(taskId, "sleeping");
    expect(await adapter.activity(taskId, 0)).toMatchObject({ available: false, reason: "This task's computer is asleep." });
    api.sleepState(taskId, "running");
    await adapter.cancel(taskId);
    expect(api.computers.has(taskId)).toBe(false);
    expect(await adapter.inspect(taskId)).toBe("failed");
  });

  it("refuses unsafe task inputs and quotes what it embeds", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    const base = { repository: "fixture/repo", sourceRef: "laterdog/input/x", baseSha: "a".repeat(40), maxRunMinutes: 10 };
    expect(taskScript(base)).toContain("REPOSITORY='fixture/repo'");
    expect(() => taskScript({ ...base, repository: "fixture/repo;rm -rf /" })).toThrow(/repository/);
    expect(() => taskScript({ ...base, sourceRef: "$(reboot)" })).toThrow(/source ref/);
    expect(() => taskScript({ ...base, baseSha: "HEAD" })).toThrow(/starting commit/);
  });

  it("accepts laterdog-cloud profiles with a computer size in the supervisor config", () => {
    const parsed = configSchema.parse({ profiles: [{ id: "cloud", label: "later.dog Cloud", backend: "laterdog-cloud", computerSize: "large" }] });
    expect(parsed.profiles[0]).toMatchObject({ backend: "laterdog-cloud", computerSize: "large" });
    expect(() => configSchema.parse({ profiles: [{ id: "cloud", label: "x", backend: "laterdog-cloud", computerSize: "huge" }] })).toThrow();
    expect(configSchema.parse({ profiles: [{ id: "cloud", label: "x", backend: "laterdog-cloud", maxComputerSize: "xlarge" }] }).profiles[0]).toMatchObject({ maxComputerSize: "xlarge" });
    expect(() => configSchema.parse({ profiles: [{ id: "cloud", label: "x", backend: "laterdog-cloud", maxComputerSize: "huge" }] })).toThrow();
    expect(repositorySchema.parse({ slug: "fixture/repo", environmentId: "x", environments: { "laterdog-cloud": "none" } }).environments["laterdog-cloud"]).toBe("none");
  });
});

describe("later.dog Cloud through the supervisor", () => {
  it("takes a laterdog-cloud job from queued to running to ready with a collected patch", async () => {
    const api = new FakeComputersApi();
    const env = { LATERDOG_COMPUTERS_URL: API, LATERDOG_COMPUTERS_KEY: COMPUTERS_KEY, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN };
    const dir = mkdtempSync(join(tmpdir(), "laterdog-cloud-supervisor-")); roots.push(dir);
    const store = new WorkspaceStore(":memory:"); cleanups.push(() => store.close());
    store.saveRepository(repositorySchema.parse({ slug: "fixture/repo", environmentId: "unused-codex-environment", environments: { "laterdog-cloud": "none" } }));
    const publisher = new GitHubPublisher(join(dir, "checkouts"));
    vi.spyOn(publisher, "prepare").mockImplementation(async (job) => { api.inputBranch(job.id); return { baseSha: api.baseSha, sourceRef: `laterdog/input/${job.id}` }; });
    const supervisor = new Supervisor(store, { dataDir: dir, profiles: [profile], concurrency: 2, publishingHost: "local", publisher,
      adapter: (p) => new LaterdogCloudAdapter(p, { fetch: api.fetch, env, pollMs: 0 }) });
    cleanups.push(() => supervisor.stop());
    const job = supervisor.create({ requestKey: randomUUID(), repository: "fixture/repo", title: "Cloud change", brief: "Change src/a.ts", writeScopes: ["src"], profileId: "cloud" });
    expect(job.backend).toBe("laterdog-cloud"); expect(store.job(job.id).state).toBe("queued");
    await supervisor.tick();
    const running = store.job(job.id);
    expect(running.state).toBe("running"); expect(running.taskId).toMatch(/^cmp_/);
    const deadline = Date.now() + 20_000;
    while (store.job(job.id).state === "running" && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 50)); await supervisor.tick(); }
    const ready = store.job(job.id);
    expect(ready.state).toBe("ready"); expect(ready.blocker).toBeUndefined();
    expect(readFileSync(ready.patchArtifact!, "utf8")).toContain("+new");
    expect(api.computers.size).toBe(0);
    const seen = readFileSync(join(api.root, "computers", running.taskId!, "home", "task", "prompt.seen"), "utf8");
    expect(seen).toContain(`[later.dog job ${job.id}]`); expect(seen).toContain("Do not push, open pull requests");
    expectNoSecretOutsideEnv(api);
    expect(supervisor.snapshot().backends.find((backend) => backend.id === "laterdog-cloud")).toMatchObject({ enabled: true, label: LATERDOG_CLOUD_CAPABILITIES.label });
    await supervisor.drain();
  });

  it("keeps a finished task's progress and changes, shows them as cloud task summaries, and stops a running task", async () => {
    const api = new FakeComputersApi(STREAM_CLAUDE);
    const env = { LATERDOG_COMPUTERS_URL: API, LATERDOG_COMPUTERS_KEY: COMPUTERS_KEY, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN };
    const dir = mkdtempSync(join(tmpdir(), "laterdog-cloud-supervisor-")); roots.push(dir);
    const store = new WorkspaceStore(":memory:"); cleanups.push(() => store.close());
    store.saveRepository(repositorySchema.parse({ slug: "fixture/repo", environmentId: "none", environments: {} }));
    const publisher = new GitHubPublisher(join(dir, "checkouts"));
    vi.spyOn(publisher, "prepare").mockImplementation(async (job) => { api.inputBranch(job.id); return { baseSha: api.baseSha, sourceRef: `laterdog/input/${job.id}` }; });
    const supervisor = new Supervisor(store, { dataDir: dir, profiles: [profile], concurrency: 2, publishingHost: "local", publisher,
      adapter: (p) => new LaterdogCloudAdapter(p, { fetch: api.fetch, env, pollMs: 0 }) });
    cleanups.push(() => supervisor.stop());
    const quick = supervisor.create({ requestKey: randomUUID(), repository: "fixture/repo", title: "Quick change", brief: "Change src/a.ts", writeScopes: ["src"], profileId: "cloud", botId: "dog-1", conversationId: "thread-1" });
    const long = supervisor.create({ requestKey: randomUUID(), repository: "fixture/repo", title: "Long change", brief: "keep running", writeScopes: ["docs"], profileId: "cloud", botId: "dog-1", conversationId: "thread-1" });
    expect(supervisor.summaries({ ids: [quick.id] })[0]).toMatchObject({ state: "queued", stoppable: true, screen: false });
    await supervisor.tick();
    const longTask = store.job(long.id).taskId!;
    cleanups.push(() => writeFileSync(join(api.root, "computers", longTask, "home", "task", "stop"), ""));
    const deadline = Date.now() + 20_000;
    while ((store.job(quick.id).state === "running" || store.job(long.id).lastStep?.k !== "say") && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 50)); await supervisor.tick(); }
    const done = store.job(quick.id);
    expect(done).toMatchObject({ state: "ready", changes: { files: 1, additions: 1, deletions: 1 } });
    expect(Date.parse(done.startedAt!)).toBeLessThanOrEqual(Date.parse(done.finishedAt!));
    expect(done.activityArtifact).toMatch(/\.activity\.jsonl$/);
    expect(api.computers.has(done.taskId!)).toBe(false);
    const kept = await supervisor.activity(quick.id, 0);
    expect(kept).toMatchObject({ available: true, live: false });
    expect(kept.steps.find((step) => step.k === "done")).toMatchObject({ ok: true, text: "Changed it." });
    expect(supervisor.summaries({ ids: [quick.id, randomUUID()] })).toEqual([expect.objectContaining({ id: quick.id, state: "ready", publishable: true, screen: false, stoppable: false })]);
    const running = supervisor.summaries({ ids: [long.id] })[0];
    expect(running).toMatchObject({ state: "running", stage: "claude", screen: true, stoppable: true, lastStep: { k: "say", text: "Still at it." } });
    expect(supervisor.summaries({ botId: "dog-1" }).map((job) => job.id)).toEqual([long.id, quick.id]);
    expect(supervisor.summaries({ botId: "someone-else" })).toEqual([]);
    const live = await supervisor.activity(long.id, 0);
    expect(live).toMatchObject({ available: true, live: true });
    expect((await supervisor.screen(long.id)).url).toContain(longTask);
    await expect(supervisor.screen(quick.id)).rejects.toThrow(/only kept while it runs/);
    const stopped = await supervisor.stopJob(long.id);
    expect(stopped).toMatchObject({ state: "cancelled", cancelRequested: true });
    expect(stopped.activityArtifact).toMatch(/\.activity\.jsonl$/);
    expect((await supervisor.activity(long.id, 0)).steps.find((step) => step.k === "say")).toMatchObject({ text: "Still at it." });
    expect(stopped.finishedAt).toBeTruthy();
    expect(api.computers.has(longTask)).toBe(false);
    await supervisor.tick();
    expect(store.job(long.id).state).toBe("cancelled");
    await supervisor.drain();
  });

  it("connects a repository by itself the first time a later.dog Cloud job names it, starting from its default branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-cloud-supervisor-")); roots.push(dir);
    const store = new WorkspaceStore(":memory:"); cleanups.push(() => store.close());
    const publisher = new GitHubPublisher(join(dir, "checkouts"));
    const defaultBranch = vi.spyOn(publisher, "defaultBranch").mockResolvedValue("trunk");
    const supervisor = new Supervisor(store, { dataDir: dir, profiles: [profile, { id: "default", label: "Codex" }], concurrency: 1, publishingHost: "local", publisher });
    cleanups.push(() => supervisor.stop());
    const request = { requestKey: randomUUID(), repository: "owner/new", title: "x", brief: "y", profileId: "cloud" };
    await supervisor.ensureRepository(request);
    expect(store.repository("owner/new")).toMatchObject({ baseRef: "trunk", environments: { "laterdog-cloud": "auto" }, publish: true, merge: false });
    expect(supervisor.create(request).state).toBe("queued");
    await supervisor.ensureRepository({ ...request, requestKey: randomUUID() });
    await supervisor.ensureRepository({ ...request, requestKey: randomUUID(), repository: "owner/codex", profileId: "default" });
    expect(store.hasRepository("owner/codex")).toBe(false);
    expect(defaultBranch).toHaveBeenCalledTimes(1);
    defaultBranch.mockRejectedValueOnce(Object.assign(new Error("later.dog could not open owner/missing on GitHub"), { status: 409 }));
    await expect(supervisor.ensureRepository({ ...request, requestKey: randomUUID(), repository: "owner/missing" })).rejects.toThrow(/could not open owner\/missing/);
  });

  it("builds the later.dog Cloud adapter for a laterdog-cloud profile and lists the backend as disabled otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-cloud-supervisor-")); roots.push(dir);
    const store = new WorkspaceStore(":memory:"); cleanups.push(() => store.close());
    const own = new Supervisor(store, { dataDir: dir, profiles: [profile], concurrency: 1, publishingHost: "local" }); cleanups.push(() => own.stop());
    expect(own.snapshot().backends.find((backend) => backend.id === "laterdog-cloud")?.enabled).toBe(true);
    const codex = new Supervisor(store, { dataDir: dir, profiles: [{ id: "default", label: "Codex" }], concurrency: 1, publishingHost: "local" }); cleanups.push(() => codex.stop());
    const listed = codex.snapshot().backends.find((backend) => backend.id === "laterdog-cloud");
    expect(listed?.enabled).toBe(false); expect(listed?.limitation).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
  });
});

describe("later.dog Cloud jobs choose their model, effort, size and account", () => {
  it("asks for a small computer unless the job asks for more, and never more than the profile allows", async () => {
    const sizeOf = async (adapterProfile: Profile, jobSize?: "small" | "standard" | "large" | "xlarge") => {
      const { api, context } = setup();
      const own = new LaterdogCloudAdapter(adapterProfile, { fetch: api.fetch, env: { LATERDOG_COMPUTERS_URL: API, LATERDOG_COMPUTERS_KEY: COMPUTERS_KEY, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN }, pollMs: 0 });
      await own.submit("none", context.sourceRef!, "Prompt", { ...context, ...(jobSize ? { computerSize: jobSize } : {}) });
      return JSON.parse(api.requests.find((request) => request.method === "POST" && request.url.endsWith("/computers"))!.body).size as string;
    };
    expect(await sizeOf(profile)).toBe("small");
    expect(await sizeOf(profile, "large")).toBe("small");
    expect(await sizeOf({ ...profile, maxComputerSize: "large" }, "large")).toBe("large");
    expect(await sizeOf({ ...profile, maxComputerSize: "large" })).toBe("small");
    expect(await sizeOf({ ...profile, computerSize: "standard" })).toBe("small");
    expect(await sizeOf({ ...profile, computerSize: "standard" }, "xlarge")).toBe("standard");
    expect(await sizeOf({ ...profile, computerSize: "xlarge", maxComputerSize: "standard" }, "xlarge")).toBe("standard");
  });

  it("runs Claude Code with the model and effort the job asks for, and with its own defaults otherwise", async () => {
    const asked = setup();
    const { taskId } = await asked.adapter.submit("none", asked.context.sourceRef!, "Prompt", { ...asked.context, model: "claude-opus-5-5", effort: "ultra" });
    expect(await settle(asked.adapter, taskId)).toBe("ready");
    expect(asked.api.file(taskId, "task/claude.args").split("\n")).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--effort", "ultracode"]));
    const plain = setup();
    const job = await plain.adapter.submit("none", plain.context.sourceRef!, "Prompt", plain.context);
    expect(await settle(plain.adapter, job.taskId)).toBe("ready");
    const args = plain.api.file(job.taskId, "task/claude.args");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
  });

  it("quotes the model it embeds and refuses one that is not a model id", () => {
    expect(claudeOptions({ model: "claude-sonnet-5-5[1m]", effort: "high" })).toBe("--model 'claude-sonnet-5-5[1m]' --effort 'high'");
    expect(claudeOptions({})).toBe("");
    expect(() => claudeOptions({ model: "x; reboot" })).toThrow(/Invalid model/);
    expect(() => claudeOptions({ model: "$(reboot)" })).toThrow(/Invalid model/);
    expect(() => claudeOptions({ effort: "turbo" as never })).toThrow(/Invalid effort/);
    const base = { repository: "fixture/repo", sourceRef: "laterdog/input/x", baseSha: "a".repeat(40), maxRunMinutes: 10 };
    expect(taskScript({ ...base, model: "claude-opus-5-5", effort: "xhigh" })).toContain("--verbose --model 'claude-opus-5-5' --effort 'xhigh' < ");
    expect(taskScript(base)).toContain("--verbose < ");
  });

  it("signs a job in with the Claude token its profile names", async () => {
    const work = `sk-ant-oat01-work_account_secret_${"w".repeat(80)}`;
    const api = new FakeComputersApi();
    const env = { LATERDOG_COMPUTERS_URL: API, LATERDOG_COMPUTERS_KEY: COMPUTERS_KEY, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_WORK: work };
    const adapter = new LaterdogCloudAdapter({ ...profile, id: "work", claudeTokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_WORK" }, { fetch: api.fetch, env, pollMs: 0 });
    const jobId = randomUUID(); api.inputBranch(jobId);
    await adapter.submit("none", `laterdog/input/${jobId}`, "Prompt", { jobId, repository: "fixture/repo", sourceRef: `laterdog/input/${jobId}`, baseSha: api.baseSha, createdAt: new Date().toISOString() });
    expect(api.execs.find((exec) => exec.env)!.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: work });
    await expect(new LaterdogCloudAdapter({ ...profile, claudeTokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_MISSING" }, { fetch: api.fetch, env }).doctor()).rejects.toThrow(/CLAUDE_CODE_OAUTH_TOKEN_MISSING/);
    expect(() => configSchema.parse({ profiles: [{ id: "work", label: "Work", backend: "laterdog-cloud", claudeTokenEnv: "GH_TOKEN" }] })).toThrow();
    expect(configSchema.parse({ profiles: [{ id: "work", label: "Work", backend: "laterdog-cloud", claudeTokenEnv: "CLAUDE_CODE_OAUTH_TOKEN_WORK", account: "claude-2" }] }).profiles[0]).toMatchObject({ account: "claude-2" });
  });
});

describe("later.dog Cloud keeps every trace", () => {
  const LEAKY = [
    'cat > "$HOME/task/prompt.seen"',
    `echo '{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}'`,
    `printf '{"type":"user","leak":"%s"}\\n' "$CLAUDE_CODE_OAUTH_TOKEN"`,
    "mkdir -p src && printf 'new\\n' > src/a.ts",
    `echo '{"type":"result","is_error":false,"result":"ok"}'`,
  ].join("\n");

  it("packs the computer's full event stream, with the tokens blanked", async () => {
    const { api, adapter, context } = setup({ claude: LEAKY });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    expect(await settle(adapter, taskId)).toBe("ready");
    const capture = (await adapter.trace(taskId))!;
    expect(capture).toMatchObject({ truncated: false });
    const text = gunzipSync(capture.gz).toString("utf8");
    expect(text).toContain('"text":"working"');
    expect(text).toContain('"type":"result"');
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(CLAUDE_TOKEN);
    expect(text.trim().split("\n")).toHaveLength(api.file(taskId, "task/out.jsonl").trim().split("\n").length);
    expect(capture.rawBytes).toBe(Buffer.byteLength(text));
  });

  it("keeps the last 64 MB and says so when the stream is larger", async () => {
    const { api, adapter, context } = setup({ claude: "cat > /dev/null" });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    expect(await settle(adapter, taskId)).toBe("ready");
    const line = `{"n":1,"pad":"${"x".repeat(990)}"}\n`;
    writeFileSync(join(api.computers.get(taskId)!.home, "task", "out.jsonl"), line.repeat(Math.ceil((70 * 1024 * 1024) / line.length)));
    const capture = (await adapter.trace(taskId))!;
    expect(capture.truncated).toBe(true);
    const text = gunzipSync(capture.gz).toString("utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(text.startsWith('{"n":1')).toBe(true);
  }, 60_000);

  it("has nothing to keep when the job never started Claude, or its computer is gone or asleep", async () => {
    const { api, adapter, context } = setup({ claude: "cat > /dev/null" });
    const { taskId } = await adapter.submit("none", context.sourceRef!, "Prompt", context);
    expect(await settle(adapter, taskId)).toBe("ready");
    writeFileSync(join(api.computers.get(taskId)!.home, "task", "out.jsonl"), "");
    expect(await adapter.trace(taskId)).toBeNull();
    api.sleepState(taskId, "sleeping");
    expect(await adapter.trace(taskId)).toBeNull();
    api.computers.delete(taskId);
    expect(await adapter.trace(taskId)).toBeNull();
  });

  it("uploads the trace to the state store before the computer is deleted, and serves it back", async () => {
    const api = new FakeComputersApi(LEAKY);
    const state = new FakeTraceState();
    const env = { LATERDOG_COMPUTERS_URL: API, LATERDOG_COMPUTERS_KEY: COMPUTERS_KEY, CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN };
    const dir = mkdtempSync(join(tmpdir(), "laterdog-cloud-supervisor-")); roots.push(dir);
    const store = new WorkspaceStore(":memory:"); cleanups.push(() => store.close());
    store.saveRepository(repositorySchema.parse({ slug: "fixture/repo", environmentId: "none", environments: {} }));
    const publisher = new GitHubPublisher(join(dir, "checkouts"));
    vi.spyOn(publisher, "prepare").mockImplementation(async (job) => { api.inputBranch(job.id); return { baseSha: api.baseSha, sourceRef: `laterdog/input/${job.id}` }; });
    const traces = jobTraceStoreFromEnv({}, dir);
    const supervisor = new Supervisor(store, { dataDir: dir, profiles: [profile], concurrency: 2, publishingHost: "local", publisher, traceRetentionDays: 14, traceRetryMs: [0],
      traces: { primary: new StateTraceStore("http://state.r2", { fetch: state.fetch }), local: traces.local },
      adapter: (p) => new LaterdogCloudAdapter(p, { fetch: api.fetch, env, pollMs: 0 }) });
    cleanups.push(() => supervisor.stop());
    const job = supervisor.create({ requestKey: randomUUID(), repository: "fixture/repo", title: "Traced", brief: "Change src/a.ts", writeScopes: ["src"], profileId: "cloud" });
    await supervisor.tick();
    const deadline = Date.now() + 20_000;
    while (store.job(job.id).state === "running" && Date.now() < deadline) { await new Promise((resolve) => setTimeout(resolve, 50)); await supervisor.tick(); }
    const ready = store.job(job.id);
    expect(ready.state).toBe("ready");
    expect(api.computers.size).toBe(0);
    expect(ready.trace).toMatchObject({ where: "r2", truncated: false });
    expect(state.objects.get(`traces/${job.id}.jsonl.gz`)?.retainDays).toBe(14);
    expect(Math.round((Date.parse(ready.trace!.expiresAt) - Date.now()) / 86_400_000)).toBe(14);
    const served = await supervisor.trace(job.id);
    expect(served.filename).toBe(`laterdog-job-${job.id}-trace.jsonl`);
    const servedText = (await slurp(served.stream))!.toString("utf8");
    expect(servedText).toContain('"text":"working"');
    expect(servedText).not.toContain(CLAUDE_TOKEN);
    expect(supervisor.summaries({ ids: [job.id] })[0].trace).toMatchObject({ truncated: false });
    await supervisor.drain();
  });
});
