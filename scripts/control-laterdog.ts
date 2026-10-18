#!/usr/bin/env -S node --experimental-strip-types
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { withLocalTools } from "./local-control-token.ts";
import { handleToolCall, request, validateBaseUrl } from "./mcp-server.ts";
import { launchUi, runControlLaterDogUi } from "./testing/control-laterdog-ui.ts";
import { removeTempDir, waitForExit } from "../server/testing/cleanup.ts";
import { freePortBlock } from "../server/testing/ports.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_STARTER_BOT_NAME = "Fixture Starter";
const FAKE_CLI = join(ROOT, "server", "testing", "fake-claude-cli.ts");
const MUTATING = new Set([
  "new-bot", "new-channel", "send", "send-channel", "interrupt", "set-model", "edit",
  "ui click", "ui type", "ui press", "ui flag", "ui eval",
]);

export class ControlLaterDogError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

type ToolCaller = typeof handleToolCall;
type Requester = typeof request;

export interface ControlLaterDogDependencies {
  callTool?: ToolCaller;
  request?: Requester;
  env?: NodeJS.ProcessEnv;
}

export const HELP_UI = `renderer (needs a ui launch handle; every verb takes --ui HANDLE, never discovery):
  node --experimental-strip-types scripts/control-laterdog.ts ui launch [--entry threads] [--tool-calls JSON] [--mode happy]
  ui snapshot --ui HANDLE [--interactive]
  ui click --ui HANDLE (--ref @eN | --name NAME)
  ui type --ui HANDLE (--ref @eN | --name NAME) --text TEXT
  ui press --ui HANDLE --keys KEYS
  ui screenshot --ui HANDLE --out PATH.png
  ui console --ui HANDLE
  ui eval --ui HANDLE --js CODE
  ui flag --ui HANDLE --set features.NAME=VALUE [--dry-run]
  ui wait-settle --ui HANDLE [--timeout 30]
  ui help`;

export const HELP = `control-laterdog — verify a running later.dog instance through its shared MCP core

read-only:
  doctor [--url URL]
  bots [--url URL]
  channels [--url URL]
  models [--url URL]
  messages --bot ID [--task ID] [--limit 30] [--url URL]
  messages --channel ID [--task ID] [--limit 30] [--url URL]
  wait --bot ID [--task ID] [--timeout 30] [--url URL]
  wait --channel ID [--task ID] [--timeout 30] [--url URL]

mutating (an explicit --url or LATERDOG_URL/LATERDOG_SERVER_PORT is required):
  new-bot --name NAME [--url URL]
  new-channel --name NAME --members ID,ID [--url URL]
  send --bot ID --text TEXT [--task ID] [--dry-run] [--url URL]
  send-channel --channel ID --text TEXT [--task ID] [--dry-run] [--url URL]
  interrupt --bot ID [--task ID] [--dry-run] [--url URL]
  interrupt --channel ID [--task ID] [--dry-run] [--url URL]
  edit --bot ID --message ID --text TEXT [--task ID] [--dry-run] [--url URL]
  set-model --bot ID --instance ID --model ID [--task ID] [--effort LEVEL] [--dry-run] [--url URL]

${HELP_UI}

isolated fixture:
  node --experimental-strip-types scripts/control-laterdog.ts launch

Output is JSON. launch and ui launch own a temporary fake-engine server until interrupted.`;

const commonOptions = {
  url: { type: "string" },
} satisfies ParseArgsOptionsConfig;

export function parse(
  command: string,
  args: string[],
  options: ParseArgsOptionsConfig = {},
): Record<string, unknown> & { url?: string } {
  try {
    return parseArgs({
      args,
      options: { ...commonOptions, ...options },
      strict: true,
      allowPositionals: false,
    }).values as Record<string, unknown> & { url?: string };
  } catch (error) {
    throw new ControlLaterDogError(
      error instanceof Error ? error.message : String(error),
      `run control-laterdog help for the ${command} syntax`,
    );
  }
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ControlLaterDogError(`${name} is required`);
  return value.trim();
}

function positiveInteger(value: unknown, name: string, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new ControlLaterDogError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function configuredUrl(raw: unknown, env: NodeJS.ProcessEnv, requiredForMutation: boolean): string | undefined {
  const explicit = typeof raw === "string" && raw.trim()
    ? raw.trim()
    : env.LATERDOG_URL?.trim() || (env.LATERDOG_SERVER_PORT ? `http://127.0.0.1:${env.LATERDOG_SERVER_PORT}` : "");
  if (!explicit) {
    if (requiredForMutation) {
      throw new ControlLaterDogError(
        "mutating commands require an explicit later.dog instance",
        "start `control-laterdog launch`, then pass its URL with --url",
      );
    }
    return undefined;
  }
  return validateBaseUrl(explicit);
}

function target(values: Record<string, unknown>): { type: "bot" | "channel"; id: string } {
  const bot = typeof values.bot === "string" ? values.bot.trim() : "";
  const channel = typeof values.channel === "string" ? values.channel.trim() : "";
  if (Boolean(bot) === Boolean(channel)) {
    throw new ControlLaterDogError("provide exactly one of --bot ID or --channel ID");
  }
  return bot ? { type: "bot", id: bot } : { type: "channel", id: channel };
}

function dryRun(command: string, values: Record<string, unknown>, tool: string, args: Record<string, unknown>) {
  return values["dry-run"] === true ? { ok: true, dryRun: true, command, tool, arguments: args } : null;
}

export async function runControlLaterDog(
  argv: string[],
  dependencies: ControlLaterDogDependencies = {},
): Promise<unknown> {
  const [command = "help", ...args] = argv;
  if (command === "help" || command === "--help" || command === "-h") return HELP;
  if (command === "launch") throw new ControlLaterDogError("launch is available only from the executable CLI");
  if (command === "ui") return runControlLaterDogUi(args);

  const env = dependencies.env ?? process.env;
  const callTool = dependencies.callTool ?? handleToolCall;
  const requester = dependencies.request ?? request;
  const mutation = MUTATING.has(command);
  const call = async (tool: string, input: Record<string, unknown>, rawUrl: unknown) => {
    const url = configuredUrl(rawUrl, env, mutation);
    const fetcher = url
      ? (path: string, options: RequestInit = {}) => requester(path, withLocalTools(options, url, env), url)
      : requester;
    return callTool(tool, input, fetcher);
  };

  if (command === "doctor") {
    const values = parse(command, args);
    const endpoint = configuredUrl(values.url, env, false);
    const [rawHealth, models] = await Promise.all([
      call("get_system_health", {}, values.url),
      call("list_available_models", {}, values.url),
    ]);
    const health = rawHealth as { status: string; endpoint?: string; app: string; packaged: boolean };
    const instances = (models as { instances?: Array<{ instanceId?: string; snapshot?: { state?: string } }> }).instances ?? [];
    return {
      ok: health.app === "laterdog"
        && instances.some((instance) => instance.snapshot?.state === "available"),
      health: endpoint ? { ...health, endpoint } : health,
      availableEngines: instances
        .filter((instance) => instance.snapshot?.state === "available")
        .map((instance) => instance.instanceId),
      instances,
    };
  }

  if (command === "bots" || command === "channels" || command === "models") {
    const values = parse(command, args);
    const tool = command === "bots" ? "list_bots" : command === "channels" ? "list_channels" : "list_available_models";
    return call(tool, {}, values.url);
  }

  if (command === "new-bot") {
    const values = parse(command, args, {
      name: { type: "string" },
      title: { type: "string" },
      section: { type: "string" },
    });
    return call("create_bot", {
      name: required(values.name, "--name"),
      ...(values.title ? { title: values.title } : {}),
      ...(values.section ? { section: values.section } : {}),
    }, values.url);
  }

  if (command === "new-channel") {
    const values = parse(command, args, {
      name: { type: "string" },
      members: { type: "string" },
      section: { type: "string" },
    });
    const memberIds = required(values.members, "--members").split(",").map((id) => id.trim()).filter(Boolean);
    if (!memberIds.length || new Set(memberIds).size !== memberIds.length) {
      throw new ControlLaterDogError("--members must contain unique comma-separated bot IDs");
    }
    return call("create_channel", {
      name: required(values.name, "--name"),
      member_ids: memberIds,
      ...(values.section ? { section: values.section } : {}),
    }, values.url);
  }

  if (command === "send" || command === "send-channel") {
    const values = parse(command, args, {
      bot: { type: "string" },
      channel: { type: "string" },
      text: { type: "string" },
      task: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    });
    const expected = command === "send" ? "bot" : "channel";
    const destination = target(values);
    if (destination.type !== expected) throw new ControlLaterDogError(`${command} requires --${expected} ID`);
    const tool = expected === "bot" ? "send_bot_message" : "send_channel_message";
    const input = {
      [`${expected}_id`]: destination.id,
      text: required(values.text, "--text"),
      ...(values.task !== undefined ? { task_id: required(values.task, "--task") } : {}),
    };
    return dryRun(command, values, tool, input) ?? call(tool, input, values.url);
  }

  if (command === "edit") {
    const values = parse(command, args, {
      bot: { type: "string" }, message: { type: "string" }, text: { type: "string" },
      task: { type: "string" }, "dry-run": { type: "boolean", default: false },
    });
    const input = {
      bot_id: required(values.bot, "--bot"),
      message_id: required(values.message, "--message"),
      text: required(values.text, "--text"),
      ...(values.task !== undefined ? { task_id: required(values.task, "--task") } : {}),
    };
    return dryRun(command, values, "edit_bot_message", input) ?? call("edit_bot_message", input, values.url);
  }

  if (command === "set-model") {
    const values = parse(command, args, {
      bot: { type: "string" }, task: { type: "string" }, instance: { type: "string" },
      model: { type: "string" }, effort: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    });
    const input = {
      bot_id: required(values.bot, "--bot"),
      instance_id: required(values.instance, "--instance"),
      model: required(values.model, "--model"),
      ...(values.task !== undefined ? { task_id: required(values.task, "--task") } : {}),
      ...(values.effort !== undefined ? { effort: required(values.effort, "--effort") } : {}),
    };
    return dryRun(command, values, "set_bot_model", input) ?? call("set_bot_model", input, values.url);
  }

  if (command === "wait" || command === "messages" || command === "interrupt") {
    const values = parse(command, args, {
      bot: { type: "string" },
      channel: { type: "string" },
      task: { type: "string" },
      timeout: { type: "string" },
      limit: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    });
    const destination = target(values);
    const pinned = values.task !== undefined ? { task_id: required(values.task, "--task") } : {};
    if (command === "wait") {
      return call("wait_for_conversation", {
        target_type: destination.type,
        target_id: destination.id,
        ...pinned,
        timeout_seconds: positiveInteger(values.timeout, "--timeout", 30, 120),
      }, values.url);
    }
    if (command === "messages") {
      const tool = destination.type === "bot" ? "get_bot_messages" : "get_channel_messages";
      return call(tool, {
        [`${destination.type}_id`]: destination.id,
        ...pinned,
        limit: positiveInteger(values.limit, "--limit", 30, 200),
      }, values.url);
    }
    const tool = "interrupt_conversation";
    const input = { target_type: destination.type, target_id: destination.id, ...pinned };
    return dryRun(command, values, tool, input) ?? call(tool, input, values.url);
  }

  throw new ControlLaterDogError(`unknown command ${JSON.stringify(command)}`, "run control-laterdog help");
}

export interface VerificationServer {
  info: { url: string; pid: number; dataDir: string; logPath: string };
  fixtureDumpPath: string;
  child: ChildProcess;
  close(): Promise<void>;
}

export function verificationServerEnvironment(parentEnv: NodeJS.ProcessEnv, dataDir: string, port: number): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  const platformKeys = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]);
  for (const [key, value] of Object.entries(parentEnv)) {
    const normalized = key.toUpperCase();
    if (value && platformKeys.has(normalized)) childEnv[normalized] = value;
  }
  const fixtureTemp = join(dataDir, "tmp");
  Object.assign(childEnv, {
    HOME: dataDir,
    USERPROFILE: dataDir,
    APPDATA: join(dataDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(dataDir, "AppData", "Local"),
    XDG_CONFIG_HOME: join(dataDir, ".config"),
    XDG_CACHE_HOME: join(dataDir, ".cache"),
    XDG_DATA_HOME: join(dataDir, ".local", "share"),
    TEMP: fixtureTemp,
    TMP: fixtureTemp,
    TMPDIR: fixtureTemp,
    HERMES_HOME: join(dataDir, ".hermes"),
    LATERDOG_HOME: dataDir,
    LATERDOG_SERVER_PORT: String(port),
    LATERDOG_WEBHOOK_PORT: String(port + 1),
    FAKE_CLAUDE_MODE: parentEnv.FAKE_CLAUDE_MODE || "happy",
    FAKE_CLAUDE_DUMP: join(dataDir, "fake-claude-dump.json"),
    PATH: dirname(process.execPath),
    LATERDOG_TEST_SEALED_PATH: "1",
    LATERDOG_TRIAL_API: parentEnv.LATERDOG_TRIAL_API || "off",
  });
  for (const [key, value] of Object.entries(parentEnv)) {
    if (key.startsWith("FAKE_CLAUDE_") && key !== "FAKE_CLAUDE_DUMP" && value) childEnv[key] = value;
  }
  if (parentEnv.LATERDOG_TEST_ORG_LIBRARY_KEY) childEnv.LATERDOG_TEST_ORG_LIBRARY_KEY = parentEnv.LATERDOG_TEST_ORG_LIBRARY_KEY;
  const liveUrl = parentEnv.LATERDOG_OPENAI_LIVE_URL?.trim() ?? "";
  if (/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(liveUrl)) {
    childEnv.LATERDOG_OPENAI_LIVE_URL = liveUrl;
    if (parentEnv.LATERDOG_OPENAI_LIVE_KEY) childEnv.LATERDOG_OPENAI_LIVE_KEY = parentEnv.LATERDOG_OPENAI_LIVE_KEY;
  }
  if (parentEnv.LATERDOG_TEST_DESKTOP_OWNER_TOKEN) {
    childEnv.LATERDOG_TEST_DESKTOP_OWNER_TOKEN = parentEnv.LATERDOG_TEST_DESKTOP_OWNER_TOKEN;
    if (parentEnv.LATERDOG_TEST_LOCAL_TOOLS_TOKEN) childEnv.LATERDOG_TEST_LOCAL_TOOLS_TOKEN = parentEnv.LATERDOG_TEST_LOCAL_TOOLS_TOKEN;
    childEnv.LATERDOG_DESKTOP_PARENT = "1";
  }
  return childEnv;
}

export async function launchVerificationServer(
  parentEnv: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
  localVm?: { binDir: string; host: string; sshKey: string; staticDir: string },
  browser?: { binaryPath: string; executablePath: string },
  enterprise?: { dir: string; licenseKey: string },
  room?: { scripted: boolean },
  extraProviders: Array<"codex"> = [],
  boatFixtureApi?: string,
  laterdogFixture?: { origin: string; token: string; wakeupPullMs?: number },
): Promise<VerificationServer> {
  if (laterdogFixture && (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(laterdogFixture.origin) || laterdogFixture.token.length < 32)) throw new ControlLaterDogError("later.dog verification requires an explicit owned loopback supervisor and fixture token");
  if (boatFixtureApi) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(boatFixtureApi)) {
      throw new ControlLaterDogError("Boat verification requires an explicit loopback HTTP provider");
    }
    try { new URL(boatFixtureApi); }
    catch { throw new ControlLaterDogError("Boat verification requires a valid loopback port"); }
  }
  if (localVm) {
    const endpoint = new URL(localVm.host);
    if (endpoint.protocol !== "ssh:" || endpoint.hostname !== "127.0.0.1" || endpoint.password) {
      throw new ControlLaterDogError("Local VM verification requires an explicit loopback Podman machine");
    }
  }
  const port = await freePortBlock([0, 1]);
  if (signal?.aborted) throw new ControlLaterDogError("verification launch cancelled");
  const url = `http://127.0.0.1:${port}`;
  const dataDir = mkdtempSync(join(browser && process.platform !== "win32" ? "/tmp" : tmpdir(), "laterdog-verify-data-"));
  const fixtureTemp = join(dataDir, "tmp");
  const fixtureDumpPath = join(dataDir, "fake-claude-dump.json");
  mkdirSync(fixtureTemp, { recursive: true });
  const evidenceDir = join(tmpdir(), "laterdog-verification-evidence");
  mkdirSync(evidenceDir, { recursive: true });
  const logPath = join(evidenceDir, `server-${Date.now()}-${process.pid}.log`);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({
    ...(boatFixtureApi ? { box: { token: "box_verification_fixture" } } : {}),
    instances: {
      ...(extraProviders.includes("codex") ? { codex: {
        driver: "codex", displayName: "Verification Codex", config: { cli: fileURLToPath(new URL("../server/testing/fake-codex-app-server.ts", import.meta.url)) },
      } } : {}),
      claude: {
        driver: "claudeAgent",
        displayName: "Verification fixture",
        config: { cli: FAKE_CLI },
        ...(room?.scripted ? { environment: { FAKE_CLAUDE_ROOM_PLAN: join(dataDir, "room-plan.json") } } : {}),
      },
    },
  }, null, 2));

  const log = openSync(logPath, "a", 0o600);
  const childEnv = verificationServerEnvironment(parentEnv, dataDir, port);
  if (localVm) Object.assign(childEnv, {
    LATERDOG_EXTRA_PATH: [localVm.binDir, ...(process.platform === "win32" ? [join(childEnv.SYSTEMROOT || "C:\\Windows", "System32")] : [])].join(delimiter),
    CONTAINER_HOST: localVm.host,
    CONTAINER_SSHKEY: localVm.sshKey,
    LATERDOG_STATIC_DIR: localVm.staticDir,
  });
  if (enterprise) Object.assign(childEnv, { LATERDOG_ENTERPRISE_DIR: enterprise.dir, LATERDOG_LICENSE_KEY: enterprise.licenseKey });
  if (browser) Object.assign(childEnv, {
    LATERDOG_AGENT_BROWSER_PATH: browser.binaryPath,
    AGENT_BROWSER_EXECUTABLE_PATH: browser.executablePath,
  });
  if (boatFixtureApi) childEnv.LATERDOG_BOX_API = boatFixtureApi;
  if (laterdogFixture) Object.assign(childEnv,{ LATERDOG_SUPERVISOR_URL: laterdogFixture.origin, LATERDOG_TOKEN: laterdogFixture.token,
    ...(laterdogFixture.wakeupPullMs === undefined ? {} : { LATERDOG_WAKEUP_PULL_MS: String(laterdogFixture.wakeupPullMs) }) });
  const serverArgs = ["--experimental-strip-types"];
  if (childEnv.LATERDOG_TEST_DESKTOP_OWNER_TOKEN) {
    serverArgs.push("--import", pathToFileURL(join(ROOT, "server", "testing", "desktop-parent.mjs")).href);
  }
  serverArgs.push(join(ROOT, "server", "index.ts"));
  const child = spawn(process.execPath, serverArgs, {
    cwd: ROOT,
    env: childEnv,
    stdio: ["ignore", log, log],
  });
  closeSync(log);

  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      if (signal?.aborted) throw new ControlLaterDogError("verification launch cancelled");
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`verification server exited before it was ready; see ${logPath}`);
      }
      try {
        const timeout = AbortSignal.timeout(1_000);
        const response = await fetch(`${url}/api/health`, {
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const body = response.ok ? await response.json() as { app?: string } : null;
        if (body?.app === "laterdog") break;
      } catch {}
      if (Date.now() >= deadline) throw new Error(`verification server did not become ready; see ${logPath}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  } catch (error) {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    throw error;
  }

  try {
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const list = await fetch(`${url}/api/bots`, {
      headers: { origin: url },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const body = list.ok ? await list.json() as { bots?: Array<{ id: string }> } : null;
    const seeded = body?.bots;
    if (!Array.isArray(seeded) || seeded.length !== 1) {
      throw new Error(`verification fixture did not seed exactly one starter bot; see ${logPath}`);
    }
    const renameTimeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    const rename = await fetch(`${url}/api/bots/${seeded[0].id}/profile`, {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ name: FIXTURE_STARTER_BOT_NAME }),
      signal: signal ? AbortSignal.any([signal, renameTimeout]) : renameTimeout,
    });
    if (!rename.ok) throw new Error(`verification starter rename failed (${rename.status}); see ${logPath}`);
  } catch (error) {
    await waitForExit(child, { signal: "SIGTERM" });
    await removeTempDir(dataDir);
    throw error;
  }

  let closed = false;
  return {
    info: { url, pid: child.pid!, dataDir, logPath },
    fixtureDumpPath,
    child,
    async close() {
      if (closed) return;
      closed = true;
      await waitForExit(child, { signal: "SIGTERM" });
      await removeTempDir(dataDir);
    },
  };
}

export function controlResultSucceeded(command: string, result: unknown): boolean {
  if (command === "doctor") return (result as { ok?: unknown })?.ok === true;
  if (command === "wait") return (result as { status?: unknown })?.status === "settled";
  if (command === "ui") return (result as { ok?: unknown })?.ok !== false;
  return true;
}

function requireForegroundTerminal(command: string): void {
  if (process.env.npm_lifecycle_event === "control:laterdog") {
    throw new ControlLaterDogError(
      `${command} must own the terminal directly so Ctrl-C can clean up its children`,
      `run \`node --experimental-strip-types scripts/control-laterdog.ts ${command}\``,
    );
  }
}

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "ui" && process.argv[3] === "launch") {
    requireForegroundTerminal("ui launch");
    await launchUi(process.argv.slice(4));
    return;
  }
  if (command === "launch") {
    requireForegroundTerminal("launch");
    const startup = new AbortController();
    const cancelStartup = () => startup.abort();
    process.once("SIGINT", cancelStartup);
    process.once("SIGTERM", cancelStartup);
    let session: VerificationServer;
    try {
      session = await launchVerificationServer(process.env, startup.signal);
    } finally {
      process.removeListener("SIGINT", cancelStartup);
      process.removeListener("SIGTERM", cancelStartup);
    }
    process.stdout.write(`${JSON.stringify({ ok: true, ...session.info }, null, 2)}\n`);
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        void session.close().finally(resolve);
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      session.child.once("close", () => {
        if (!stopping) {
          stopping = true;
          process.exitCode = 1;
          process.stderr.write(`${JSON.stringify({
            ok: false,
            error: `verification server exited unexpectedly; see ${session.info.logPath}`,
          }, null, 2)}\n`);
          void removeTempDir(session.info.dataDir).finally(resolve);
        }
      });
    });
    return;
  }
  const result = await runControlLaterDog(process.argv.slice(2));
  process.stdout.write(typeof result === "string" ? `${result}\n` : `${JSON.stringify(result, null, 2)}\n`);
  if (!controlResultSucceeded(command, result)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const failure = error instanceof ControlLaterDogError
      ? { ok: false, error: error.message, ...(error.hint ? { hint: error.hint } : {}) }
      : { ok: false, error: error instanceof Error ? error.message : String(error) };
    process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
    process.exitCode = 1;
  });
}
