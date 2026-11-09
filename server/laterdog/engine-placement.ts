import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { killCliTree, registerTreeStopper } from "../procs.ts";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { EngineFileRoot } from "./engine-files.ts";
import { EngineProcess, RemoteSession, type EngineLink, type PushedFile, type RemoteLaunch, type StdioSpec } from "./engine-remote.ts";

export const REMOTE_ENGINE_BASE = "/home/dog/.laterdog-engine";
const CREDENTIAL_MARGIN_MS = 30 * 60_000;
const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)$/i;

export function remoteEngineBots(dataDir: string, env: NodeJS.ProcessEnv = process.env): Set<string> {
  const chosen = new Set<string>();
  for (const id of (env.LATERDOG_REMOTE_ENGINE_BOTS ?? "").split(",")) if (id.trim()) chosen.add(id.trim());
  try {
    const file = JSON.parse(readFileSync(join(dataDir, "remote-engines.json"), "utf8")) as { bots?: unknown };
    if (Array.isArray(file.bots)) for (const id of file.bots) if (typeof id === "string" && id) chosen.add(id);
  } catch {}
  return chosen;
}

export function claudeProjectSlug(cwd: string): string { return cwd.replace(/[^a-zA-Z0-9]/g, "-"); }

export function claudeCliPackage(resolvedCommand: string): { name: string; version: string } | null {
  let at: string;
  try { at = realpathSync(resolvedCommand); } catch { return null; }
  for (let dir = dirname(at); dir !== dirname(dir); dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (!existsSync(file)) continue;
    try {
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "@anthropic-ai/claude-code" && typeof pkg.version === "string" && /^[\w.+-]+$/.test(pkg.version)) return { name: pkg.name, version: pkg.version };
    } catch {}
    return null;
  }
  return null;
}

export function scopedClaudeCredential(text: string, now = Date.now()): Buffer | null {
  try {
    const parsed = JSON.parse(text) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || typeof oauth.expiresAt !== "number" || oauth.expiresAt < now + CREDENTIAL_MARGIN_MS) return null;
    const { refreshToken: _refresh, refreshTokenExpiresAt: _refreshExpiry, ...rest } = oauth;
    return Buffer.from(JSON.stringify({ claudeAiOauth: rest }));
  } catch { return null; }
}

const within = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

export interface ClaudePlacement {
  botId: string;
  threadId: string;
  sessionId: string;
  cliCommand: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  managed: boolean;
  dataDir: string;
  proxyPath: string;
  now?: number;
  remoteBase?: string;
}

export interface ClaudeRemotePlan { launch: RemoteLaunch; cli: { name: string; version: string }; stagingDir: string; mkdirs: string[] }

export function planClaudeRemote(input: ClaudePlacement): { plan: ClaudeRemotePlan } | { stay: string } {
  if (input.managed) return { stay: "managed account" };
  const base = input.env.ANTHROPIC_BASE_URL;
  if (base) { try { if (LOOPBACK.test(new URL(base).hostname)) return { stay: "account reached through the home" }; } catch { return { stay: "unreadable account address" }; } }
  const cli = claudeCliPackage(input.cliCommand);
  if (!cli) return { stay: "Claude CLI is not an npm install" };
  const home = input.env.HOME || homedir();
  const configDir = resolve(input.env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
  const cwd = resolve(input.cwd);
  if (cwd === "/" || cwd === resolve(home) || cwd === resolve(input.dataDir) || within(cwd, configDir) || within(configDir, cwd)) return { stay: "working folder cannot be mirrored" };
  let credential: Buffer | null = null;
  const credentialFile = join(configDir, ".credentials.json");
  if (!input.env.ANTHROPIC_API_KEY && !input.env.CLAUDE_CODE_OAUTH_TOKEN) {
    try { credential = scopedClaudeCredential(readFileSync(credentialFile, "utf8"), input.now); } catch {}
    if (!credential) return { stay: "no current sign-in to lend" };
  }

  const remoteBase = input.remoteBase ?? REMOTE_ENGINE_BASE;
  const runId = randomUUID().replace(/-/g, "").slice(0, 16);
  const threadKey = createHash("sha256").update(`${input.botId}\0${input.threadId}`).digest("hex").slice(0, 24);
  const stagingDir = join(input.dataDir, "engine-launch", runId);
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const socketPath = `${remoteBase}/run/${runId}.sock`;
  const proxy = (...rest: string[]) => ["node", input.proxyPath, ...rest];

  const args = [...input.args];
  const mcp: Record<string, StdioSpec> = {};
  const hooks: string[] = [];
  const at = (flag: string) => { const index = args.indexOf(flag); return index >= 0 && index + 1 < args.length ? index + 1 : -1; };
  const mcpIndex = at("--mcp-config");
  if (mcpIndex >= 0) {
    const servers = (JSON.parse(readFileSync(args[mcpIndex], "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers ?? {};
    const rewritten: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(servers)) {
      const spec = stdioSpecFor(server);
      if (!spec) return { stay: `MCP server ${name} cannot be carried` };
      mcp[name] = spec;
      const [command, ...rest] = proxy("mcp", socketPath, name);
      rewritten[name] = { command, args: rest, ...(server.alwaysLoad === true ? { alwaysLoad: true } : {}) };
    }
    const target = join(stagingDir, "mcp.json");
    writeFileSync(target, JSON.stringify({ mcpServers: rewritten }), { mode: 0o600 });
    args[mcpIndex] = target;
  }
  const settingsIndex = at("--settings");
  if (settingsIndex >= 0) {
    const settings = JSON.parse(readFileSync(args[settingsIndex], "utf8")) as Record<string, unknown>;
    const events = settings.hooks as Record<string, Array<{ matcher?: string; hooks?: Array<Record<string, unknown>> }>> | undefined;
    for (const entries of Object.values(events ?? {})) for (const entry of entries ?? []) for (const hook of entry.hooks ?? []) {
      if (hook.type !== "command" || typeof hook.command !== "string") continue;
      let index = hooks.indexOf(hook.command);
      if (index < 0) { index = hooks.length; hooks.push(hook.command); }
      hook.command = proxy("hook", String(index)).join(" ");
      hook.timeout = Math.max(Number(hook.timeout) || 5, 30);
    }
    const target = join(stagingDir, "settings.json");
    writeFileSync(target, JSON.stringify(settings), { mode: 0o600 });
    args[settingsIndex] = target;
  }
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (index === mcpIndex || index === settingsIndex || !isAbsolute(value) || within(stagingDir, value)) continue;
    try { if (!statSync(value).isFile()) continue; } catch { continue; }
    const target = join(stagingDir, `arg-${index}-${value.split("/").pop()}`);
    copyFileSync(value, target);
    args[index] = target;
  }

  const slug = claudeProjectSlug(cwd);
  const sessionDir = join(configDir, "projects", slug);
  const roots: EngineFileRoot[] = [
    { id: "workspace", path: cwd, writable: true },
    { id: "session", path: sessionDir, writable: true, files: [`${input.sessionId}.jsonl`] },
    { id: "session-extra", path: join(sessionDir, input.sessionId), writable: true },
    { id: "file-history", path: join(configDir, "file-history", input.sessionId), writable: true },
    { id: "account", path: configDir, writable: false, files: [".claude.json"] },
    { id: "launch", path: stagingDir, writable: false },
  ];
  if (credential) roots.push({ id: "credential", path: configDir, writable: false, files: [".credentials.json"] });
  const pushes = credential ? (): PushedFile[] => {
    let bytes: Buffer | null = null;
    try { bytes = scopedClaudeCredential(readFileSync(credentialFile, "utf8"), 0); } catch {}
    return bytes ? [{ root: "credential", path: ".credentials.json", bytes, mode: 0o600 }] : [];
  } : undefined;

  const remoteEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (value === undefined) continue;
    if (/^LATERDOG_(HOOK_|REMOTE_MCP_CONFIG_|GATE_CONFIG_|MCP_HEADER_)/.test(key) || key === "ELECTRON_RUN_AS_NODE" || key === "TMPDIR" || key === "TEMP" || key === "TMP") continue;
    remoteEnv[key] = value;
  }
  const cliDir = `${remoteBase}/cli/claude-code-${cli.version}`;
  Object.assign(remoteEnv, { CLAUDE_CONFIG_DIR: configDir, HOME: "/home/dog", PATH: `${cliDir}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin` });
  const hookEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) if (value !== undefined) hookEnv[key] = value;

  const launch: RemoteLaunch = {
    cli: `${cliDir}/node_modules/.bin/claude`,
    args, cwd, env: remoteEnv, roots,
    outputIds: ["workspace", "session", "session-extra", "file-history"],
    pushes, mcp, hooks, hookEnv, socketPath,
    stateFile: `${remoteBase}/state/${threadKey}.json`,
    lockFile: `${remoteBase}/locks/${threadKey}.lock`,
  };
  return { plan: { launch, cli, stagingDir, mkdirs: [...new Set(roots.map((root) => root.path))] } };
}

function stdioSpecFor(server: Record<string, unknown>): StdioSpec | null {
  if (typeof server.command === "string" && server.command) {
    return { command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [], env: server.env && typeof server.env === "object" ? server.env as Record<string, string> : undefined };
  }
  return null;
}

export interface EngineOpener { proxyPath: string; remoteBase?: string; open(botId: string, plan: ClaudeRemotePlan): Promise<EngineLink> }
let opener: EngineOpener | null = null;
export function setEngineOpener(value: EngineOpener | null): void { opener = value; }
export function engineOpener(): EngineOpener | null { return opener; }

export function deferredLink(open: Promise<EngineLink>): EngineLink {
  const link = new EventEmitter() as EngineLink;
  let real: EngineLink | null = null;
  let closed = false;
  const queued: string[] = [];
  open.then((ready) => {
    if (closed) { ready.close(); return; }
    real = ready;
    ready.on("line", (line) => link.emit("line", line));
    ready.on("diagnostic", (text) => link.emit("diagnostic", text));
    ready.on("close", (why) => { closed = true; link.emit("close", why); });
    for (const line of queued.splice(0)) ready.send(line);
  }, (error: Error) => { if (!closed) { closed = true; link.emit("diagnostic", error.message); link.emit("close", error.message); } });
  link.send = (line) => { if (real) real.send(line); else if (!closed) queued.push(line); };
  link.close = () => { if (real) real.close(); else if (!closed) { closed = true; link.emit("close", "closed before the computer was ready"); } };
  return link;
}

export function spawnPlacedEngine(plan: ClaudeRemotePlan, openLink: (plan: ClaudeRemotePlan) => Promise<EngineLink>, local: () => ChildProcess,
  onPlaced?: (where: "computer" | "home", why?: string) => void): EngineProcess {
  const session = new RemoteSession(deferredLink(openLink(plan)), plan.launch);
  const engine = new EngineProcess(session, local, onPlaced);
  registerTreeStopper(engine, (timeoutMs) => engine.stopTree(timeoutMs, killCliTree));
  engine.once("close", () => { try { rmSync(plan.stagingDir, { recursive: true, force: true }); } catch {} });
  return engine;
}
