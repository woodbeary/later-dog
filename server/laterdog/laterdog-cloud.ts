import { z } from "zod";
import { DEFAULT_JOB_COMPUTER_SIZE, JOB_COMPUTER_SIZES, JOB_EFFORTS, gitRef, jobModel, repoSlug, type BackendCapabilities, type JobEffort, type Profile } from "../../shared/laterdog.ts";
import { COMPUTER_ID, ComputersApiError, readCapped } from "./cloud-computers.ts";
import { SubmissionUnknown, type ExecutionAdapter, type JobContext } from "./codex-cloud.ts";
import { MAX_TRACE_GZIP_BYTES, TRACE_COMMAND, captureTrace, parseTraceReport, type TraceCapture } from "./job-trace.ts";
import { claudeEffortArg } from "./effort-levels.ts";
import { ACTIVITY_SCRIPT, AUTO_SETUP_SCRIPT, SETUP_FAILED_NOTE, WATCH_SCRIPT } from "./cloud-task-files.ts";
import { MAX_ACTIVITY_PAGE_BYTES, cloudTaskStep, parseCloudTaskSteps, type CloudTaskActivityPage, type CloudTaskStep } from "../../shared/cloud-task.ts";

export const LATERDOG_CLOUD_CAPABILITIES: BackendCapabilities = {
  id: "laterdog-cloud", label: "later.dog Cloud", enabled: true, submission: true, continuation: false, cancellation: true,
  activity: "polled", billing: "subscription",
  limitation: "Runs Claude Code only, signed in with the owner's Claude subscription (CLAUDE_CODE_OAUTH_TOKEN, or the token a profile names), with the model and effort the job asks for, on the owner's own later.dog cloud computers on Cloudflare. Each job boots a fresh Linux computer and installs Claude Code and the repository's setup, so its first minutes are setup. Linux only; no Docker inside a computer. Status is polled from files the job writes; a computer that falls asleep (15 minutes without API activity, or 8 hours awake) or errors is reported failed and kept for inspection. Corrections start a new computer. Stopping a running job deletes its computer; its progress log and full trace are kept, its files are not. Progress is read from the job's own computer while it runs, and its screen can be watched live; a finished job keeps its progress log and its full trace (30 days by default) but not its computer. Computers default to the small size unless a job asks for more.",
};

export const COMPUTER_SIZES = JOB_COMPUTER_SIZES;
export type ComputerSize = typeof COMPUTER_SIZES[number];
export const COMPUTER_PREFIX = "laterdog-job-";
export const DEFAULT_CLAUDE_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const SECRET_ENV_NAMES = ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"] as const;
export const MAX_PATCH_BYTES = 16 * 1000 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const OWNER_KEY = /^ldc_[!-~]{8,1024}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const MAX_TRANSCRIPT_BYTES = 8 * 1000 * 1000;
export const SETUP_MODES = ["none", "auto", "command"] as const;
export type SetupMode = typeof SETUP_MODES[number];
export function setupMode(environmentId: string): SetupMode { const value = environmentId.trim(); return value === "none" ? "none" : value === "auto" || value === "" ? "auto" : "command"; }

const computerSchema = z.object({ id: z.string().regex(COMPUTER_ID), name: z.string().max(200), state: z.string().min(1).max(40), error: z.string().optional() });
type Computer = z.infer<typeof computerSchema>;
const computerBody = z.object({ computer: computerSchema });
const listBody = z.object({ computers: z.array(computerSchema).max(10_000) });
const execBody = z.object({ exitCode: z.number().int().nullable(), stdout: z.string(), stderr: z.string(), timedOut: z.boolean().optional() });
type ExecResult = z.infer<typeof execBody>;
const errorBody = z.object({ error: z.object({ code: z.string().optional(), message: z.string().optional() }) });
const desktopBody = z.object({ url: z.string().url().max(16_384), expiresAt: z.union([z.number(), z.string()]) });

export const INTERNAL_COMPUTERS_API = "http://computers.internal/v1";
export const INTERNAL_COMPUTERS_HOST = "computers.internal";

export interface LaterdogCloudSettings { api: string; key?: string; claudeToken: string; githubToken?: string }

export function computersApi(raw: string): string {
  let url: URL | null = null;
  try { url = new URL(raw); } catch { url = null; }
  const allowed = url && (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", INTERNAL_COMPUTERS_HOST].includes(url.hostname)));
  if (!url || !allowed || url.username || url.password || url.search || url.hash) {
    throw new Error("LATERDOG_COMPUTERS_URL must be a credential-free HTTPS later.dog computers API, loopback HTTP, or http://computers.internal/v1");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function laterdogCloudSettings(env: NodeJS.ProcessEnv, tokenEnv: string = DEFAULT_CLAUDE_TOKEN_ENV): LaterdogCloudSettings {
  const api = computersApi(env.LATERDOG_COMPUTERS_URL?.trim() || INTERNAL_COMPUTERS_API);
  const key = env.LATERDOG_COMPUTERS_KEY?.trim();
  if (key && !OWNER_KEY.test(key)) throw new Error("LATERDOG_COMPUTERS_KEY does not hold a later.dog computers key (they start with ldc_)");
  const claudeToken = env[tokenEnv]?.replace(/\s+/g, "");
  if (!claudeToken) throw new Error(`later.dog Cloud needs ${tokenEnv} in the supervisor's environment`);
  if (!/^sk-ant-oat\d{2}-[A-Za-z0-9_-]{90,}$/.test(claudeToken)) throw new Error(`${tokenEnv} is not a whole Claude token (${claudeToken.length} characters, starts ${claudeToken.startsWith("sk-ant-oat") ? "like" : "unlike"} one); store the full output of claude setup-token again`);
  const githubToken = env.GH_TOKEN?.trim();
  return { api, claudeToken, ...(key ? { key } : {}), ...(githubToken ? { githubToken } : {}) };
}

export function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

export interface TaskInput { repository: string; sourceRef: string; baseSha: string; maxRunMinutes: number; setup?: SetupMode; model?: string; effort?: JobEffort }

export function claudeOptions(input: Pick<TaskInput, "model" | "effort">): string {
  if (input.model !== undefined && !jobModel.safeParse(input.model).success) throw new Error("Invalid model for a later.dog Cloud job");
  if (input.effort !== undefined && !(JOB_EFFORTS as readonly string[]).includes(input.effort)) throw new Error("Invalid effort for a later.dog Cloud job");
  return [...(input.model ? ["--model", shellQuote(input.model)] : []), ...(input.effort ? ["--effort", shellQuote(claudeEffortArg(input.effort))] : [])].join(" ");
}

export function taskScript(input: TaskInput): string {
  if (!repoSlug.safeParse(input.repository).success) throw new Error("Invalid repository for a later.dog Cloud job");
  if (!gitRef.safeParse(input.sourceRef).success) throw new Error("Invalid source ref for a later.dog Cloud job");
  if (!SHA.test(input.baseSha)) throw new Error("Invalid starting commit for a later.dog Cloud job");
  if (!Number.isInteger(input.maxRunMinutes) || input.maxRunMinutes < 1 || input.maxRunMinutes > 24 * 60) throw new Error("maxRunMinutes must be 1 to 1440");
  const options = claudeOptions(input);
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `REPOSITORY=${shellQuote(input.repository)}`,
    `SOURCE_REF=${shellQuote(input.sourceRef)}`,
    `BASE_SHA=${shellQuote(input.baseSha)}`,
    `MAX_RUN_SECONDS=${input.maxRunMinutes * 60}`,
    `SETUP_MODE=${shellQuote(input.setup ?? "command")}`,
    'TASK="$HOME/task"',
    'WORK="$HOME/work"',
    "stage() { printf '%s\\n' \"$1\" > \"$TASK/stage\"; printf '{\"t\":%s000,\"k\":\"stage\",\"stage\":\"%s\"}\\n' \"$(date +%s)\" \"$1\" >> \"$TASK/activity.jsonl\"; }",
    "watch() {",
    '  if [ -n "${DISPLAY:-}" ] && [ -f "$TASK/watch.mjs" ] && command -v xfce4-terminal >/dev/null 2>&1; then',
    '    env -i HOME="$HOME" PATH="$PATH" DISPLAY="$DISPLAY" LANG=C.UTF-8 XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-}" DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}" setsid -f xfce4-terminal --disable-server --maximize --hide-menubar -T "later.dog cloud task" -x node "$TASK/watch.mjs" >/dev/null 2>&1 </dev/null || true',
    "  fi",
    "}",
    "finish() { local status=$?; printf '%s\\n' \"$status\" > \"$TASK/exit.tmp\"; mv \"$TASK/exit.tmp\" \"$TASK/exit\"; }",
    "main() {",
    "  printf '%s\\n' \"$$\" > \"$TASK/pid.tmp\"",
    '  mv "$TASK/pid.tmp" "$TASK/pid"',
    "  trap finish EXIT",
    "  watch",
    '  export NPM_CONFIG_PREFIX="$HOME/.npm-global"',
    '  export PATH="$HOME/.npm-global/bin:$PATH"',
    "  export IS_SANDBOX=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    "  stage install",
    "  command -v claude >/dev/null 2>&1 || npm i -g @anthropic-ai/claude-code",
    "  stage clone",
    '  rm -rf "$WORK"',
    '  git init -q "$WORK"',
    '  cd "$WORK"',
    '  git remote add origin "https://github.com/$REPOSITORY.git"',
    '  if [ -n "${GH_TOKEN:-}" ]; then',
    "    git -c credential.helper= -c 'credential.helper=!f() { test \"$1\" = get || exit 0; echo username=x-access-token; echo \"password=$GH_TOKEN\"; }; f' fetch -q --no-tags origin \"+refs/heads/$SOURCE_REF:refs/laterdog/input\"",
    "  else",
    '    git fetch -q --no-tags origin "+refs/heads/$SOURCE_REF:refs/laterdog/input"',
    "  fi",
    '  test "$(git rev-parse refs/laterdog/input)" = "$BASE_SHA"',
    '  git checkout -q --detach "$BASE_SHA"',
    "  git config user.name later.dog",
    "  git config user.email laterdog@users.noreply.github.com",
    "  printf '%s\\n' \"$BASE_SHA\" > \"$TASK/base\"",
    "  stage setup",
    '  if [ -f "$TASK/setup.sh" ]; then',
    '    if [ "$SETUP_MODE" = auto ]; then',
    `      bash "$TASK/setup.sh" || { touch "$TASK/setup-failed"; printf '%s' ${shellQuote(SETUP_FAILED_NOTE)} >> "$TASK/prompt.md"; }`,
    "    else",
    '      bash "$TASK/setup.sh"',
    "    fi",
    "  fi",
    "  unset GH_TOKEN",
    "  stage claude",
    `  timeout --kill-after=60 "$MAX_RUN_SECONDS" claude -p --dangerously-skip-permissions --output-format stream-json --verbose${options ? ` ${options}` : ""} < "$TASK/prompt.md" | tee "$TASK/out.jsonl" | { node "$TASK/activity.mjs" || cat > /dev/null; }`,
    "  stage done",
    "}",
    'main "$@"',
    "exit",
    "",
  ].join("\n");
}

export const STATUS_COMMAND = [
  'T="$HOME/task"',
  'alive=1',
  'if [ -s "$T/pid" ] && ! kill -0 "$(cat "$T/pid")" 2>/dev/null; then alive=0; fi',
  'if [ -f "$T/exit" ]; then printf \'exit %s %s\\n\' "$(cat "$T/exit")" "$(cat "$T/stage" 2>/dev/null || echo unknown)"',
  'elif [ ! -d "$T/launched" ]; then echo unlaunched',
  'elif [ "$alive" = 0 ]; then printf \'vanished %s\\n\' "$(cat "$T/stage" 2>/dev/null || echo unknown)"',
  'else printf \'running %s\\n\' "$(cat "$T/stage" 2>/dev/null || echo starting)"; fi',
  'tail -n 1 "$T/activity.jsonl" 2>/dev/null || true',
].join("\n");

export function launchCommand(setup: boolean): string {
  return [
    'T="$HOME/task"',
    '[ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || exit 64',
    '[ -f "$T/run.sh" ] && [ -f "$T/prompt.md" ] || exit 65',
    ...(setup ? [] : ['rm -f "$T/setup.sh"']),
    'mkdir "$T/launched" 2>/dev/null || exit 66',
    'setsid -f bash "$T/run.sh" > "$T/log" 2>&1 < /dev/null',
  ].join("\n");
}

export const COLLECT_COMMAND = [
  "set -euo pipefail",
  'cd "$HOME/work"',
  "git add -A",
  'git diff --cached --binary --no-ext-diff --no-color "$(cat "$HOME/task/base")" > "$HOME/task/patch.diff"',
  'wc -c < "$HOME/task/patch.diff"',
].join("\n");

export class ComputerSubmissionUnknown extends SubmissionUnknown {
  readonly computerId?: string;
  constructor(detail: string, computerId?: string) {
    super();
    this.computerId = computerId;
    this.message = `${detail} ${computerId ? `Reconcile this job with computer ${computerId}, or delete that computer, before any retry.` : "Submitting the same job again replays the same computer."}`;
  }
}

export interface LaterdogCloudAdapterOptions {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  size?: ComputerSize;
  bootTimeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  maxRunMinutes?: number;
}

type Send = { method?: string; body?: RequestInit["body"]; headers?: Record<string, string>; accept?: string; timeoutMs?: number };

class LaterdogComputers {
  readonly #settings: LaterdogCloudSettings;
  readonly #fetch: typeof fetch;
  constructor(settings: LaterdogCloudSettings, fetchImpl: typeof fetch) { this.#settings = settings; this.#fetch = fetchImpl; }

  async send(path: string, { method = "GET", body, headers = {}, accept = "application/json", timeoutMs = 30_000 }: Send = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#settings.api}${path}`, { method, body, signal: AbortSignal.timeout(timeoutMs),
        headers: { accept, ...headers, ...(this.#settings.key ? { authorization: `Bearer ${this.#settings.key}` } : {}) } });
    } catch (error) {
      throw new ComputersApiError("later.dog's computers service could not be reached or did not answer in time", 0, undefined, { cause: error });
    }
    if (response.ok) return response;
    let failure: unknown = null;
    try { failure = JSON.parse((await readCapped(response, MAX_ERROR_BYTES, () => new Error("too large"))).toString("utf8")); } catch { failure = null; }
    const parsed = errorBody.safeParse(failure);
    const code = parsed.success && /^[a-z0-9_]{1,64}$/.test(parsed.data.error.code ?? "") ? parsed.data.error.code : undefined;
    const theirs = parsed.success ? (parsed.data.error.message ?? "").trim().slice(0, 300) : "";
    const text = response.status === 401 || (response.status === 403 && code !== "trial_size")
      ? (this.#settings.key ? "later.dog's computers service rejected LATERDOG_COMPUTERS_KEY" : `later.dog's computers service refused this supervisor (${response.status}); set LATERDOG_COMPUTERS_KEY, or bind the supervisor Worker to the computers Worker's ComputersApi entrypoint`)
      : theirs || `later.dog's computers service could not complete that request (${response.status})`;
    throw new ComputersApiError(text, response.status, code);
  }

  async json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    let body: unknown;
    try { body = JSON.parse((await readCapped(response, MAX_JSON_BYTES, () => new Error("too large"))).toString("utf8")); }
    catch { throw new ComputersApiError("later.dog's computers service returned an unreadable answer", 502, "invalid_response"); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ComputersApiError("later.dog's computers service returned an unexpected answer", 502, "invalid_response");
    return parsed.data;
  }

  async create(name: string, size: ComputerSize, idempotencyKey: string): Promise<Computer> {
    const send = () => this.send("/computers", { method: "POST", body: JSON.stringify({ name, size }), timeoutMs: 45_000,
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey } });
    let response: Response;
    try { response = await send(); }
    catch (error) {
      if (!(error instanceof ComputersApiError) || (error.httpStatus !== 0 && error.httpStatus < 500)) throw error;
      response = await send();
    }
    return (await this.json(response, computerBody)).computer;
  }

  async get(id: string): Promise<Computer | null> {
    let response: Response;
    try { response = await this.send(`/computers/${id}`); }
    catch (error) { if (error instanceof ComputersApiError && (error.httpStatus === 404 || error.httpStatus === 410)) return null; throw error; }
    const { computer } = await this.json(response, computerBody);
    if (computer.id !== id) throw new ComputersApiError("later.dog's computers service returned a different computer", 502, "invalid_response");
    return computer;
  }

  async list(): Promise<Computer[]> { return (await this.json(await this.send("/computers"), listBody)).computers; }

  async wake(id: string): Promise<Computer> {
    return (await this.json(await this.send(`/computers/${id}/wake`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), computerBody)).computer;
  }

  async remove(id: string): Promise<"deleted" | "absent"> {
    try { await (await this.send(`/computers/${id}`, { method: "DELETE" })).body?.cancel(); return "deleted"; }
    catch (error) { if (error instanceof ComputersApiError && (error.httpStatus === 404 || error.httpStatus === 410)) return "absent"; throw error; }
  }

  async exec(id: string, command: string, timeoutMs: number, env?: Record<string, string>): Promise<ExecResult> {
    if (env) for (const name of Object.keys(env)) if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name ${name}`);
    const body = JSON.stringify({ command, timeoutMs, ...(env ? { env } : {}) });
    return this.json(await this.send(`/computers/${id}/exec`, { method: "POST", body, headers: { "content-type": "application/json" }, timeoutMs: timeoutMs + 15_000 }), execBody);
  }

  async put(id: string, path: string, content: string | Uint8Array): Promise<void> {
    const response = await this.send(`/computers/${id}/files?path=${encodeURIComponent(path)}`, { method: "PUT", body: content, headers: { "content-type": "application/octet-stream" }, timeoutMs: 60_000 });
    await response.body?.cancel().catch(() => undefined);
  }

  async desktop(id: string): Promise<{ url: string; expiresAt: number | string }> {
    const response = await this.send(`/computers/${id}/desktop`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    return this.json(response, desktopBody);
  }

  async read(id: string, path: string, maxBytes: number): Promise<Buffer> {
    const response = await this.send(`/computers/${id}/files?path=${encodeURIComponent(path)}`, { accept: "application/octet-stream", timeoutMs: 120_000 });
    return readCapped(response, maxBytes, () => new ComputersApiError(`the file is larger than ${maxBytes} bytes`, 413, "too_large"));
  }
}

const SLEEPING = "Its later.dog cloud computer fell asleep (15 minutes without API activity, or 8 hours awake), which stops the job's processes; the files are kept.";

export class LaterdogCloudAdapter implements ExecutionAdapter {
  readonly capabilities = LATERDOG_CLOUD_CAPABILITIES;
  private readonly profile: Profile;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly size: ComputerSize;
  private readonly bootTimeoutMs: number;
  private readonly pollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRunMinutes: number;
  private readonly failures = new Map<string, string>();
  private readonly progressById = new Map<string, { stage?: string; lastStep?: CloudTaskStep }>();
  constructor(profile: Profile, options: LaterdogCloudAdapterOptions = {}) {
    this.profile = profile; this.fetchImpl = options.fetch ?? fetch; this.env = options.env ?? process.env;
    this.size = options.size ?? profile.computerSize ?? DEFAULT_JOB_COMPUTER_SIZE;
    this.bootTimeoutMs = options.bootTimeoutMs ?? 180_000; this.pollMs = options.pollMs ?? 2_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRunMinutes = options.maxRunMinutes ?? 180;
  }

  private client(): { computers: LaterdogComputers; settings: LaterdogCloudSettings } {
    const settings = laterdogCloudSettings(this.env, this.profile.claudeTokenEnv);
    return { computers: new LaterdogComputers(settings, this.fetchImpl), settings };
  }

  private static id(taskId: string): string {
    if (!COMPUTER_ID.test(taskId)) throw new Error("Invalid later.dog cloud computer ID");
    return taskId;
  }

  async doctor(): Promise<{ version: string; authenticated: boolean; cloudCommands: string }> {
    laterdogCloudSettings(this.env, this.profile.claudeTokenEnv);
    return { version: "laterdog-computers-v1", authenticated: true,
      cloudCommands: "POST /v1/computers, POST /v1/computers/:id/exec, GET and PUT /v1/computers/:id/files, DELETE /v1/computers/:id; Claude Code runs headless in each job's own computer" };
  }

  describeTask(taskId: string): { taskUrl: string } { LaterdogCloudAdapter.id(taskId); return { taskUrl: "" }; }

  failure(taskId: string): string | undefined { return this.failures.get(taskId); }

  private async waitRunning(computers: LaterdogComputers, id: string): Promise<void> {
    const deadline = Date.now() + this.bootTimeoutMs;
    for (;;) {
      const computer = await computers.get(id);
      if (!computer) throw new Error(`Computer ${id} disappeared while starting`);
      if (computer.state === "running") return;
      if (computer.state === "error") throw new Error(`Computer ${id} failed to start${computer.error ? `: ${computer.error.slice(0, 300)}` : ""}`);
      if (Date.now() >= deadline) throw new Error(`Computer ${id} was not running after ${Math.round(this.bootTimeoutMs / 1000)} s (state ${computer.state})`);
      await this.sleep(this.pollMs);
    }
  }

  async submit(environmentId: string, sourceRef: string, prompt: string, context?: JobContext) {
    if (!context?.jobId || !context.baseSha) throw new Error("later.dog Cloud submission needs the job context with its pinned starting commit");
    const mode = setupMode(environmentId);
    const setup = mode === "auto" ? AUTO_SETUP_SCRIPT : mode === "command" ? `set -euo pipefail\n${environmentId.trim()}\n` : "";
    const script = taskScript({ repository: context.repository, sourceRef, baseSha: context.baseSha, maxRunMinutes: this.maxRunMinutes, setup: mode, model: context.model, effort: context.effort });
    const { computers, settings } = this.client();
    const size = context.computerSize ?? this.size;
    let computer: Computer;
    try { computer = await computers.create(`${COMPUTER_PREFIX}${context.jobId}`, size, context.jobId); }
    catch (error) {
      if (error instanceof ComputersApiError && error.httpStatus !== 0 && error.httpStatus < 500) {
        throw new Error(`later.dog's computers service refused a ${size} computer: ${error.message}${error.code === "invalid_size" || error.code === "invalid_request" ? `; deploy a computers service that offers size ${size}, or set computerSize on profile ${this.profile.id}` : ""}`);
      }
      throw new ComputerSubmissionUnknown(`Creating the computer for job ${context.jobId} had an uncertain outcome (${error instanceof Error ? error.message : "unknown error"}).`);
    }
    const id = computer.id;
    try {
      await this.waitRunning(computers, id);
      const state = await computers.exec(id, '[ -d "$HOME/task/launched" ] && echo launched || echo new', 30_000);
      if (state.stdout.trim() !== "launched") {
        await computers.put(id, "task/prompt.md", prompt);
        await computers.put(id, "task/run.sh", script);
        await computers.put(id, "task/activity.mjs", ACTIVITY_SCRIPT);
        await computers.put(id, "task/watch.mjs", WATCH_SCRIPT);
        if (setup) await computers.put(id, "task/setup.sh", setup);
        const env: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: settings.claudeToken, ...(settings.githubToken ? { GH_TOKEN: settings.githubToken } : {}) };
        const launched = await computers.exec(id, launchCommand(Boolean(setup)), 60_000, env);
        if (launched.exitCode === 64) throw new Error("the computers service did not pass the exec env to the command; deploy a computers service whose exec accepts env");
        if (launched.exitCode !== 0 && launched.exitCode !== 66) throw new Error(`launching the task exited ${launched.exitCode ?? "without a code"}`);
      }
    } catch (error) {
      throw new ComputerSubmissionUnknown(`Starting job ${context.jobId} on computer ${id} failed: ${error instanceof Error ? error.message : "unknown error"}.`, id);
    }
    return { taskId: id, taskUrl: "" };
  }

  private failed(id: string, reason: string): "failed" { this.failures.set(id, reason); return "failed"; }

  async inspect(taskId: string): Promise<"running" | "ready" | "failed"> {
    const id = LaterdogCloudAdapter.id(taskId);
    const { computers } = this.client();
    const computer = await computers.get(id);
    if (!computer) return this.failed(id, `Computer ${id} no longer exists, so its job cannot finish or be collected.`);
    if (computer.state === "sleeping") return this.failed(id, `${SLEEPING} Wake computer ${id} to inspect ~/task and ~/work, then delegate again.`);
    if (computer.state === "error") return this.failed(id, `Computer ${id} is in an error state${computer.error ? ` (${computer.error.slice(0, 300)})` : ""}; it was kept for inspection.`);
    if (computer.state !== "running") return "running";
    let result: ExecResult;
    try { result = await computers.exec(id, STATUS_COMMAND, 30_000); }
    catch (error) {
      if (error instanceof ComputersApiError && error.code === "asleep") return this.failed(id, `${SLEEPING} Wake computer ${id} to inspect ~/task and ~/work, then delegate again.`);
      throw error;
    }
    if (result.exitCode !== 0) throw new Error(`Reading job status on computer ${id} exited ${result.exitCode ?? "without a code"}`);
    const [status = "", latest = ""] = result.stdout.replace(/^\s+/, "").split("\n");
    const [word, code, stage] = status.trim().split(/\s+/);
    let lastStep: CloudTaskStep | undefined;
    try { lastStep = cloudTaskStep(JSON.parse(latest)) ?? undefined; } catch { lastStep = undefined; }
    this.progressById.set(id, { ...(word === "running" ? { stage: code } : word === "exit" || word === "vanished" ? { stage: word === "exit" ? stage : code } : {}), ...(lastStep ? { lastStep } : {}) });
    if (word === "running") return "running";
    if (word === "unlaunched") return this.failed(id, `The job was never launched on computer ${id}; delete that computer and delegate again.`);
    if (word === "vanished") return this.failed(id, `The job's process on computer ${id} stopped without recording an exit code during ${code ?? "an unknown stage"}; see ~/task/log on that computer.`);
    if (word === "exit" && code === "0") { this.failures.delete(id); return "ready"; }
    if (word === "exit") {
      const why = code === "124" || code === "137" ? `ran past its ${this.maxRunMinutes}-minute limit` : `exited ${code}`;
      return this.failed(id, `The job ${why} during ${stage ?? "an unknown stage"} on computer ${id}; see ~/task/log and ~/task/out.jsonl on that computer, which was kept for inspection.`);
    }
    throw new Error(`Unrecognized job status on computer ${id}`);
  }

  async collect(taskId: string): Promise<string> {
    const id = LaterdogCloudAdapter.id(taskId);
    const { computers } = this.client();
    const computer = await computers.get(id);
    if (!computer) throw new Error(`Computer ${id} no longer exists; its diff cannot be collected`);
    if (computer.state === "sleeping") await computers.wake(id);
    if (computer.state !== "running") await this.waitRunning(computers, id);
    const result = await computers.exec(id, COLLECT_COMMAND, 300_000);
    if (result.exitCode !== 0) throw new Error(`Writing the diff on computer ${id} exited ${result.exitCode ?? "without a code"}: ${result.stderr.trim().slice(-300)}`);
    const size = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isInteger(size) || size < 0) throw new Error(`Computer ${id} reported an unreadable diff size`);
    if (size > MAX_PATCH_BYTES) throw new Error(`The diff on computer ${id} is ${size} bytes, over the ${MAX_PATCH_BYTES}-byte files limit; the computer was kept with ~/task/patch.diff`);
    const bytes = size === 0 ? Buffer.alloc(0) : await computers.read(id, "task/patch.diff", MAX_PATCH_BYTES);
    if (bytes.length !== size) throw new Error(`The diff read from computer ${id} was ${bytes.length} bytes, not the ${size} it reported`);
    const patch = bytes.toString("utf8");
    try { await computers.remove(id); }
    catch (error) { console.warn(`later.dog Cloud collected job computer ${id} but could not delete it: ${error instanceof Error ? error.message : "unknown error"}`); }
    if (!patch.trim()) return "";
    return patch.endsWith("\n") ? patch : `${patch}\n`;
  }

  progress(taskId: string): { stage?: string; lastStep?: CloudTaskStep } | undefined { return this.progressById.get(taskId); }

  async activity(taskId: string, after: number): Promise<CloudTaskActivityPage> {
    const id = LaterdogCloudAdapter.id(taskId);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("after must be a byte offset");
    const { computers } = this.client();
    const computer = await computers.get(id);
    if (!computer) return { steps: [], cursor: after, live: false, available: false, reason: "This task's computer is gone." };
    if (computer.state !== "running") return { steps: [], cursor: after, live: false, available: false, reason: computer.state === "sleeping" ? "This task's computer is asleep." : `This task's computer is ${computer.state}.` };
    const command = `f="$HOME/task/activity.jsonl"; [ -f "$f" ] || exit 0; tail -c +${after + 1} "$f" | head -c ${MAX_ACTIVITY_PAGE_BYTES}; [ -f "$HOME/task/exit" ] && printf '\n__laterdog_finished__\n' >&2 || true`;
    const result = await computers.exec(id, command, 30_000);
    if (result.exitCode !== 0) throw new Error(`Reading progress on computer ${id} exited ${result.exitCode ?? "without a code"}`);
    const { steps, consumedBytes } = parseCloudTaskSteps(result.stdout);
    return { steps, cursor: after + consumedBytes, live: !result.stderr.includes("__laterdog_finished__"), available: true };
  }

  async transcript(taskId: string): Promise<string> {
    const id = LaterdogCloudAdapter.id(taskId);
    const { computers } = this.client();
    const computer = await computers.get(id);
    if (!computer || computer.state !== "running") return "";
    const size = await computers.exec(id, 'f="$HOME/task/activity.jsonl"; [ -f "$f" ] && wc -c < "$f" || echo 0', 30_000);
    const bytes = Number.parseInt(size.stdout.trim(), 10);
    if (!Number.isInteger(bytes) || bytes <= 0) return "";
    if (bytes > MAX_TRANSCRIPT_BYTES) {
      const tail = await computers.exec(id, `tail -c ${MAX_TRANSCRIPT_BYTES} "$HOME/task/activity.jsonl" > "$HOME/task/activity.tail" && echo ok`, 60_000);
      if (tail.exitCode !== 0) return "";
      const text = (await computers.read(id, "task/activity.tail", MAX_TRANSCRIPT_BYTES)).toString("utf8");
      return text.slice(text.indexOf("\n") + 1);
    }
    return (await computers.read(id, "task/activity.jsonl", MAX_TRANSCRIPT_BYTES)).toString("utf8");
  }

  async trace(taskId: string): Promise<TraceCapture | null> {
    const id = LaterdogCloudAdapter.id(taskId);
    const { computers, settings } = this.client();
    const computer = await computers.get(id);
    if (!computer || computer.state !== "running") return null;
    const report = await computers.exec(id, TRACE_COMMAND, 120_000);
    if (report.exitCode !== 0) throw new Error(`Packing the trace on computer ${id} exited ${report.exitCode ?? "without a code"}: ${report.stderr.trim().slice(-200)}`);
    const parsed = parseTraceReport(report.stdout);
    if (parsed.kind === "none") return null;
    if (parsed.gzipBytes > MAX_TRACE_GZIP_BYTES) throw new Error(`The packed trace on computer ${id} is ${parsed.gzipBytes} bytes, over the ${MAX_TRACE_GZIP_BYTES}-byte limit`);
    const gz = await computers.read(id, "task/trace.jsonl.gz", MAX_TRACE_GZIP_BYTES);
    if (gz.length !== parsed.gzipBytes) throw new Error(`The trace read from computer ${id} was ${gz.length} bytes, not the ${parsed.gzipBytes} it reported`);
    return captureTrace(gz, parsed.truncated, [settings.claudeToken, ...(settings.githubToken ? [settings.githubToken] : [])]);
  }

  async screen(taskId: string): Promise<{ url: string; expiresAt: number | string }> {
    const id = LaterdogCloudAdapter.id(taskId);
    const { computers } = this.client();
    const computer = await computers.get(id);
    if (!computer) throw Object.assign(new Error("This task's computer is gone, so there is no screen to watch."), { status: 409 });
    if (computer.state !== "running") throw Object.assign(new Error(computer.state === "sleeping" ? "This task's computer is asleep." : `This task's computer is ${computer.state}.`), { status: 409 });
    return computers.desktop(id);
  }

  async cancel(taskId: string): Promise<void> {
    const id = LaterdogCloudAdapter.id(taskId);
    const { computers } = this.client();
    await computers.remove(id);
    this.failures.set(id, "Stopped: its computer was deleted.");
  }

  async list(): Promise<unknown> {
    const { computers } = this.client();
    return { tasks: (await computers.list()).filter((computer) => computer.name.startsWith(COMPUTER_PREFIX)).map(({ id, name, state }) => ({ id, name, state })) };
  }
}
