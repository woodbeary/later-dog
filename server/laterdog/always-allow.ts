import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  COMPUTER_KEY, EXACT_KEY, FILES_EDIT_KEY, MAX_GRANT_KEY_BYTES, RUN_KEY, TOOL_KEY,
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

const RUNS_CODE = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "env", "xargs", "find", "eval", "exec", "source", ".",
  "sudo", "doas", "su", "nohup", "time", "nice", "timeout", "watch", "command", "builtin", "parallel", "script",
  "python", "python2", "python3", "node", "nodejs", "deno", "perl", "ruby", "php", "lua", "luajit", "osascript",
  "rscript", "pwsh", "powershell", "tclsh", "expect", "sed", "awk", "gawk", "mawk", "nawk", "ssh", "vi", "vim",
  "nvim", "emacs", "less", "more", "man", "gdb", "lldb", "strace", "dtrace", "open", "launchctl", "crontab",
]);

const HAS_SUBCOMMAND = new Set([
  "git", "npm", "pnpm", "yarn", "bun", "docker", "docker-compose", "podman", "kubectl", "gh", "cargo", "go", "pip",
  "pip3", "brew", "apt", "apt-get", "swift", "wrangler", "terraform", "helm", "poetry", "uv", "rustup", "gcloud",
  "aws", "az", "flyctl", "vercel", "netlify", "supabase", "prisma", "turbo", "nx", "mix", "dotnet", "composer",
  "bundle", "rails", "firebase", "heroku", "systemctl", "service", "xcrun", "pod", "fastlane", "expo", "eas",
]);

const RUNS_A_PACKAGE = new Set(["npx", "bunx", "pnpx", "uvx"]);
const PACKAGE_SUBCOMMAND = new Set(["dlx", "exec", "x", "create"]);
const DELETES = new Set(["rm", "rmdir", "unlink", "shred", "srm", "trash"]);
const NEVER_KEYED = new Set(["mail", "mailx", "sendmail", "msmtp", "mutt", "stripe", "osascript"]);
const NEVER_KEYED_ANYWHERE = /(?:^|[\s|;&(`$"'])(?:mail|mailx|sendmail|msmtp|mutt|stripe|osascript)(?=[\s|;&)`"']|$)/i;
const EXECUTING_OPTION = /^--?(?:exec|execdir|receive-pack|upload-pack|to-command|use-compress-program|checkpoint-action|rsh|config|config-env|command|shell|eval|c|e|x|interpreter|run|pre|post|hook|editor|pager)(?:=|$)/i;

const EDIT_TOOLS = new Set([
  "edit", "write", "multiedit", "notebookedit", "apply_patch", "create_file", "write_file", "edit_file", "str_replace_editor",
]);
const GENERIC_TOOLS = new Set(["tool", "other", "execute", "think", "read", "delete", "move", "mcp", "permissions", "pi", "switch_mode"]);
const TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,120}$/;

const PAY_TOKENS = new Set([
  "PAY", "PAYS", "PAYMENT", "PAYMENTS", "PAYOUT", "CHARGE", "REFUND", "TRANSFER", "PURCHASE", "BUY", "CHECKOUT",
  "ORDER", "INVOICE", "SUBSCRIBE", "SUBSCRIPTION", "WITHDRAW", "WITHDRAWAL", "DEPOSIT", "TRADE", "SWAP",
]);
const SEND_TOKENS = new Set(["SEND", "SENDS", "REPLY", "RESPOND", "FORWARD"]);
const MESSAGE_TOKENS = new Set(["EMAIL", "EMAILS", "MAIL", "GMAIL", "OUTLOOK", "MESSAGE", "MESSAGES", "TEXT", "TEXTS", "SMS", "MMS", "DM", "IMESSAGE", "WHATSAPP", "THREAD"]);

function toolTokens(tool: string): string[] {
  return tool
    .replace(/^mcp__/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

export function paysOrBuys(tool: string): boolean {
  return toolTokens(tool).some((token) => PAY_TOKENS.has(token));
}

export function sendsAsPerson(tool: string): boolean {
  const tokens = toolTokens(tool);
  return tokens.some((token) => SEND_TOKENS.has(token)) && tokens.some((token) => MESSAGE_TOKENS.has(token));
}

export function asksEveryTime(tool: string): boolean {
  return paysOrBuys(tool) || sendsAsPerson(tool);
}

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

function realOrNearest(path: string): string {
  let probe = path;
  const rest: string[] = [];
  for (let steps = 0; steps < 64; steps++) {
    try {
      return resolve(realpathSync(probe), ...rest.reverse());
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return path;
      rest.push(probe.slice(parent.length).replace(/^\/+/, ""));
      probe = parent;
    }
  }
  return path;
}

export function insideRoots(path: string, roots: readonly string[]): boolean {
  if (!isAbsolute(path)) return false;
  const real = realOrNearest(resolve(path));
  return roots.flatMap((root) => [root, realOrNearest(root)]).some((root) => {
    const rel = relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function pathLike(word: string): string | null {
  const value = word.startsWith("-") && word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
  if (value.startsWith("/") || value === ".." || value.startsWith("../") || value.includes("/../") || value.endsWith("/..")) return value;
  return null;
}

function staysInside(words: readonly string[], cwd: string, roots: readonly string[]): boolean {
  if (!insideRoots(cwd, roots)) return false;
  return words.every((word) => {
    const path = pathLike(word);
    return path === null || insideRoots(resolve(cwd, path), roots);
  });
}

function exactKey(command: string): string | undefined {
  if (/[\n\r\0]/.test(command) || redactSecretsInText(command) !== command) return undefined;
  const key = EXACT_KEY + command;
  return Buffer.byteLength(key) <= MAX_GRANT_KEY_BYTES - COMPUTER_KEY.length ? key : undefined;
}

const SUBCOMMAND = /^[A-Za-z][A-Za-z0-9:_-]{0,40}$/;
const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,60}$/;

export function commandKey(command: string, cwd: string, roots: readonly string[]): string | undefined {
  const text = command.trim();
  if (!text) return undefined;
  const words = shellWords(text);
  if (!words) return NEVER_KEYED_ANYWHERE.test(text) ? undefined : exactKey(text);
  const [program, ...args] = words as [string, ...string[]];
  if (NEVER_KEYED.has(program.toLowerCase())) return undefined;
  if (!PROGRAM.test(program) || RUNS_CODE.has(program.toLowerCase())) return exactKey(text);
  const inside = staysInside(args, cwd, roots);
  if (DELETES.has(program)) return inside ? RUN_KEY + program : undefined;
  if (!inside || args.some((arg) => EXECUTING_OPTION.test(arg))) return exactKey(text);
  if (RUNS_A_PACKAGE.has(program)) {
    return args[0] && SUBCOMMAND.test(args[0]) ? `${RUN_KEY}${program} ${args[0]}` : exactKey(text);
  }
  if (!HAS_SUBCOMMAND.has(program)) return RUN_KEY + program;
  const sub = args[0];
  if (!sub || !SUBCOMMAND.test(sub)) return exactKey(text);
  if (PACKAGE_SUBCOMMAND.has(sub)) {
    return args[1] && SUBCOMMAND.test(args[1]) ? `${RUN_KEY}${program} ${sub} ${args[1]}` : exactKey(text);
  }
  return `${RUN_KEY}${program} ${sub}`;
}

function bareTool(tool: string): string {
  const mcp = /^mcp__([^_].*?)__(.+)$/.exec(tool);
  return (mcp ? `${mcp[1]}/${mcp[2]}` : tool).toLowerCase();
}

function innerKey(request: GrantRequest): string | undefined {
  const name = bareTool(request.tool);
  if (request.command) return commandKey(request.command.command, request.command.cwd, request.roots);
  if (isShellTool(request.tool)) return undefined;
  if (EDIT_TOOLS.has(name)) {
    const paths = request.paths ?? [];
    return paths.length && paths.every((path) => insideRoots(path, request.roots)) ? FILES_EDIT_KEY : undefined;
  }
  if (GENERIC_TOOLS.has(name) || !TOOL_NAME.test(request.tool)) return undefined;
  return TOOL_KEY + name;
}

export function grantKeyFor(request: GrantRequest): string | undefined {
  if (request.requiresExplicitApproval || request.grantable === false || asksEveryTime(request.tool)) return undefined;
  const key = innerKey(request);
  if (!key) return undefined;
  return request.approvalScope === "local-computer" ? COMPUTER_KEY + key : key;
}

type GrantStore = {
  bot(id: string): BotRecord | null;
  taskByThread(botId: string, threadId: string): { alwaysAllow?: string[] } | undefined;
  tasks(botId: string): { threadId: string; alwaysAllow?: string[] }[];
  patchBot(id: string, patch: Partial<BotRecord>): BotRecord | null;
  patchTask(botId: string, threadId: string, patch: { alwaysAllow: string[] }): unknown;
};

export const MAX_GRANTS = 200;

export function dogGrantKeys(store: Pick<GrantStore, "bot" | "taskByThread">, botId: string, threadId?: string): string[] {
  const dog = store.bot(botId)?.alwaysAllow ?? [];
  const chat = threadId ? store.taskByThread(botId, threadId)?.alwaysAllow ?? [] : [];
  return [...new Set([...dog, ...chat])];
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
