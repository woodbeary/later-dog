import { guestCliPreparation } from "./guest-cli-runtime.ts";
import { GUEST_FOLDER_HELPER } from "./engine-folder-process.ts";
import { pinnedFolderHelper } from "./engine-folder-helper-source.ts";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import type WebSocket from "ws";
import { SERVER_ROOT } from "../proxy-paths.ts";
import type { EngineLink } from "./engine-remote.ts";
import { CODEX_GUARD_REQUIREMENTS, CODEX_MANAGED_HOOKS } from "./codex-computer-guard.ts";
import { REMOTE_ENGINE_BASE, type ClaudeRemotePlan } from "./engine-placement.ts";

export interface EngineScripts { files: Array<{ name: string; bytes: Buffer }>; dir: string; relay: string; proxy: string }
const scripts = new Map<boolean, EngineScripts>();

export function engineScripts(provider = false): EngineScripts {
  const cached = scripts.get(provider);
  if (cached) return cached;
  const packaged = !existsSync(join(SERVER_ROOT, "laterdog", "engine-relay.ts"));
  const dist = packaged ? SERVER_ROOT : join(SERVER_ROOT, "..", "dist-server");
  const entries = ["laterdog/engine-relay", "laterdog/engine-proxy", ...(provider ? ["laterdog/provider-guest", "mcp-gate"] : [])];
  const sourceLoader = createRequire(import.meta.url);
  const files = entries.map(entry => {
    const name = entry.split("/").at(-1)! + (entry === "laterdog/provider-guest" ? ".mjs" : ".js");
    const output = join(dist, entry + ".js");
    if (packaged || existsSync(output)) return { name, bytes: readFileSync(output) };
    const esbuild: typeof import("esbuild") = sourceLoader("esbuild");
    const built = esbuild.buildSync({
      entryPoints: [join(SERVER_ROOT, entry + ".ts")], write: false, bundle: true, platform: "node", target: "node24", format: "esm",
      alias: { yaml: join(dirname(sourceLoader.resolve("yaml/package.json")), "browser", "index.js") },
      banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    });
    return { name, bytes: Buffer.from(built.outputFiles[0].contents) };
  });
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.name).update("\0").update(file.bytes);
  const dir = `${REMOTE_ENGINE_BASE}/relay/${hash.digest("hex").slice(0, 16)}`;
  const result = { files, dir, relay: `${dir}/${files[0].name}`, proxy: `${dir}/${files[1].name}` };
  scripts.set(provider, result);
  return result;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface EngineBox {
  computerId?: string;
  exec(command: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  write(path: string, bytes: Uint8Array): Promise<unknown>;
}

let bundledFolderHelper: Buffer | undefined;
function builtFolderHelper(): Buffer {
  if (!bundledFolderHelper) {
    const source = join(SERVER_ROOT, "laterdog", "engine-folder-cli.ts");
    const built = existsSync(source) ? join(SERVER_ROOT, "..", "dist-server", "laterdog", "engine-folder-cli.js") : join(SERVER_ROOT, "laterdog", "engine-folder-cli.js");
    bundledFolderHelper = existsSync(built) ? readFileSync(built) : Buffer.from(createRequire(import.meta.url)("esbuild").buildSync({entryPoints:[source],write:false,bundle:true,platform:"node",target:"node24",format:"esm"}).outputFiles[0].contents);
  }
  return bundledFolderHelper;
}

export async function prepareEngineFolderTools(box: EngineBox, folders: readonly { path: string }[] = []): Promise<void> {
  if (folders.length) {
    const script = "import os,sys,pwd,stat; from pathlib import Path\n" +
      "user=pwd.getpwnam('dog')\n" +
      "for path in map(Path,sys.argv[1:]):\n" +
      " for parent in [*reversed(path.parents),path]:\n" +
      "  try: s=parent.lstat()\n" +
      "  except FileNotFoundError:\n" +
      "   try: parent.mkdir(mode=0o700);os.chown(parent,user.pw_uid,user.pw_gid)\n" +
      "   except FileExistsError: pass\n" +
      "   s=parent.lstat()\n" +
      "  if not stat.S_ISDIR(s.st_mode): raise ValueError('Working folder path is not a physical directory')";
    const made = await box.exec("sudo -n python3 -c " + quote(script) + " " + folders.map(folder=>quote(folder.path)).join(" "), ENGINE_STEP_BUDGET_MS);
    if (made.exitCode !== 0) throw new Error("The assigned guest working folder could not be safely prepared");
  }
  const helper = pinnedFolderHelper() ?? builtFolderHelper();
  const checksum = createHash("sha256").update(helper).digest("hex");
  const dir = dirname(GUEST_FOLDER_HELPER);
  const ready = await box.exec(`umask 077; mkdir -p ${quote(dir)} && test -f ${quote(GUEST_FOLDER_HELPER)} && test "$(sha256sum ${quote(GUEST_FOLDER_HELPER)} | cut -d' ' -f1)" = ${quote(checksum)}`, ENGINE_STEP_BUDGET_MS);
  if (ready.exitCode === 0) return;
  const tmp = `${dir}/install-${randomUUID()}.mjs`;
  await box.write(tmp, helper);
  const installed = await box.exec(`set -e; trap 'rm -f ${tmp}' EXIT; test "$(sha256sum ${quote(tmp)} | cut -d' ' -f1)" = ${quote(checksum)}; chmod 600 ${quote(tmp)}; mv -f ${quote(tmp)} ${quote(GUEST_FOLDER_HELPER)}`, ENGINE_STEP_BUDGET_MS);
  if (installed.exitCode !== 0) throw new Error("Could not install the guest working folder synchronizer");
}

export function guestWorkFolderCommand(action:"hydrate"|"checkpoint", path:string) {
  return `exec node ${quote(GUEST_FOLDER_HELPER)} ${action} ${quote(path)}`;
}

export const ENGINE_STEP_BUDGET_MS = 60_000;
export const ENGINE_INSTALL_BUDGET_MS = 10 * 60_000;
export const ENGINE_PREPARE_BUDGET_MS = ENGINE_INSTALL_BUDGET_MS + 2 * ENGINE_STEP_BUDGET_MS;
const CLI_NOT_INSTALLED = 41;
const FOLDERS_NOT_MADE = 42;
const RELAY_PRESENT = "relay-present";

export function prepareScript(plan: ClaudeRemotePlan, relay: EngineScripts): string {
  const codex = plan.cli.name === "@openai/codex";
  const binary = codex ? "codex" : "claude";
  const cliDir = `${REMOTE_ENGINE_BASE}/cli/${codex ? "codex" : "claude-code"}-${plan.cli.version}`;
  const cli = quote(`${cliDir}/node_modules/.bin/${binary}`);
  const pnpm = `corepack pnpm@10.33.0 --dir ${quote(cliDir)}`;
  const install = `${pnpm} add --save-exact --ignore-workspace --allow-build=${quote(plan.cli.name)} ${quote(`${plan.cli.name}@${plan.cli.version}`)}`;
  const expectedVersion = quote(codex ? `codex-cli ${plan.cli.version}` : `${plan.cli.version} (Claude Code)`);
  const checked = `test -x ${cli} && actual=$( ${cli} --version 2>/dev/null ) && test "$actual" = ${expectedVersion}`;
  const repair = codex ? "false" : `node ${quote(`${cliDir}/node_modules/@anthropic-ai/claude-code/install.cjs`)} >/dev/null && engine_ready`;
  const managed = plan.launch.workFolders ?? [];
  const dirs = [...plan.mkdirs.filter(path => !managed.some(folder => path === folder.path || path.startsWith(folder.path + "/"))), `${REMOTE_ENGINE_BASE}/run`, `${REMOTE_ENGINE_BASE}/state`, `${REMOTE_ENGINE_BASE}/locks`];
  const prepare = plan.guestRuntime?.kind === "node" ? "command -v node >/dev/null"
    : plan.guestRuntime?.kind === "acp" ? "bash -e -c " + quote(guestCliPreparation(plan.guestRuntime.cli))
    : `engine_ready() { ${checked}; }
engine_ready || (mkdir -p ${quote(cliDir)} && ${install} >/dev/null && (engine_ready || (${repair})))`;
  return [
    `(
${prepare}
) || exit ${CLI_NOT_INSTALLED}`,
    `sudo -n install -d -o dog -g dog -m 700 ${dirs.map(quote).join(" ")} || exit ${FOLDERS_NOT_MADE}`,
    `if test -f ${quote(`${relay.dir}/.ready`)}; then echo ${RELAY_PRESENT}; else mkdir -p ${quote(relay.dir)}; fi`,
  ].join("\n");
}

function codexGuardInstall(): string {
  const files = [
    [`${CODEX_MANAGED_HOOKS}/guard.cjs`, readFileSync(join(SERVER_ROOT, "laterdog", "codex-computer-guard.cjs"))],
    ["/etc/codex/requirements.toml", Buffer.from(CODEX_GUARD_REQUIREMENTS)],
  ] as const;
  return [
    "set -eu",
    `sudo -n mkdir -p ${quote(CODEX_MANAGED_HOOKS)}`,
    "tmp=$(sudo -n mktemp /etc/codex/.guard.XXXXXXXX)",
    `trap 'sudo -n rm -f "$tmp"' EXIT`,
    ...files.flatMap(([target, bytes]) => [
      `echo ${quote(bytes.toString("base64"))} | base64 -d | sudo -n tee "$tmp" >/dev/null`,
      'sudo -n chmod 644 "$tmp"',
      `if test -e ${quote(target)}; then sudo -n cmp -s "$tmp" ${quote(target)}; else sudo -n ln "$tmp" ${quote(target)} || sudo -n cmp -s "$tmp" ${quote(target)}; fi`,
      'sudo -n rm -f "$tmp"',
      'tmp=$(sudo -n mktemp /etc/codex/.guard.XXXXXXXX)',
    ]),
  ].join("\n");
}

export async function prepareEngineComputer(box: EngineBox, plan: ClaudeRemotePlan, relay = engineScripts()): Promise<void> {
  const prepared = await box.exec(prepareScript(plan, relay), ENGINE_INSTALL_BUDGET_MS);
  if (prepared.exitCode === CLI_NOT_INSTALLED) {
    const name = plan.guestRuntime ? plan.cli.name : plan.cli.name === "@openai/codex" ? "Codex" : "Claude Code";
    throw new Error(`${name} ${plan.cli.version} could not be installed on the cloud computer.`);
  }
  if (prepared.exitCode === FOLDERS_NOT_MADE) throw new Error("The mirrored folders could not be made on the cloud computer.");
  if (prepared.exitCode !== 0) throw new Error("The cloud computer could not be prepared for the engine.");
  if (plan.cli.name === "@openai/codex" && plan.launch.hooks.length) {
    const guarded = await box.exec(codexGuardInstall(), ENGINE_STEP_BUDGET_MS);
    if (guarded.exitCode !== 0) throw new Error("The computer could not install the native Codex shell guard.");
  }
  if (prepared.stdout.split(/\r?\n/).includes(RELAY_PRESENT)) return;
  for (const file of relay.files) await box.write(`${relay.dir}/${file.name}`, file.bytes);
  const marked = await box.exec(`touch ${quote(`${relay.dir}/.ready`)}`, ENGINE_STEP_BUDGET_MS);
  if (marked.exitCode !== 0) throw new Error("The engine relay could not be put on the cloud computer.");
}

export function processStreamLink(socket: WebSocket, command: string): EngineLink {
  const link = new EventEmitter() as EngineLink;
  let closed = false;
  let buffered = Buffer.alloc(0);
  const close = (why: string) => { if (closed) return; closed = true; link.emit("close", why); };
  const send = (value: unknown) => { if (!closed) socket.send(JSON.stringify(value)); };
  socket.on("message", (raw) => {
    let frame: { channel?: string; data?: string; code?: number; message?: string };
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.channel === "ping") { send({ channel: "pong" }); return; }
    if (frame.channel === "stdout" && typeof frame.data === "string") {
      buffered = Buffer.concat([buffered, Buffer.from(frame.data, "base64")]);
      let newline: number;
      while ((newline = buffered.indexOf(10)) >= 0) {
        const line = buffered.subarray(0, newline).toString("utf8");
        buffered = buffered.subarray(newline + 1);
        link.emit("line", line);
      }
    } else if (frame.channel === "stderr" && typeof frame.data === "string") link.emit("diagnostic", Buffer.from(frame.data, "base64").toString("utf8"));
    else if (frame.channel === "exit") close(`relay exited ${frame.code}`);
    else if (frame.channel === "error") close(frame.message ?? "process stream error");
  });
  socket.on("close", () => close("process stream closed"));
  socket.on("error", () => close("process stream failed"));
  send({ channel: "start", lifetime: "engine", input: { command } });
  link.send = (line) => send({ channel: "stdin", data: Buffer.from(`${line}\n`).toString("base64") });
  link.close = () => { send({ channel: "stop" }); try { socket.close(); } catch {} };
  return link;
}

export function relayCommand(relay = engineScripts()): string {
  return `exec node ${quote(relay.relay)}`;
}
