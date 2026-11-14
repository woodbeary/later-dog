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
const WRAPPERS = /^(?:sudo|time|nice|nohup|env|exec|command|builtin|timeout\s+\S+)\s+/;

function words(segment: string): string[] {
  let plain = segment.trim();
  for (let pass = 0; pass < 4; pass += 1) {
    const next = plain.replace(ENV_PREFIX, "").replace(WRAPPERS, "");
    if (next === plain) break;
    plain = next;
  }
  return (plain.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^['"]|['"]$/g, ""));
}

function killTargets(args: readonly string[]): string[] {
  const rest = [...args];
  if (rest[0] === "-l" || rest[0] === "-L") return [];
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
  return `later.dog refused this: ${why}. Stop only what you started, by the pid it printed or that ps shows under your own command.`;
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "/bin/bash", "/bin/sh", "/bin/zsh", "/usr/bin/bash"]);

export function signalRefusal(command: string, scene: SignalScene, depth = 0): string | null {
  const parts = segments(command).map(words).filter((part) => part.length > 0);
  for (const [head, ...args] of parts) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (!SHELLS.has(head!) || flag === -1 || depth >= 3) continue;
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
