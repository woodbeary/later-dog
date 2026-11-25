import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type WebSocket from "ws";
import { SERVER_ROOT } from "../proxy-paths.ts";
import type { EngineLink } from "./engine-remote.ts";
import { REMOTE_ENGINE_BASE, type ClaudeRemotePlan } from "./engine-placement.ts";

export interface EngineScripts { files: Array<{ name: string; bytes: Buffer }>; dir: string; relay: string; proxy: string }
let scripts: EngineScripts | null = null;

export function engineScripts(): EngineScripts {
  if (scripts) return scripts;
  const bundled = existsSync(join(SERVER_ROOT, "laterdog", "engine-relay.js")) && !existsSync(join(SERVER_ROOT, "laterdog", "engine-relay.ts"));
  const names = bundled ? ["engine-relay.js", "engine-proxy.js"] : ["engine-relay.ts", "engine-proxy.ts", "engine-files.ts"];
  const files = names.map((name) => ({ name, bytes: readFileSync(join(SERVER_ROOT, "laterdog", name)) }));
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.name).update("\0").update(file.bytes);
  const dir = `${REMOTE_ENGINE_BASE}/relay/${hash.digest("hex").slice(0, 16)}`;
  scripts = { files, dir, relay: `${dir}/${names[0]}`, proxy: `${dir}/${names[1]}` };
  return scripts;
}

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export interface EngineBox {
  exec(command: string, timeoutMs: number): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
  write(path: string, bytes: Uint8Array): Promise<unknown>;
}

export const ENGINE_STEP_BUDGET_MS = 60_000;
export const ENGINE_INSTALL_BUDGET_MS = 10 * 60_000;
export const ENGINE_PREPARE_BUDGET_MS = ENGINE_INSTALL_BUDGET_MS + 2 * ENGINE_STEP_BUDGET_MS;
const CLI_NOT_INSTALLED = 41;
const FOLDERS_NOT_MADE = 42;
const RELAY_PRESENT = "relay-present";

export function prepareScript(plan: ClaudeRemotePlan, relay: EngineScripts): string {
  const cliDir = `${REMOTE_ENGINE_BASE}/cli/claude-code-${plan.cli.version}`;
  const dirs = [...plan.mkdirs, `${REMOTE_ENGINE_BASE}/run`, `${REMOTE_ENGINE_BASE}/state`, `${REMOTE_ENGINE_BASE}/locks`];
  return [
    `test -x ${quote(`${cliDir}/node_modules/.bin/claude`)} || (mkdir -p ${quote(cliDir)} && npm install --prefix ${quote(cliDir)} --no-audit --no-fund --loglevel=error ${quote(`${plan.cli.name}@${plan.cli.version}`)} >/dev/null) || exit ${CLI_NOT_INSTALLED}`,
    `sudo -n install -d -o dog -g dog -m 700 ${dirs.map(quote).join(" ")} || exit ${FOLDERS_NOT_MADE}`,
    `if test -f ${quote(`${relay.dir}/.ready`)}; then echo ${RELAY_PRESENT}; else mkdir -p ${quote(relay.dir)}; fi`,
  ].join("\n");
}

export async function prepareEngineComputer(box: EngineBox, plan: ClaudeRemotePlan, relay = engineScripts()): Promise<void> {
  const prepared = await box.exec(prepareScript(plan, relay), ENGINE_INSTALL_BUDGET_MS + ENGINE_STEP_BUDGET_MS);
  if (prepared.exitCode === CLI_NOT_INSTALLED) throw new Error(`Claude Code ${plan.cli.version} could not be installed on the cloud computer.`);
  if (prepared.exitCode === FOLDERS_NOT_MADE) throw new Error("The mirrored folders could not be made on the cloud computer.");
  if (prepared.exitCode !== 0) throw new Error("The cloud computer could not be prepared for the engine.");
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
  send({ channel: "start", input: { command } });
  link.send = (line) => send({ channel: "stdin", data: Buffer.from(`${line}\n`).toString("base64") });
  link.close = () => { send({ channel: "stop" }); try { socket.close(); } catch {} };
  return link;
}

export function relayCommand(relay = engineScripts()): string {
  return `exec node ${quote(relay.relay)}`;
}
