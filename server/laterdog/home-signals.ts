import { segments } from "./heavy-commands.ts";
import { homeAncestors, readHomeProcess, readHomeProcesses } from "./home-processes.ts";

export interface SignalScene {
  mark: string;
  home: ReadonlySet<number>;
  markOf(pid: number): string | null | undefined;
  serverPort: number | null;
}

const KILLERS = new Set(["kill", "/bin/kill", "/usr/bin/kill"]);
const BY_NAME = new Set(["pkill", "killall", "/usr/bin/pkill", "/usr/bin/killall"]);
const FINDERS = new Set(["pgrep", "pidof", "/usr/bin/pgrep", "/bin/pidof"]);
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
export const WRAPPER_VALUE_OPTIONS = new Map<string, ReadonlySet<string>>([
  ["busybox", new Set<string>()],
  ["nice", new Set(["-n", "--adjustment"])],
  ["ionice", new Set(["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"])],
  ["sudo", new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "-R", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--chroot", "--close-from"])],
  ["doas", new Set(["-u", "-C"])],
  ["nohup", new Set<string>()],
  ["time", new Set(["-f", "-o", "--format", "--output"])],
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  ["stdbuf", new Set(["-i", "-o", "-e", "--input", "--output", "--error"])],
  ["setsid", new Set<string>()],
  ["exec", new Set(["-a"])],
  ["command", new Set<string>()],
  ["builtin", new Set<string>()],
  ["env", new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"])],
]);

const baseName = (word: string) => word.slice(word.lastIndexOf("/") + 1);

function unwrapped(tokens: readonly string[]): string[] {
  let at = 0;
  while (at < tokens.length) {
    while (at < tokens.length && ASSIGNMENT.test(tokens[at]!)) at += 1;
    const name = baseName(tokens[at] ?? "");
    const takesValue = WRAPPER_VALUE_OPTIONS.get(name);
    if (!takesValue) break;
    at += 1;
    while (at < tokens.length && tokens[at]!.startsWith("-") && tokens[at] !== "-") {
      const option = tokens[at]!;
      at += 1;
      if (option === "--") break;
      if (takesValue.has(option)) at += 1;
    }
    if (name === "timeout") at += 1;
  }
  const rest = tokens.slice(at);
  return rest.length ? [baseName(rest[0]!), ...rest.slice(1)] : [];
}

export function commandWords(segment: string): string[] {
  const plain = segment.trim().replace(ENV_PREFIX, "");
  return unwrapped((plain.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^['"]|['"]$/g, "")));
}

const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

export function isShell(word: string | undefined): boolean {
  return word !== undefined && SHELL_NAMES.has(baseName(word));
}

const HEREDOC_OPERATOR = /<<-?\s*(?:'[^']*'|"[^"]*"|[^\s;&|()<>]+)/g;

const HERE_STRING_OPERATOR = /<<<\s*(?:'[^']*'|"[^"]*"|\S+)/g;

function simpleWords(command: string): string[] {
  return commandWords(command.replace(HERE_STRING_OPERATOR, " ").replace(HEREDOC_OPERATOR, " "));
}

const PRINTERS = new Set(["echo", "printf"]);

function printedText([head, ...args]: readonly string[]): string[] {
  if (!head || !PRINTERS.has(head)) return [];
  const text = args.filter((arg) => !(head === "echo" && /^-[neE]+$/.test(arg))).join(" ");
  return [text.replace(/\\n/g, "\n")];
}

interface Heredoc { word: string; tabs: boolean; runs: boolean }

function heredocWord(command: string, from: number): { word: string; tabs: boolean; end: number } {
  const tabs = command[from] === "-";
  return { ...shellWord(command, tabs ? from + 1 : from), tabs };
}

function shellWord(command: string, from: number): { word: string; end: number } {
  let index = from;
  while (command[index] === " " || command[index] === "\t") index += 1;
  let word = "";
  while (index < command.length && !/[\s;&|()<>]/.test(command[index]!)) {
    const ch = command[index]!;
    if (ch === "'" || ch === "\"") {
      const close = command.indexOf(ch, index + 1);
      const stop = close === -1 ? command.length : close;
      word += command.slice(index + 1, stop);
      index = stop + 1;
      continue;
    }
    if (ch === "\\") { word += command[index + 1] ?? ""; index += 2; continue; }
    word += ch;
    index += 1;
  }
  return { word, end: index };
}

function bodyEnd(command: string, from: number, doc: Heredoc): { body: string; end: number } {
  let body = "";
  let at = from;
  while (at < command.length) {
    const next = command.indexOf("\n", at);
    const stop = next === -1 ? command.length : next;
    const line = command.slice(at, stop);
    at = stop + 1;
    if ((doc.tabs ? line.replace(/^\t+/, "") : line) === doc.word) break;
    body += `${line}\n`;
  }
  return { body, end: at };
}

export function commandText(command: string): string {
  let out = "";
  let index = 0;
  let simple = 0;
  const contexts: ("plain" | "single" | "double")[] = ["plain"];
  let current: Heredoc[] = [];
  let piped: Heredoc[] = [];
  let hereStrings: string[] = [];
  let pipedText: string[] = [];
  const shellRuns: string[] = [];
  const pending: Heredoc[] = [];
  const finish = (separator: string) => {
    const simpleCommand = simpleWords(command.slice(simple, index));
    if (isShell(simpleCommand[0])) {
      for (const doc of [...current, ...piped]) doc.runs = true;
      shellRuns.push(...hereStrings, ...pipedText);
    }
    const feeding = separator === "|";
    piped = feeding ? [...piped, ...current] : [];
    pipedText = feeding ? [...pipedText, ...hereStrings, ...printedText(simpleCommand)] : [];
    current = [];
    hereStrings = [];
    simple = index + 1;
  };
  const copyTo = (stop: number) => {
    out += command.slice(index, stop);
    index = stop - 1;
  };
  for (; index < command.length; index += 1) {
    const ch = command[index]!;
    const top = contexts[contexts.length - 1];
    if (top === "single") {
      if (ch === "'") contexts.pop();
      out += ch;
      continue;
    }
    if (ch === "\\") { copyTo(Math.min(index + 2, command.length)); continue; }
    if (top === "double" && ch === "\"") { contexts.pop(); out += ch; continue; }
    if (ch === "$" && command.startsWith("$((", index)) { const close = command.indexOf("))", index); copyTo(close === -1 ? command.length : close + 2); continue; }
    if (ch === "$" && command[index + 1] === "(") { contexts.push("plain"); out += "$("; index += 1; simple = index + 1; continue; }
    if (top === "double") { out += ch; continue; }
    if (ch === "'") { contexts.push("single"); out += ch; continue; }
    if (ch === "\"") { contexts.push("double"); out += ch; continue; }
    if (ch === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1]!))) { const next = command.indexOf("\n", index); index = (next === -1 ? command.length : next) - 1; continue; }
    if (ch === "(" && command[index + 1] === "(") { const close = command.indexOf("))", index); copyTo(close === -1 ? command.length : close + 2); continue; }
    if (ch === "(") { finish(ch); contexts.push("plain"); out += ch; continue; }
    if (ch === ")") { finish(ch); if (contexts.length > 1) contexts.pop(); out += ch; continue; }
    if (ch === "<" && command.startsWith("<<<", index)) {
      const found = shellWord(command, index + 3);
      hereStrings.push(found.word);
      copyTo(found.end);
      continue;
    }
    if (ch === "<" && command[index + 1] === "<") {
      const found = heredocWord(command, index + 2);
      const doc = { word: found.word, tabs: found.tabs, runs: false };
      current.push(doc);
      pending.push(doc);
      copyTo(found.end);
      continue;
    }
    if (ch === "\n") {
      finish(ch);
      out += ch;
      let at = index + 1;
      for (const doc of pending.splice(0)) {
        const read = bodyEnd(command, at, doc);
        if (doc.runs) out += read.body;
        at = read.end;
      }
      index = at - 1;
      simple = at;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "`") finish(ch);
    out += ch;
  }
  finish("");
  return out + shellRuns.map((text) => `\n${text}`).join("");
}

const LIVENESS_FLAGS = new Set(["-0", "-SIG0"]);
const LIVENESS_SIGNALS = new Set(["0", "SIG0"]);

function killTargets(args: readonly string[]): string[] {
  const rest = [...args];
  if (rest[0] === "-l" || rest[0] === "-L") return [];
  if (LIVENESS_FLAGS.has(rest[0] ?? "")) return [];
  if ((rest[0] === "-s" || rest[0] === "-n") && LIVENESS_SIGNALS.has(rest[1] ?? "")) return [];
  if (rest[0] === "-s" || rest[0] === "-n") rest.splice(0, 2);
  else if (rest[0]?.startsWith("-") && rest[0] !== "--") rest.splice(0, 1);
  if (rest[0] === "--") rest.splice(0, 1);
  return rest;
}

const WHY_BY_NAME = "it stops processes by name, and every dog in this home shares one machine, so it would stop other dogs' work or the home itself";
const WHY_GROUP = "it signals a whole group of processes or every process, which includes the home itself";
const WHY_HOME = "that process is the home's own, and stopping it cuts off every dog and the person";
const WHY_OTHER = "that process belongs to another chat, not to you";
const WHY_FOUND = "it finds the processes to stop by name, which can match the home or other dogs' work";

function refusal(why: string): string {
  return `later.dog refused this: ${why}. To stop your own process, find its pid with ps, or with lsof -ti :<port> for a port, then run kill <pid>.`;
}

export function signalRefusal(command: string, scene: SignalScene, depth = 0): string | null {
  const parts = segments(commandText(command)).map(commandWords).filter((part) => part.length > 0);
  for (const [head, ...args] of parts) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (!isShell(head) || flag === -1 || depth >= 3) continue;
    const nested = signalRefusal(args[flag + 1] ?? "", scene, depth + 1);
    if (nested) return nested;
  }
  const stops = parts.some(([head, ...args]) => KILLERS.has(head!) || (head === "xargs" && args.some((arg) => KILLERS.has(arg))));
  for (const [head, ...args] of parts) {
    if (BY_NAME.has(head!)) return refusal(WHY_BY_NAME);
    if (head === "fuser" && args.some((arg) => /^-[a-zA-Z]*k/.test(arg))) return refusal(WHY_FOUND);
    if (head === "xargs" && args.some((arg) => KILLERS.has(arg) || BY_NAME.has(arg))) return refusal(WHY_FOUND);
    if (stops && FINDERS.has(head!)) return refusal(WHY_FOUND);
    if (stops && scene.serverPort !== null && (head === "lsof" || head === "fuser") && args.some((arg) => new RegExp(`(?:^|[:=])${scene.serverPort}(?:/tcp)?$`).test(arg))) return refusal(WHY_HOME);
    if (!KILLERS.has(head!)) continue;
    for (const target of killTargets(args)) {
      if (!/^-?\d+$/.test(target)) continue;
      const pid = Number(target);
      if (pid <= 0) return refusal(WHY_GROUP);
      if (scene.home.has(pid)) return refusal(WHY_HOME);
      const mark = scene.markOf(pid);
      if (mark === undefined || mark === scene.mark) continue;
      return refusal(mark === null ? WHY_HOME : WHY_OTHER);
    }
  }
  return null;
}

export function liveSignalScene(mark: string, serverPort: number | null, self = process.pid, procDir = "/proc"): SignalScene {
  return {
    mark,
    home: homeAncestors(self, readHomeProcesses(procDir)),
    markOf: (pid) => {
      const found = readHomeProcess(pid, procDir);
      return found ? found.mark : undefined;
    },
    serverPort,
  };
}

export function signalDecision(payload: Record<string, unknown>, scene: () => SignalScene): Record<string, unknown> | null {
  if (payload.tool_name !== "Bash") return null;
  const input = payload.tool_input;
  const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  if (typeof command !== "string" || !/\b(?:kill|pkill|killall|fuser)\b/.test(command)) return null;
  const why = signalRefusal(command, scene());
  return why ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } : null;
}
