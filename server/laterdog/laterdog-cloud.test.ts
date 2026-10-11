import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { repositorySchema, type Profile } from "../../shared/laterdog.ts";
import { configSchema } from "./config.ts";
import { SubmissionUnknown, type JobContext } from "./codex-cloud.ts";
import { GitHubPublisher } from "./github.ts";
import { WorkspaceStore } from "./store.ts";
import { Supervisor } from "./supervisor.ts";
import {
  COMPUTER_PREFIX, ComputerSubmissionUnknown, INTERNAL_COMPUTERS_API, LATERDOG_CLOUD_CAPABILITIES, LaterdogCloudAdapter, laterdogCloudSettings, shellQuote, taskScript,
} from "./laterdog-cloud.ts";

const CLAUDE_TOKEN = "sk-ant-oat01-fixture-claude-secret";
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

const roots: string[] = [];
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

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
  constructor(claude = DEFAULT_CLAUDE) {
    this.root = mkdtempSync(join(tmpdir(), "laterdog-cloud-")); roots.push(this.root);
    const bin = join(this.root, "bin"); mkdirSync(bin);
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

function setup(options: { claude?: string; env?: NodeJS.ProcessEnv } = {}) {
  const api = new FakeComputersApi(options.claude);
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
    expect(JSON.parse(create.body)).toEqual({ name: `${COMPUTER_PREFIX}${context.jobId}`, size: "xlarge" });
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
    const adapter = new LaterdogCloudAdapter(profile, { fetch: api.fetch, env });
    expect(await adapter.list()).toEqual({ tasks: [] });
    expect(api.requests[0].url).toBe(`${INTERNAL_COMPUTERS_API}/computers`);
    expect(api.requests[0].headers.authorization).toBeUndefined();
    expect((await adapter.doctor()).authenticated).toBe(true);
    expect((await new LaterdogCloudAdapter(profile, { env: {} }).doctor()).authenticated).toBe(false);
    expect((await new LaterdogCloudAdapter(profile, { env: { ...env, LATERDOG_COMPUTERS_KEY: "not-a-key" } }).doctor()).authenticated).toBe(false);
    expect((await new LaterdogCloudAdapter(profile, { env: { ...env, LATERDOG_COMPUTERS_URL: "http://example.com/v1" } }).doctor()).authenticated).toBe(false);
    expect(() => laterdogCloudSettings({ ...env, LATERDOG_COMPUTERS_URL: `https://user:${COMPUTERS_KEY}@example.com/v1` })).toThrow(/credential-free/);
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
