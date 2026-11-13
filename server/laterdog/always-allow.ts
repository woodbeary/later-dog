import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  COMPUTER_KEY, EXACT_KEY, EXACT_SPLIT, FILES_EDIT_KEY, FILES_READ_KEY, listedCommand, listedName, MAX_GRANT_KEY_BYTES, RUN_KEY,
  TOOL_KEY, type ListedCommand,
} from "../../shared/always-allow.ts";
import { redactSecretsInText } from "../redact.ts";
import type { BotRecord } from "../store.ts";
import { isShellTool } from "./owner-guard.ts";

export interface GrantRequest {
  tool: string;
  command?: { command: string; cwd: string };
  paths?: readonly string[];
  roots: readonly string[];
  approvalScope?: "local-computer";
  requiresExplicitApproval?: boolean;
  grantable?: false;
}

const SHELL_META = /[|&;<>()$`\\*?[\]{}~!#\n\r\t\0]/;
const NEVER_KEYED = /(?:^|[^A-Za-z0-9_.-])(?:mail|mailx|sendmail|msmtp|mutt|stripe|osascript)(?:$|[^A-Za-z0-9_.-])/i;
const DELETES = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash"]);
const DENIED_EVERYWHERE = /^--?(?:c|exec[\w-]*|receive-pack|upload-pack|config[\w-]*|git-dir|work-tree|namespace|super-prefix|global|system|prefix|registry|userconfig|globalconfig|script-shell|node-options|output|o|e|x)(?:=|$)/i;
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,60}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch", "create_file", "write_file", "edit_file", "str_replace_editor"]);
const READ_TOOLS = new Set(["read", "grep", "glob", "ls"]);
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set();
const RUNS_LATER_SEGMENTS = new Set([".git", ".husky", "node_modules", ".claude", ".codex", ".cursor", ".gemini", ".vscode", ".idea"]);
const RUNS_LATER_FILES = new Set([
  "package.json", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs", ".bashrc", ".bash_profile", ".bash_login", ".profile",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout", ".envrc", ".gitconfig", ".gitattributes", ".gitmodules", "makefile",
]);

function shellWords(command: string): string[] | null {
  if (SHELL_META.test(command)) return null;
  const words: string[] = [];
  let current: string | null = null;
  let quote: "'" | '"' | null = null;
  for (const character of command) {
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current ??= "";
      continue;
    }
    if (character === " ") {
      if (current !== null) words.push(current);
      current = null;
      continue;
    }
    current = (current ?? "") + character;
  }
  if (quote) return null;
  if (current !== null) words.push(current);
  return words.length ? words : null;
}

export function physicalPath(path: string, hops = 0): string {
  if (hops > 40) return "/\0";
  let current = "/";
  for (const part of path.split(sep)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, part);
    let link: string | null = null;
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next);
    } catch {}
    current = link === null ? next : physicalPath(isAbsolute(link) ? link : join(current, link), hops + 1);
  }
  return current;
}

function realOrNearest(path: string): string {
  return physicalPath(isAbsolute(path) ? path : resolve(path));
}

function joinPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : `${cwd}${sep}${path}`;
}

export function insideRoots(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const real = realOrNearest(path);
  return roots.flatMap((root) => [root, realOrNearest(root)]).some((root) => {
    const rel = relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export function pathsIn(word: string): string[] {
  const found: string[] = [];
  const add = (value: string) => {
    const bare = value.replace(/^@+/, "");
    if (bare && !bare.startsWith("-")) found.push(bare);
  };
  if (word.startsWith("-")) {
    if (word.includes("=")) add(word.slice(word.indexOf("=") + 1));
    else if (/^-[A-Za-z]./.test(word)) add(word.slice(2));
    return found;
  }
  add(word);
  if (word.includes("=")) add(word.slice(word.indexOf("=") + 1));
  return found;
}

function everyPathInside(words: readonly string[], cwd: string, roots: readonly string[]): boolean {
  return words.every((word) => pathsIn(word).every((path) => insideRoots(joinPath(cwd, path), roots)));
}

function gitDir(cwd: string): string | null {
  let probe = cwd;
  for (let steps = 0; steps < 64; steps++) {
    const candidate = join(probe, ".git");
    try {
      if (statSync(candidate).isDirectory()) return candidate;
      const pointer = /^gitdir: (.+)$/m.exec(readFileSync(candidate, "utf8"))?.[1]?.trim();
      return pointer ? resolve(probe, pointer) : null;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return null;
}

export function configuredRemotes(cwd: string): Set<string> {
  const dir = gitDir(cwd);
  if (!dir) return new Set();
  try {
    const text = readFileSync(join(dir, "config"), "utf8");
    return new Set([...text.matchAll(/^\s*\[remote "([^"\n]+)"\]/gm)].map((match) => match[1]!));
  } catch {
    return new Set();
  }
}

function deniedOption(entry: ListedCommand, word: string): boolean {
  if (!word.startsWith("-")) return false;
  const name = word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
  return DENIED_EVERYWHERE.test(word) || (entry.denied ?? []).includes(name);
}

function argumentsFit(entry: ListedCommand, args: readonly string[], cwd: string, roots: readonly string[]): boolean {
  if (args.some((arg) => deniedOption(entry, arg))) return false;
  if (entry.args === "none") return args.every((arg) => (entry.flags ?? []).includes(arg));
  if (!everyPathInside(args, cwd, roots)) return false;
  if (entry.args === "checked") return true;
  const names = args.filter((arg) => !arg.startsWith("-"));
  if (!names.length) return true;
  const [remote, ...refs] = names as [string, ...string[]];
  return REMOTE_NAME.test(remote) && configuredRemotes(cwd).has(remote) && refs.every((ref) => BRANCH_NAME.test(ref));
}

export function listedKey(words: readonly string[], cwd: string, roots: readonly string[]): string | undefined {
  const [first, ...rest] = words as [string, ...string[]];
  const program = first.toLowerCase();
  for (const take of [3, 2, 1, 0]) {
    if (take > rest.length) continue;
    const name = [program, ...rest.slice(0, take)].join(" ");
    const listed = listedCommand(name);
    if (!listed) continue;
    if (listed.script !== undefined && !SCRIPT_NAME.test(listed.script)) return undefined;
    return argumentsFit(listed.entry, rest.slice(take), cwd, roots) ? RUN_KEY + listedName(listed.entry, listed.script) : undefined;
  }
  return undefined;
}

function hasSecret(text: string): boolean {
  return redactSecretsInText(text) !== text;
}

function exactKey(command: string, cwd: string): string | undefined {
  if (/[\n\r\0]/.test(command) || cwd.includes(EXACT_SPLIT) || /[\n\r\0]/.test(cwd)) return undefined;
  const key = EXACT_KEY + realOrNearest(cwd) + EXACT_SPLIT + command;
  return Buffer.byteLength(key) <= MAX_GRANT_KEY_BYTES - COMPUTER_KEY.length ? key : undefined;
}

export function commandKey(command: string, cwd: string, roots: readonly string[]): string | undefined {
  const text = command.trim();
  if (!text || !isAbsolute(cwd) || hasSecret(text) || NEVER_KEYED.test(text)) return undefined;
  const words = shellWords(text);
  if (words && DELETES.has(words[0]!.toLowerCase()) && !everyPathInside(words.slice(1), cwd, roots)) return undefined;
  const listed = words && insideRoots(cwd, roots) ? listedKey(words, cwd, roots) : undefined;
  return listed ?? exactKey(text, cwd);
}

function bareTool(tool: string): string {
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  return (mcp ? `${mcp[1]}/${mcp[2]}` : tool).toLowerCase();
}

export function runsLater(path: string): boolean {
  const parts = resolve(path).split(sep).filter(Boolean);
  return parts.some((part) => RUNS_LATER_SEGMENTS.has(part.toLowerCase())) || RUNS_LATER_FILES.has(basename(path).toLowerCase());
}

function filesKey(paths: readonly string[] | undefined, roots: readonly string[], key: string, edits: boolean): string | undefined {
  if (!paths?.length || !paths.every((path) => insideRoots(path, roots))) return undefined;
  if (edits && paths.some((path) => runsLater(path) || runsLater(realOrNearest(path)))) return undefined;
  return key;
}

function innerKey(request: GrantRequest): string | undefined {
  const name = bareTool(request.tool);
  if (request.command) return commandKey(request.command.command, request.command.cwd, request.roots);
  if (isShellTool(request.tool)) return undefined;
  if (EDIT_TOOLS.has(name)) return filesKey(request.paths, request.roots, FILES_EDIT_KEY, true);
  if (READ_TOOLS.has(name)) return filesKey(request.paths, request.roots, FILES_READ_KEY, false);
  return READ_ONLY_TOOLS.has(name) ? TOOL_KEY + name : undefined;
}

export function grantKeyFor(request: GrantRequest): string | undefined {
  if (request.requiresExplicitApproval || request.grantable === false) return undefined;
  const key = innerKey(request);
  if (!key) return undefined;
  return request.approvalScope === "local-computer" ? COMPUTER_KEY + key : key;
}

export function knownReadOnly(tool: string): boolean {
  return READ_ONLY_TOOLS.has(bareTool(tool));
}

export const PEER_KEY = /^(?:ask_bot|delegate_bot):/;

export function peerKeysOnly(keys: readonly string[] | undefined): string[] | undefined {
  return keys?.filter((key) => PEER_KEY.test(key));
}

type GrantStore = {
  bot(id: string): BotRecord | null;
  taskByThread(botId: string, threadId: string): { alwaysAllow?: string[]; pausedGrants?: string[] } | undefined;
  tasks(botId: string): { threadId: string; alwaysAllow?: string[] }[];
  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null;
  patchTask(botId: string, threadId: string, patch: { alwaysAllow?: string[]; pausedGrants?: string[] }): unknown;
};

export const MAX_GRANTS = 200;

export function dogGrantKeys(store: Pick<GrantStore, "bot" | "taskByThread">, botId: string, threadId?: string): string[] {
  const task = threadId ? store.taskByThread(botId, threadId) : undefined;
  const paused = new Set(task?.pausedGrants ?? []);
  const dog = store.bot(botId)?.alwaysAllow ?? [];
  return [...new Set([...dog, ...(task?.alwaysAllow ?? [])])].filter((key) => !paused.has(key));
}

export function pauseGrantsInChat(store: Pick<GrantStore, "bot" | "taskByThread" | "patchTask">, botId: string, threadId: string): void {
  const task = store.taskByThread(botId, threadId);
  if (!task) return;
  const every = [...new Set([...(store.bot(botId)?.alwaysAllow ?? []), ...(task.alwaysAllow ?? []), ...(task.pausedGrants ?? [])])];
  store.patchTask(botId, threadId, { pausedGrants: every });
}

export function liftGrantPause(store: Pick<GrantStore, "taskByThread" | "patchTask">, botId: string, threadId: string, key?: string): void {
  const task = store.taskByThread(botId, threadId);
  if (!task?.pausedGrants?.length) return;
  const rest = key === undefined ? [] : task.pausedGrants.filter((candidate) => candidate !== key);
  if (rest.length !== task.pausedGrants.length) store.patchTask(botId, threadId, { pausedGrants: rest.length ? rest : undefined });
}

export function dogAllows(store: Pick<GrantStore, "bot" | "taskByThread">, botId: string, threadId: string, key: string): boolean {
  return dogGrantKeys(store, botId, threadId).includes(key);
}

export function grantToDog(store: Pick<GrantStore, "bot" | "patchBot">, botId: string, key: string): BotRecord | null {
  const bot = store.bot(botId);
  if (!bot) return null;
  if (bot.alwaysAllow?.includes(key)) return bot;
  return store.patchBot(botId, { alwaysAllow: [...(bot.alwaysAllow ?? []), key].slice(-MAX_GRANTS) });
}

export function forgetInChats(store: Pick<GrantStore, "tasks" | "patchTask">, botId: string, keys: readonly string[]): void {
  if (!keys.length) return;
  for (const task of store.tasks(botId)) {
    if (!task.alwaysAllow?.some((key) => keys.includes(key))) continue;
    store.patchTask(botId, task.threadId, { alwaysAllow: task.alwaysAllow.filter((key) => !keys.includes(key)) });
  }
}

export function revokeFromDog(store: GrantStore, botId: string, key: string): BotRecord | null {
  const bot = store.bot(botId);
  if (!bot) return null;
  forgetInChats(store, botId, [key]);
  if (!bot.alwaysAllow?.includes(key)) return store.bot(botId);
  return store.patchBot(botId, { alwaysAllow: bot.alwaysAllow.filter((candidate) => candidate !== key) });
}

export function chatOnlyGrants(store: Pick<GrantStore, "bot" | "tasks">, botId: string): string[] {
  const dog = new Set(store.bot(botId)?.alwaysAllow ?? []);
  return [...new Set(store.tasks(botId).flatMap((task) => task.alwaysAllow ?? []))].filter((key) => !dog.has(key));
}
