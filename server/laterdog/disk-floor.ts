import { DISK_RUNGS, diskRung, type LadderRun } from "./disk-ladder.ts";
import type { DiskUse } from "./janitor.ts";
import { heavyCommandKind, segments } from "./heavy-commands.ts";
import { commandText, commandWords } from "./home-signals.ts";

const rungOf = (name: string) => DISK_RUNGS.find((step) => step.name === name)!.rung;
export const REFUSE_RUNG = rungOf("refuse");
export const FLOOR_RUNG = rungOf("floor");

const ONLY_READ_OR_FREE = new Set([
  "ls", "cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "find", "du", "df", "wc", "stat", "file",
  "pwd", "echo", "printf", "which", "type", "ps", "pgrep", "kill", "rm", "rmdir", "cd", "true", "false", "test", "[",
  "uniq", "cut", "tr", "jq", "date", "whoami", "id", "uname", "env", "lsof", "free", "uptime", "basename",
  "dirname", "realpath", "readlink", "sleep", "tree", "diff", "cmp", "md5sum", "sha256sum", "sha1sum",
]);

const GIT_READS = new Set([
  "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "ls-remote", "blame", "describe", "shortlog",
  "cat-file", "grep", "gc", "clean", "prune", "count-objects", "fsck", "help", "version", "--version", "show-ref",
]);
const GIT_GLOBAL_WITH_VALUE = new Set(["-C", "-c"]);

function gitOnlyReads(args: readonly string[]): boolean {
  let at = 0;
  while (at < args.length && args[at]!.startsWith("-") && args[at] !== "--version") at += GIT_GLOBAL_WITH_VALUE.has(args[at]!) ? 2 : 1;
  const [sub, ...rest] = args.slice(at);
  if (sub === undefined || GIT_READS.has(sub)) return true;
  const flagsOnly = rest.every((arg) => arg.startsWith("-"));
  if (sub === "branch" || sub === "tag") return flagsOnly || rest.some((arg) => ["-d", "-D", "--delete"].includes(arg));
  if (sub === "remote") return flagsOnly || rest[0] === "show" || rest[0] === "get-url";
  if (sub === "config") return rest.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(arg));
  if (sub === "stash" || sub === "worktree" || sub === "reflog") return rest.length === 0 || ["list", "show", "prune"].includes(rest[0]!);
  return false;
}

function packagesOnlyFree([sub, ...rest]: readonly string[]): boolean {
  return (sub === "store" && (rest[0] === "prune" || rest[0] === "path"))
    || (sub === "cache" && (rest[0] === "clean" || rest[0] === "verify"))
    || sub === "ls" || sub === "list" || sub === "why";
}

const XARGS_WITH_VALUE = new Set(["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a"]);
const FIND_RUNS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_WRITES = new Set(["-fprint", "-fprint0", "-fprintf", "-fls"]);
const SED_WRITES = /(?:^|[;{}\s/0-9$])[wW]\s*\S/;

function xargsCommand(args: readonly string[]): string[] {
  let at = 0;
  while (at < args.length && args[at]!.startsWith("-")) at += XARGS_WITH_VALUE.has(args[at]!) ? 2 : 1;
  return [...args.slice(at)];
}

function findOnlyReadsOrFrees(args: readonly string[]): boolean {
  for (let at = 0; at < args.length; at += 1) {
    if (FIND_WRITES.has(args[at]!)) return false;
    if (!FIND_RUNS.has(args[at]!)) continue;
    const end = args.findIndex((arg, index) => index > at && (arg === ";" || arg === "\\;" || arg === "+"));
    const run = args.slice(at + 1, end === -1 ? args.length : end);
    if (!partOnlyReadsOrFrees(run)) return false;
    at = end === -1 ? args.length : end;
  }
  return true;
}

function partOnlyReadsOrFrees([head, ...args]: readonly string[]): boolean {
  if (!head) return true;
  if (head === "git") return gitOnlyReads(args);
  if (head === "pnpm" || head === "npm" || head === "yarn") return packagesOnlyFree(args);
  if (head === "sed") return !args.some((arg) => arg.startsWith("-i") || arg.startsWith("--in-place") || (!arg.startsWith("-") && SED_WRITES.test(arg)));
  if (head === "sort") return !args.some((arg) => arg.startsWith("-o") || arg.startsWith("--output"));
  if (head === "xargs") return partOnlyReadsOrFrees(xargsCommand(args));
  if (head === "find") return findOnlyReadsOrFrees(args);
  return ONLY_READ_OR_FREE.has(head);
}

function unquoted(command: string): string {
  return command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "\"\"");
}

const REDIRECT = /(?<![-=])>>?\|?\s*([^\s;|()<>]*)/g;
const NOWHERE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

export function writesOnHome(command: string): boolean {
  const plain = unquoted(commandText(command));
  for (const found of plain.matchAll(REDIRECT)) {
    const target = found[1] ?? "";
    if (target.startsWith("&") || NOWHERE.has(target)) continue;
    return true;
  }
  return /(?:^|[\s|;&(])tee(?:\s|$)/.test(plain);
}

export interface FloorScene {
  computers: boolean;
}

function refuseLine(kind: string, scene: FloorScene): string {
  return scene.computers
    ? `later.dog refused this: the home's disk is short of space, so ${kind} cannot run here now. Run it on your own cloud computer with run_on_computer (folder and command), which keeps installed packages there between runs.`
    : `later.dog refused this: the home's disk is short of space, so ${kind} cannot run here now. Do the rest of the work without it, and say what is waiting on it.`;
}

function floorLine(scene: FloorScene): string {
  const elsewhere = scene.computers ? " Run work that writes files on your own cloud computer with run_on_computer." : "";
  return `later.dog refused this: the home's disk is nearly full, so shell commands that write files there are paused. Reading files, git status, log and diff, and removing what you made and no longer need still work.${elsewhere} Do not remove the person's work to make room.`;
}

export function diskFloorRefusal(command: string, rung: number, scene: FloorScene): string | null {
  if (rung >= FLOOR_RUNG) {
    const parts = segments(commandText(command)).map(commandWords);
    if (writesOnHome(command) || !parts.every(partOnlyReadsOrFrees)) return floorLine(scene);
    return null;
  }
  if (rung >= REFUSE_RUNG) {
    const kind = heavyCommandKind(command);
    return kind ? refuseLine(kind, scene) : null;
  }
  return null;
}

export function diskFloorDecision(payload: Record<string, unknown>, rung: number, scene: FloorScene): Record<string, unknown> | null {
  if (rung < REFUSE_RUNG || payload.tool_name !== "Bash") return null;
  const input = payload.tool_input;
  const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  if (typeof command !== "string") return null;
  const why = diskFloorRefusal(command, rung, scene);
  return why ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: why } : null;
}

export function homeFloorDecision(payload: Record<string, unknown>, disk: DiskUse | null, scene: FloorScene): Record<string, unknown> | null {
  return diskFloorDecision(payload, diskRung(disk), scene);
}

export const FLOOR_SENTENCE = "Your Cloud is nearly full. later.dog has cleared everything it safely can; the rest is your dogs' work. Open Storage to choose what to remove.";

export function floorWatch() {
  let held = false;
  return {
    climbed(run: LadderRun): void { held = run.held; },
    warning(disk: DiskUse | null): string | null { return held && diskRung(disk) >= FLOOR_RUNG ? FLOOR_SENTENCE : null; },
  };
}
