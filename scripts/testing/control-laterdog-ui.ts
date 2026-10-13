import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ControlLaterDogError,
  HELP_UI,
  launchVerificationServer,
  parse,
  runControlLaterDog,
  type VerificationServer,
} from "../control-laterdog.ts";
import {
  closeBrowserSession,
  ensureChrome,
  installAgentBrowserBinary,
  resolveAgentBrowserBinary,
} from "../../server/browser-engine.ts";
import { fixtureApi, mountPreview, type MountedPreview } from "./preview-fixture.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const UI_TOOLS_DIR = join(ROOT, ".laterdog-scratch", "verify-tools");
export const UI_MUTATING = new Set(["click", "type", "press", "flag", "eval"]);

const ENTRIES = {
  threads: { entry: "/scripts/testing/threads-preview.tsx", route: "/__threads.html", title: "Isolated later.dog Chat" },
  settings: { entry: "/src/testing/bot-settings.tsx", route: "/__bot-settings.html", title: "Isolated Bot Settings" },
} as const satisfies Record<string, Parameters<typeof mountPreview>[1]>;
const FAKE_MODES = ["happy", "exit-early", "hang", "malformed", "stream", "not-logged-in", "slow", "background-result", "puppies"];
const SEEDED_BOT = "Pepper";
const PLATFORM_ENV = ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"];
const CHROME_LAYOUTS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: [
    "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  ],
  linux: ["chrome", "chrome-linux64/chrome"],
  win32: ["chrome.exe", "chrome-win64/chrome.exe"],
};
const OUTPUT_LIMIT = 16 * 1024 * 1024;

export interface UiHandle {
  url: string;
  previewUrl: string;
  session: string;
  binary: string;
  home: string;
  botId: string;
  logPath: string;
  chrome: string | null;
}

type SessionEnv = Pick<UiHandle, "home" | "session" | "chrome">;

export function sessionEnv(handle: SessionEnv, parentEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const temp = join(handle.home, "tmp");
  const env: NodeJS.ProcessEnv = {
    HOME: handle.home,
    USERPROFILE: handle.home,
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
    PATH: parentEnv.PATH ?? "",
    AGENT_BROWSER_SESSION: handle.session,
    AGENT_BROWSER_HEADLESS: "1",
    AGENT_BROWSER_NO_WEBMCP: "1",
  };
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value && PLATFORM_ENV.includes(key.toUpperCase())) env[key.toUpperCase()] = value;
  }
  if (handle.chrome) env.AGENT_BROWSER_EXECUTABLE_PATH = handle.chrome;
  return env;
}

export function agentBrowser(
  binary: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  timeoutMs = 30_000,
): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, [...args, "--json"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      fail(new ControlLaterDogError(`could not start agent-browser: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
      if (output.length > OUTPUT_LIMIT) { clearTimeout(timer); child.kill("SIGKILL"); }
    });
    child.stderr?.resume();
    child.on("error", (error) => { clearTimeout(timer); fail(new ControlLaterDogError(`could not start agent-browser: ${error.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        fail(new ControlLaterDogError(`agent-browser ${args[0]} did not finish within ${timeoutMs}ms`, "check the page with `ui screenshot` or `ui console`"));
        return;
      }
      let result: { success?: unknown; data?: unknown; error?: unknown } | null = null;
      try { result = JSON.parse(output); } catch {}
      const data = result?.data;
      if (code === 0 && result?.success === true && data && typeof data === "object" && !Array.isArray(data)) {
        done(data as Record<string, unknown>);
        return;
      }
      const reason = typeof result?.error === "string" ? result.error
        : result?.error && typeof result.error === "object" && typeof (result.error as { message?: unknown }).message === "string"
          ? (result.error as { message: string }).message
          : `exit ${code ?? "by signal"}`;
      fail(new ControlLaterDogError(`agent-browser ${args[0]} failed: ${reason.slice(0, 300)}`, "take a fresh `ui snapshot`; refs change after the page updates"));
    });
  });
}

export function installedChrome(toolsDir = UI_TOOLS_DIR, platform: NodeJS.Platform = process.platform): string | null {
  const browsers = join(toolsDir, ".agent-browser", "browsers");
  let versions: string[];
  try {
    versions = readdirSync(browsers)
      .filter((name) => name.startsWith("chrome-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return null;
  }
  for (const version of versions) {
    for (const layout of CHROME_LAYOUTS[platform] ?? []) {
      const candidate = join(browsers, version, layout);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export async function ensureUiBrowser(
  parentEnv: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = () => {},
  toolsDir = UI_TOOLS_DIR,
): Promise<{ binary: string; chrome: string | null }> {
  mkdirSync(toolsDir, { recursive: true, mode: 0o700 });
  let binary = resolveAgentBrowserBinary({ dataDir: toolsDir, env: parentEnv });
  if (!binary) {
    const started = Date.now();
    binary = await installAgentBrowserBinary({ dataDir: toolsDir, log });
    log(`agent-browser installed at ${binary} in ${Date.now() - started}ms`);
  }
  const explicit = parentEnv.AGENT_BROWSER_EXECUTABLE_PATH?.trim();
  if (explicit) {
    if (!existsSync(explicit)) throw new ControlLaterDogError(`AGENT_BROWSER_EXECUTABLE_PATH does not exist: ${explicit}`, "unset it to use the Chrome agent-browser installs");
    return { binary, chrome: resolve(explicit) };
  }
  let chrome = installedChrome(toolsDir);
  if (!chrome) {
    const started = Date.now();
    await ensureChrome(binary, { env: sessionEnv({ home: toolsDir, session: "laterdog-ui-install", chrome: null }, parentEnv), log });
    log(`Chrome ready in ${Date.now() - started}ms`);
    chrome = installedChrome(toolsDir);
    if (!chrome) log("no Chrome for Testing under the tools directory; the session will use the browser agent-browser finds itself");
  }
  return { binary, chrome };
}

function loadHandle(raw: unknown, verb: string): UiHandle {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ControlLaterDogError(`ui ${verb} requires --ui HANDLE`, "run `ui launch`; it prints the handle path (ui.json inside its data directory)");
  }
  const path = resolve(raw.trim());
  let handle: Partial<UiHandle>;
  try {
    handle = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ControlLaterDogError(`could not read the ui handle ${path}: ${error instanceof Error ? error.message : String(error)}`, "the launch that wrote it may have stopped; run `ui launch` again");
  }
  for (const key of ["url", "previewUrl", "session", "binary", "home", "botId", "logPath"] as const) {
    if (typeof handle[key] !== "string" || !handle[key]) throw new ControlLaterDogError(`the ui handle ${path} lacks ${key}`, "run `ui launch` again and use the handle it prints");
  }
  if (handle.chrome !== null && typeof handle.chrome !== "string") throw new ControlLaterDogError(`the ui handle ${path} has an invalid chrome entry`);
  if (!existsSync(handle.home!)) throw new ControlLaterDogError(`the ui session's data directory is gone: ${handle.home}`, "its launch was stopped; run `ui launch` again");
  return handle as UiHandle;
}

async function requireLiveSession(handle: UiHandle): Promise<void> {
  const data = await agentBrowser(handle.binary, sessionEnv(handle), ["session", "list"], 10_000);
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  if (!sessions.includes(handle.session)) {
    throw new ControlLaterDogError(`the ui session ${handle.session} is not running`, "its launch was stopped or crashed; run `ui launch` again and use the new handle");
  }
}

async function snapshot(handle: UiHandle, interactive: boolean): Promise<Record<string, unknown>> {
  return agentBrowser(handle.binary, sessionEnv(handle), ["snapshot", ...(interactive ? ["-i"] : [])]);
}

const TARGET_WAIT_MS = 5_000;
const SPLASH_GONE = `!document.querySelector('[data-launch-splash="shown"]')`;

async function afterSplash(binary: string, env: NodeJS.ProcessEnv): Promise<void> {
  await agentBrowser(binary, env, ["wait", "--fn", SPLASH_GONE], 30_000);
}

async function resolveTarget(handle: UiHandle, values: Record<string, unknown>, verb: string): Promise<{ target: string; name?: string }> {
  const ref = typeof values.ref === "string" ? values.ref.trim() : "";
  const name = typeof values.name === "string" ? values.name : "";
  if (Boolean(ref) === Boolean(name)) throw new ControlLaterDogError(`ui ${verb} needs exactly one of --ref @eN or --name NAME`);
  if (ref) {
    if (!/^@?e\d+$/.test(ref)) throw new ControlLaterDogError(`--ref must look like @e12, got ${JSON.stringify(ref)}`, "refs come from `ui snapshot`");
    return { target: ref.startsWith("@") ? ref : `@${ref}` };
  }
  const deadline = Date.now() + TARGET_WAIT_MS;
  let matches: Array<[string, { name?: unknown; role?: unknown }]> = [];
  for (;;) {
    const refs = (await snapshot(handle, false)).refs as Record<string, { name?: unknown; role?: unknown }> | undefined;
    matches = Object.entries(refs ?? {}).filter(([, element]) => element?.name === name);
    if (matches.length === 1) return { target: `@${matches[0]![0]}`, name };
    if (matches.length > 1 || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (matches.length === 0) throw new ControlLaterDogError(`no element is named ${JSON.stringify(name)}`, "run `ui snapshot` and use the exact accessible name, or --ref");
  throw new ControlLaterDogError(
    `${matches.length} elements are named ${JSON.stringify(name)}: ${matches.map(([id, element]) => `@${id} (${String(element.role)})`).join(", ")}`,
    "pass --ref to pick one",
  );
}

function parseFlagPatch(raw: unknown): { features: Record<string, boolean | number | string> } {
  const assignments = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
  if (!assignments.length) throw new ControlLaterDogError("ui flag requires --set features.NAME=VALUE", "example: --set features.showToolCalls=true");
  const features: Record<string, boolean | number | string> = {};
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    const path = separator === -1 ? assignment : assignment.slice(0, separator);
    const value = separator === -1 ? "" : assignment.slice(separator + 1);
    const [scope, name, ...rest] = path.split(".");
    if (scope !== "features" || !name || rest.length || !/^[A-Za-z][\w-]*$/.test(name) || separator === -1) {
      throw new ControlLaterDogError(`--set must be features.NAME=VALUE, got ${JSON.stringify(assignment)}`, "example: --set features.showToolCalls=true");
    }
    features[name] = value === "true" ? true : value === "false" ? false : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return { features };
}

const summarizeBots = (bots: Array<Record<string, unknown>>) =>
  bots.map((bot) => ({ id: bot.id, name: bot.name, busy: bot.busy === true,
    waitingForTeammates: bot.waitingForTeammates === true, activity: bot.activity ?? null }));

async function waitSettle(handle: UiHandle, timeoutSeconds: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSeconds * 1_000;
  const remaining = () => Math.max(1, Math.ceil((deadline - Date.now()) / 1_000));
  const api = fixtureApi(handle.url);
  let wait: Record<string, unknown> | undefined;
  let bots: ReturnType<typeof summarizeBots> = [];
  let renderer: Record<string, unknown> = { rendered: false };
  let browser: Record<string, unknown> = { state: "unknown" };
  const state = () => ({ status: "timed-out", bots, renderer, browser, wait });
  for (;;) {
    wait = await runControlLaterDog(["wait", "--bot", handle.botId, "--timeout", String(Math.min(120, remaining())), "--url", handle.url]) as Record<string, unknown>;
    if (wait.status !== "settled") return { ok: false, ...state(), status: wait.status };
    bots = summarizeBots(((await api("GET", "/api/bots?messages=0")) as { bots: Array<Record<string, unknown>> }).bots);
    if (!bots.some((bot) => bot.busy || bot.waitingForTeammates)) break;
    if (Date.now() >= deadline) return { ok: false, ...state() };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const messages = Array.isArray(wait.messages) ? wait.messages as Array<{ id?: unknown; kind?: unknown }> : [];
  const newest = [...messages].reverse().find((message) => message.kind === "text" && typeof message.id === "string");
  const env = sessionEnv(handle);
  try {
    if (newest) {
      await agentBrowser(handle.binary, env, ["wait", "--fn", `!!document.querySelector(${JSON.stringify(`[data-mid=${JSON.stringify(newest.id)}]`)})`], Math.max(1_000, deadline - Date.now()));
      renderer = { rendered: true, lastMessageId: newest.id };
    } else {
      renderer = { rendered: true, lastMessageId: null };
    }
    const idle = await agentBrowser(handle.binary, env, ["wait", "--load", "networkidle"], Math.max(1_000, deadline - Date.now()));
    browser = { state: idle.state ?? "networkidle" };
  } catch (error) {
    return { ok: false, ...state(), error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, status: "settled", bots, renderer, browser, wait };
}

export async function runControlLaterDogUi(args: string[]): Promise<unknown> {
  const [verb = "help", ...rest] = args;
  if (verb === "help" || verb === "--help" || verb === "-h") return HELP_UI;
  if (verb === "launch") {
    throw new ControlLaterDogError("ui launch is available only from the executable CLI", "run `node --experimental-strip-types scripts/control-laterdog.ts ui launch`");
  }
  const command = `ui ${verb}`;
  const ui = { ui: { type: "string" } } as const;

  if (verb === "snapshot") {
    const values = parse(command, rest, { ...ui, interactive: { type: "boolean", default: false } });
    const handle = loadHandle(values.ui, verb);
    await requireLiveSession(handle);
    return { ok: true, ...(await snapshot(handle, values.interactive === true)) };
  }

  if (verb === "click" || verb === "type") {
    const values = parse(command, rest, { ...ui, ref: { type: "string" }, name: { type: "string" }, text: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    const text = verb === "type" ? values.text : undefined;
    if (verb === "type" && typeof text !== "string") throw new ControlLaterDogError("ui type requires --text TEXT");
    await requireLiveSession(handle);
    await afterSplash(handle.binary, sessionEnv(handle));
    const { target, name } = await resolveTarget(handle, values, verb);
    const data = await agentBrowser(handle.binary, sessionEnv(handle), verb === "click" ? ["click", target] : ["type", target, text as string]);
    return { ok: true, target, ...(name ? { name } : {}), ...data };
  }

  if (verb === "press") {
    const values = parse(command, rest, { ...ui, keys: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.keys !== "string" || !values.keys.trim()) throw new ControlLaterDogError("ui press requires --keys KEYS", "example: --keys Enter or --keys Meta+k");
    await requireLiveSession(handle);
    await afterSplash(handle.binary, sessionEnv(handle));
    return { ok: true, ...(await agentBrowser(handle.binary, sessionEnv(handle), ["press", values.keys.trim()])) };
  }

  if (verb === "screenshot") {
    const values = parse(command, rest, { ...ui, out: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.out !== "string" || extname(values.out).toLowerCase() !== ".png") throw new ControlLaterDogError("ui screenshot requires --out PATH.png");
    const out = resolve(values.out);
    mkdirSync(dirname(out), { recursive: true });
    await requireLiveSession(handle);
    await agentBrowser(handle.binary, sessionEnv(handle), ["screenshot", out], 60_000);
    let bytes = 0;
    try { bytes = statSync(out).size; } catch {}
    if (!bytes) throw new ControlLaterDogError(`agent-browser reported a screenshot it did not write: ${out}`);
    return { ok: true, path: out, bytes };
  }

  if (verb === "console") {
    const values = parse(command, rest, ui);
    const handle = loadHandle(values.ui, verb);
    await requireLiveSession(handle);
    return { ok: true, ...(await agentBrowser(handle.binary, sessionEnv(handle), ["console"])) };
  }

  if (verb === "eval") {
    const values = parse(command, rest, { ...ui, js: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    if (typeof values.js !== "string" || !values.js.trim()) throw new ControlLaterDogError("ui eval requires --js CODE");
    await requireLiveSession(handle);
    return { ok: true, ...(await agentBrowser(handle.binary, sessionEnv(handle), ["eval", values.js])) };
  }

  if (verb === "flag") {
    const values = parse(command, rest, { ...ui, set: { type: "string", multiple: true }, "dry-run": { type: "boolean", default: false } });
    const handle = loadHandle(values.ui, verb);
    const patch = parseFlagPatch(values.set);
    if (values["dry-run"] === true) return { ok: true, dryRun: true, url: handle.url, method: "PATCH", path: "/api/config", patch };
    const config = await fixtureApi(handle.url)("PATCH", "/api/config", patch) as Record<string, unknown>;
    return { ok: true, patch, features: config.features ?? null };
  }

  if (verb === "wait-settle") {
    const values = parse(command, rest, { ...ui, timeout: { type: "string" } });
    const handle = loadHandle(values.ui, verb);
    const timeout = values.timeout === undefined ? 30 : Number(values.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) throw new ControlLaterDogError("--timeout must be an integer from 1 to 600");
    await requireLiveSession(handle);
    return waitSettle(handle, timeout);
  }

  throw new ControlLaterDogError(`unknown ui command ${JSON.stringify(verb)}`, "run control-laterdog ui help");
}

function parkUntilSignalOrExit(child: ChildProcess, stopRequested: () => boolean): Promise<"signal" | "exit"> {
  return new Promise((settle) => {
    if (stopRequested()) { settle("signal"); return; }
    const finish = (reason: "signal" | "exit") => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      child.off("close", onExit);
      settle(reason);
    };
    const onSignal = () => finish("signal");
    const onExit = () => finish("exit");
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    child.once("close", onExit);
  });
}

export async function launchUi(
  args: string[],
  parentEnv: NodeJS.ProcessEnv = process.env,
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  fixtureOptions: { boatFixtureApi?: string } = {},
): Promise<void> {
  const values = parse("ui launch", args, { entry: { type: "string" }, "tool-calls": { type: "string" }, mode: { type: "string" } });
  const entryName = typeof values.entry === "string" ? values.entry : "threads";
  if (!Object.hasOwn(ENTRIES, entryName)) {
    throw new ControlLaterDogError(`unknown --entry ${JSON.stringify(entryName)}`, `available entries: ${Object.keys(ENTRIES).join(", ")}`);
  }
  const entry = ENTRIES[entryName as keyof typeof ENTRIES];
  const fakeEnv: NodeJS.ProcessEnv = {};
  if (values["tool-calls"] !== undefined) {
    let calls: unknown;
    try { calls = JSON.parse(String(values["tool-calls"])); } catch { calls = undefined; }
    if (!Array.isArray(calls) || !calls.every((call) => call && typeof call === "object" && typeof (call as { name?: unknown }).name === "string")) {
      throw new ControlLaterDogError("--tool-calls must be a JSON array of {name, input?, ok?}", 'example: --tool-calls \'[{"name":"Bash","input":{"command":"echo hi"},"ok":true}]\'');
    }
    fakeEnv.FAKE_CLAUDE_TOOL_CALLS = JSON.stringify(calls);
  }
  if (values.mode !== undefined) {
    if (!FAKE_MODES.includes(String(values.mode))) throw new ControlLaterDogError(`unknown --mode ${JSON.stringify(values.mode)}`, `fake engine modes: ${FAKE_MODES.join(", ")}`);
    fakeEnv.FAKE_CLAUDE_MODE = String(values.mode);
  }
  const note = (line: string) => io.stderr.write(`ui launch: ${line}\n`);

  let stopRequested = false;
  const startup = new AbortController();
  const requestStop = () => { stopRequested = true; startup.abort(); };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  const checkpoint = () => { if (stopRequested) throw new ControlLaterDogError("ui launch cancelled"); };

  let fixture: VerificationServer | undefined;
  let preview: MountedPreview | undefined;
  let opened: { binary: string; env: NodeJS.ProcessEnv } | undefined;
  try {
    const { binary, chrome } = await ensureUiBrowser(parentEnv, note);
    checkpoint();
    fixture = await launchVerificationServer({ ...parentEnv, ...fakeEnv }, startup.signal, undefined,
      { binaryPath: binary, executablePath: chrome ?? "" }, undefined, undefined, [], fixtureOptions.boatFixtureApi);
    checkpoint();
    const api = fixtureApi(fixture.info.url);
    await api("PATCH", "/api/config", { language: "en" });
    const created = await runControlLaterDog(["new-bot", "--name", SEEDED_BOT, "--url", fixture.info.url]) as { bot: { id: string } };
    checkpoint();
    preview = await mountPreview(fixture, { ...entry, logLevel: "warn" });
    checkpoint();
    const session: SessionEnv = { home: fixture.info.dataDir, session: `laterdog-ui-${new URL(fixture.info.url).port}`, chrome };
    const env = sessionEnv(session, parentEnv);
    opened = { binary, env };
    const previewUrl = preview.previewUrl;
    const open = () => agentBrowser(binary, env, ["open", previewUrl], 120_000);
    await open().catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes("Operation timed out")) throw error;
      note("the first page load timed out while the preview compiled; opening it again");
      return open();
    });
    await afterSplash(binary, env);
    checkpoint();
    const handle: UiHandle = {
      url: fixture.info.url,
      previewUrl: preview.previewUrl,
      session: session.session,
      binary,
      home: fixture.info.dataDir,
      botId: created.bot.id,
      logPath: fixture.info.logPath,
      chrome,
    };
    const handlePath = join(fixture.info.dataDir, "ui.json");
    writeFileSync(handlePath, `${JSON.stringify(handle, null, 2)}\n`, { mode: 0o600 });
    io.stdout.write(`${JSON.stringify({
      ok: true, ui: handlePath, url: handle.url, previewUrl: handle.previewUrl, botId: handle.botId, dataDir: handle.home, logPath: handle.logPath,
    }, null, 2)}\n`);
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    const reason = await parkUntilSignalOrExit(fixture.child, () => stopRequested);
    if (reason === "exit") {
      process.exitCode = 1;
      io.stderr.write(`${JSON.stringify({ ok: false, error: `verification server exited unexpectedly; see ${fixture.info.logPath}` }, null, 2)}\n`);
    }
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
    if (opened) {
      if (!await closeBrowserSession(opened.binary, opened.env)) {
        await agentBrowser(opened.binary, opened.env, ["close"], 15_000).catch(() => {});
      }
    }
    await preview?.close();
    await fixture?.close();
  }
}
