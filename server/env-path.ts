import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";

function nvmBinDirs(): string[] {
  try {
    const base = join(homedir(), ".nvm", "versions", "node");
    return readdirSync(base)
      .filter((v) => v.startsWith("v"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => join(base, v, "bin"));
  } catch {
    return [];
  }
}

function sealedFixture(): boolean {
  return process.env.LATERDOG_TEST_SEALED_PATH === "1";
}

function knownDirs(): string[] {
  const home = homedir();
  return [
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".kimi-code", "bin"),
    join(home, ".grok", "bin"),
    join(home, ".opencode", "bin"),
    join(home, ".claude", "local"),
    ...(sealedFixture() ? [] : [
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ]),
    join(home, ".volta", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".asdf", "shims"),
    join(home, ".local", "share", "mise", "shims"),
    join(home, ".deno", "bin"),
    join(home, "bin"),
    ...nvmBinDirs(),
  ];
}

function windowsKnownDirs(): string[] {
  const home = homedir();
  const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
  return [
    join(appData, "npm"),
    join(home, ".grok", "bin"),
    join(localAppData, "agy", "bin"),
    join(localAppData, "cursor-agent"),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    join(home, "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Docker", "Docker", "resources", "bin"),
  ];
}

let cached: string | null = null;
let probed = false;
let loginShellPath: string | null = null;

const registeredDirs: string[] = [];

export function registerPathDir(dir: string): void {
  if (registeredDirs.includes(dir)) return;
  registeredDirs.unshift(dir);
  resetPathCache();
}

export function resetPathCache(): void {
  cached = null;
  probed = false;
}

export function augmentedPath(): string {
  if (cached === null) {
    cached = mergePaths([
      ...registeredDirs.filter((d) => existsSync(d)),
      ...(process.env.LATERDOG_EXTRA_PATH ? process.env.LATERDOG_EXTRA_PATH.split(delimiter) : []),
      ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
      ...(loginShellPath ? loginShellPath.split(delimiter) : []),
      ...(process.platform === "win32" ? windowsKnownDirs() : knownDirs()).filter((d) => existsSync(d)),
    ]);
  }
  if (!probed && !process.env.VITEST && !sealedFixture() && process.platform !== "win32") {
    probed = true;
    probeLoginShellPath();
  }
  return cached;
}

function mergePaths(parts: string[]): string {
  return [...new Set(parts.filter(Boolean))].join(delimiter);
}

function probeLoginShellPath(): void {
  const shell = process.env.SHELL || "/bin/zsh";
  execFile(
    shell,
    ["-l", "-i", "-c", 'printf "__LATERDOG_PATH__%s" "$PATH"'],
    { timeout: 5000 },
    (err, stdout) => {
      if (err || !stdout) return;
      const m = /__LATERDOG_PATH__([^\n]*)/.exec(stdout);
      if (!m || !m[1]) return;
      loginShellPath = m[1];
      cached = mergePaths([...(cached ?? "").split(delimiter), ...m[1].split(delimiter)]);
    },
  );
}

export function resetPathCacheForTests(): void {
  cached = null;
  probed = false;
  loginShellPath = null;
  registeredDirs.length = 0;
}

export function userHome(env: Record<string, string | undefined> = process.env): string {
  return process.platform === "win32"
    ? env.USERPROFILE || env.HOME || homedir()
    : env.HOME || env.USERPROFILE || homedir();
}

export function harnessHome(name: string, env: Record<string, string | undefined> = process.env): string {
  return join(userHome(env), `.${name}`);
}

export function findCliCandidates(name: string): string[] {
  if (!name || /[\n\r]/.test(name)) return [];
  if (/[/\\]/.test(name) || /^[a-zA-Z]:/.test(name)) return [name];
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  const out: string[] = [];
  for (const dir of augmentedPath().split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}


export interface ResolvedSpawn {
  command: string;
  args: string[];
}

export function splitCliString(cli: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (const ch of cli.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function isFile(p: string): boolean {
  try {
    return statSync(p, { throwIfNoEntry: false })?.isFile() ?? false;
  } catch {
    return false;
  }
}

function whichWin(cli: string, env?: NodeJS.ProcessEnv): string | null {
  const exts = ((env ?? process.env).PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const probe = (base: string) => {
    const order = extname(base) ? [base, ...exts.map((e) => base + e)] : [...exts.map((e) => base + e), base];
    return order.find(isFile) ?? null;
  };
  if (/[\\/]/.test(cli) || /^[a-zA-Z]:/.test(cli)) return probe(cli);
  const path = env ? (env.PATH ?? env.Path ?? "") : augmentedPath();
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const hit = probe(join(dir, cli));
    if (hit) return hit;
  }
  return null;
}

function nodeExe(near: string, env?: NodeJS.ProcessEnv): string | null {
  const local = join(near, "node.exe");
  if (isFile(local)) return local;
  const onPath = whichWin("node.exe", env);
  if (onPath && extname(onPath).toLowerCase() === ".exe") return onPath;
  return (process.versions as Record<string, string | undefined>).electron ? null : process.execPath;
}

function parseCmdShim(shim: string, env?: NodeJS.ProcessEnv): ResolvedSpawn | null {
  let text: string;
  try {
    text = readFileSync(shim, "utf8");
  } catch {
    return null;
  }
  const dir = dirname(shim);
  const npmEntry = /^SET "NP[MX]_CLI_JS=%~dp0\\([^"]+)"/im.exec(text);
  const targets = [...(npmEntry ? [npmEntry] : []), ...text.matchAll(/"%~?dp0%?\\?([^"]+)"/g)]
    .map((m) => join(dir, m[1]))
    .filter((p) => isFile(p) && basename(p).toLowerCase() !== "node.exe");
  const script = targets.find((p) => /\.[cm]?js$/i.test(p));
  if (script) {
    const node = nodeExe(dir, env);
    if (node) return { command: node, args: [script] };
  }
  const exe = targets.find((p) => extname(p).toLowerCase() === ".exe");
  return exe ? { command: exe, args: [] } : null;
}

function parseNodeShebang(file: string, env?: NodeJS.ProcessEnv): ResolvedSpawn | null {
  let head = "";
  let fd: number | null = null;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(128);
    const n = readSync(fd, buf, 0, buf.length, 0);
    head = buf.subarray(0, n).toString("utf8").split("\n", 1)[0];
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
  if (!/^#!.*\bnode(\.exe)?\b/.test(head)) return null;
  const node = nodeExe(dirname(file), env);
  return node ? { command: node, args: [file] } : null;
}

function resolveWord(cli: string, args: string[], env?: NodeJS.ProcessEnv): ResolvedSpawn {
  if (process.platform !== "win32") return { command: cli, args };
  const file = whichWin(cli, env);
  if (!file) return { command: cli, args };
  const ext = extname(file).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    const direct = parseCmdShim(file, env);
    return direct ? { command: direct.command, args: [...direct.args, ...args] } : { command: file, args };
  }
  if (ext === ".exe" || ext === ".com") return { command: file, args };
  const viaNode = parseNodeShebang(file, env);
  return viaNode ? { command: viaNode.command, args: [...viaNode.args, ...args] } : { command: file, args };
}

export function resolveCliSpawn(cli: string, args: string[], env?: NodeJS.ProcessEnv): ResolvedSpawn {
  const trimmed = cli.trim();
  if (trimmed.includes(" ") && existsSync(trimmed)) return resolveWord(trimmed, args, env);
  const split = splitCliString(cli);
  if (split.length > 1 || split[0] !== trimmed) {
    const [head, ...fixed] = split;
    if (!head) return { command: cli, args };
    return resolveWord(head, [...fixed, ...args], env);
  }
  return resolveWord(cli, args, env);
}
