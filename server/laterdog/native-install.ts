import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DATA_DIR, stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath, registerPathDir, resetPathCache } from "../env-path.ts";
import { spawnCli } from "../procs.ts";

export const CLAUDE_INSTALL_SCRIPT = "https://claude.ai/install.sh";
export const CODEX_LATEST_RELEASE = "https://api.github.com/repos/openai/codex/releases/latest";

export type NativeInstall =
  | { kind: "claude-script" }
  | { kind: "codex-release"; asset: string };

export function nativeInstallFor(cli: string | undefined, platform: NodeJS.Platform = process.platform, arch: string = process.arch): NativeInstall | null {
  if (platform !== "darwin") return null;
  if (cli === "claude") return { kind: "claude-script" };
  if (cli === "codex") return { kind: "codex-release", asset: `codex-${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz` };
  return null;
}

export function nativeBinDir(baseDir = DATA_DIR): string {
  return join(baseDir, "tools", "native", "bin");
}

export function registerNativeBinDir(baseDir = DATA_DIR): void {
  registerPathDir(nativeBinDir(baseDir));
}

export interface RunResult { code: number | null; output: string }

export interface NativeDeps {
  fetch: typeof fetch;
  run: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number }) => Promise<RunResult>;
}

const TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 64 * 1024;

export const defaultNativeDeps: NativeDeps = {
  fetch: (input, init) => fetch(input, init),
  run: (command, args, { env, cwd, timeoutMs }) => new Promise((resolveRun, rejectRun) => {
    const child = spawnCli(command, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer) => { if (output.length < MAX_OUTPUT) output += chunk.toString("utf8").slice(0, MAX_OUTPUT - output.length); };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => { child.kill("SIGKILL"); rejectRun(new Error("The install took too long. Check the internet connection and try again.")); }, timeoutMs);
    timer.unref();
    child.once("error", (error) => { clearTimeout(timer); rejectRun(error); });
    child.once("close", (code) => { clearTimeout(timer); resolveRun({ code, output }); });
  }),
};

function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, PATH: augmentedPath(), NO_COLOR: "1" };
  stripWorkspaceCredentialEnv(next as Record<string, string | undefined>);
  return next;
}

function lastLines(output: string): string {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-4);
  return lines.length ? ` ${lines.join(" ").slice(-300)}` : "";
}

async function installClaude(deps: NativeDeps, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const response = await deps.fetch(CLAUDE_INSTALL_SCRIPT, { redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Claude's installer could not be downloaded (HTTP ${response.status}).`);
  const script = await response.text();
  if (!script.startsWith("#!")) throw new Error("Claude's installer did not look like an install script, so it was not run.");
  const dir = mkdtempSync(join(tmpdir(), "laterdog-claude-"));
  try {
    const file = join(dir, "install.sh");
    writeFileSync(file, script, { mode: 0o700 });
    const result = await deps.run("/bin/bash", [file], { env, cwd: dir, timeoutMs });
    if (result.code !== 0) throw new Error(`Claude could not be installed.${lastLines(result.output)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function installCodex(asset: string, baseDir: string, deps: NativeDeps, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<void> {
  const releaseResponse = await deps.fetch(CODEX_LATEST_RELEASE, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(60_000) });
  if (!releaseResponse.ok) throw new Error(`ChatGPT's app could not be found on GitHub (HTTP ${releaseResponse.status}).`);
  const release = (await releaseResponse.json()) as { assets?: Array<{ name?: string; browser_download_url?: string; digest?: string | null }> };
  const found = release.assets?.find((candidate) => candidate.name === asset);
  const expected = found?.digest?.startsWith("sha256:") ? found.digest.slice(7).toLowerCase() : null;
  if (!found?.browser_download_url || !expected) throw new Error("ChatGPT's app has no verified download for this Mac yet.");
  const dir = mkdtempSync(join(tmpdir(), "laterdog-codex-"));
  try {
    const archive = join(dir, asset);
    const download = await deps.fetch(found.browser_download_url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!download.ok || !download.body) throw new Error(`ChatGPT's app could not be downloaded (HTTP ${download.status}).`);
    const hash = createHash("sha256");
    const body = Readable.fromWeb(download.body as import("node:stream/web").ReadableStream<Uint8Array>);
    body.on("data", (chunk: Buffer) => hash.update(chunk));
    await pipeline(body, createWriteStream(archive));
    if (hash.digest("hex") !== expected) throw new Error("ChatGPT's app download did not match its published checksum, so it was not installed.");
    const unpacked = join(dir, "unpacked");
    mkdirSync(unpacked);
    const tar = await deps.run("/usr/bin/tar", ["-xzf", archive, "-C", unpacked], { env, cwd: dir, timeoutMs });
    if (tar.code !== 0) throw new Error(`ChatGPT's app could not be unpacked.${lastLines(tar.output)}`);
    const binary = readdirSync(unpacked).find((name) => name.startsWith("codex") && statSync(join(unpacked, name)).isFile());
    if (!binary) throw new Error("ChatGPT's app download did not contain the codex program.");
    const bin = nativeBinDir(baseDir);
    mkdirSync(bin, { recursive: true });
    const target = join(bin, "codex");
    renameSync(join(unpacked, binary), target);
    chmodSync(target, 0o755);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const running = new Map<string, Promise<void>>();

export function installNative(install: NativeInstall, options: { baseDir?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; deps?: NativeDeps } = {}): Promise<void> {
  const baseDir = options.baseDir ?? DATA_DIR;
  const key = `${baseDir} ${install.kind}`;
  const existing = running.get(key);
  if (existing) return existing;
  const deps = options.deps ?? defaultNativeDeps;
  const env = installEnv(options.env ?? process.env);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const run = (install.kind === "claude-script" ? installClaude(deps, env, timeoutMs) : installCodex(install.asset, baseDir, deps, env, timeoutMs))
    .then(() => {
      registerNativeBinDir(baseDir);
      resetPathCache();
    })
    .finally(() => running.delete(key));
  running.set(key, run);
  return run;
}
