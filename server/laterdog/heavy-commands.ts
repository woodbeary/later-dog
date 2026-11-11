const RUNNERS = "(?:pnpm|npm|yarn|bun)";
const RUNNER_FLAGS = "(?:\\s+(?:(?:--filter|-F|-C|--dir|--prefix|--cwd|-w|--workspace)\\s+[^\\s-]\\S*|workspace\\s+\\S+|-\\S+))*";
const SUITE_TOOLS = "(?:vitest|jest|pytest)";
const LAUNCHERS = "(?:npx|pnpx|bunx|pnpm\\s+(?:exec|dlx)|yarn\\s+dlx)";
const COMPOSE_WORK = "(?:up|build|run|pull|create|start|restart|watch)";
const HEAVY: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`^${RUNNERS}${RUNNER_FLAGS}\\s+(?:install|i|ci|add|rebuild)(?:\\s|$)`), "a package install"],
  [/^(?:pnpm|yarn|bun)$/, "a package install"],
  [new RegExp(`^${RUNNERS}${RUNNER_FLAGS}\\s+(?:run\\s+)?(?:build|test|tests|typecheck|type-check|e2e|test:\\S+|build:\\S+)(?:\\s|$)`), "a build or test suite"],
  [new RegExp(`^${LAUNCHERS}\\s+(?:-\\S+\\s+)*(?:tsc|next|vite|webpack|playwright|turbo|nx|expo)(?:\\s|$)`), "a build or test suite"],
  [/^(?:tsc|next\s+(?:build|dev)|vite\s+build|webpack|turbo\s+run|nx\s+run|playwright\s+(?:test|install)|expo\s+(?:export|prebuild))(?:\s|$)/, "a build or test suite"],
  [/^node\s+(?:\S+\/)?tsc(?:\.[cm]?js)?(?:\s|$)/, "a build or test suite"],
  [/^python3?\s+-m\s+playwright\s+install(?:\s|$)/, "a package install"],
  [new RegExp(`^(?:${LAUNCHERS}\\s+(?:-\\S+\\s+)*create-[\\w-]+|${RUNNERS}\\s+create\\s+\\S)`), "a package install"],
  [/^(?:pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+install(?:\s|$)/, "a package install"],
  [/^(?:uv\s+sync|poetry\s+install|pipenv\s+install|conda\s+(?:install|create)|bundle\s+install|composer\s+install)(?:\s|$)/, "a package install"],
  [/^(?:apt(?:-get)?|dnf|yum|brew)\s+(?:-\S+\s+)*install(?:\s|$)|^apk\s+(?:-\S+\s+)*add(?:\s|$)/, "a package install"],
  [/^(?:cargo\s+(?:build|test|install|check|clippy|run|bench)|go\s+(?:build|test|install|run)|gradle\w*|mvn|xcodebuild|swift\s+build|cmake\s+--build)(?:\s|$)/, "a build or test suite"],
  [/^make(?!\s+-n(?:\s|$))(?:\s|$)/, "a build or test suite"],
  [/^(?:docker|podman)\s+(?:build|buildx|run)(?:\s|$)/, "a container build or run"],
  [new RegExp(`^(?:docker|podman)[\\s-]compose\\s(?:.*\\s)?${COMPOSE_WORK}(?:\\s|$)`), "a container build or run"],
  [/^(?:ffmpeg|whisper|blender)(?:\s|$)/, "media processing"],
];
const SUITE = new RegExp(`^(?:(?:npx|pnpx|bunx|pnpm(?:\\s+(?:exec|dlx))?|yarn(?:\\s+dlx)?)\\s+(?:-\\S+\\s+)*)?(${SUITE_TOOLS})(?:\\s+(?:run|test))?(?:\\s|$)|^python3?\\s+-m\\s+(pytest)(?:\\s|$)|^(node)\\s+(?:--\\S+\\s+)*--test(?:\\s|$)`);
const SUITE_VALUE_FLAGS = /(?:^|\s)(?:-[tkmgcpnow]|--(?:testNamePattern|test-name-pattern|grep|config|project|reporter|root|dir|maxfail|shard|pool|tb|timeout|testTimeout|maxWorkers|outputFile))\s+(?:"[^"]*"|'[^']*'|[^\s-]\S*)/g;
const SINGLE_FILE = /^[^*?{}\s]+\.[A-Za-z]{1,4}(?:::\S+)?$/;
const ASKS_OR_REHEARSES = /(?:^|\s)--(?:version|help|dry-run|just-print|simulate|collect-only|co|listTests)(?:\s|$)/;
const SOLE_FLAG_LAUNCHER = new RegExp(`^(?:${LAUNCHERS}\\s+(?:-\\S+\\s+)*|python3?\\s+-m\\s+)`);
const REDIRECTS = "(?:\\s*\\d*(?:>>?|<)&?\\s*[^\\s<>]+)*\\s*$";
const SOLE_FLAG = new RegExp(`^(\\S+)\\s+(-version|-help|-v|-V|-h)${REDIRECTS}`);
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
const WRAPPERS = /^(?:(?:sudo|time|nohup|env|exec|command|do|then|else)\s+|nice\s+(?:-n\s*-?\d+\s+|-\d+\s+)?|timeout\s+(?:(?:-k|--kill-after|-s|--signal)\s+\S+\s+|-\S+\s+)*\d+(?:\.\d+)?[smhd]?\s+)/;
const COMMAND_PATH = /^(?:\.{0,2}\/)?(?:[\w.@+-]+\/)+(?=[\w.+-]+(?:\s|$))/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\s]+)"|'([^'\s]+)'|([^\s"'$]+))$/;
const VARIABLE_COMMAND = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(?=\s|$)/;
const SHELL_STRING = new RegExp(`^(?:bash|sh|zsh)\\s+(?:-\\w+\\s+)*-\\w*c\\s+(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')${REDIRECTS}`);
const HEREDOC = /<<-?\s*(?:"(\w+)"|'(\w+)'|\\?(\w+))/;
const SHELL_READS_INPUT = /(?:^|[\s;&|(])(?:bash|sh|zsh)(?:\s+-\S+)*\s*<</;
const MAX_SHELL_STRING_DEPTH = 3;

function withoutWrittenText(command: string): string {
  if (!command.includes("<<")) return command;
  const kept: string[] = [];
  let until: string | null = null;
  let keepBody = false;
  for (const line of command.split("\n")) {
    if (until !== null) {
      if (line.trim() === until) until = null;
      else if (keepBody) kept.push(line);
      continue;
    }
    kept.push(line);
    const opened = HEREDOC.exec(line);
    if (opened) {
      until = opened[1] ?? opened[2] ?? opened[3]!;
      keepBody = SHELL_READS_INPUT.test(line);
    }
  }
  return kept.join("\n");
}

export function segments(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (quote) {
      if (ch === "\\" && quote === "\"" && index + 1 < command.length) { current += ch + command[index + 1]; index += 1; continue; }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "\\" && index + 1 < command.length) { current += ch + command[index + 1]; index += 1; continue; }
    if (ch === "'" || ch === "\"") { quote = ch; current += ch; continue; }
    if (ch === "$" && command[index + 1] === "(") { parts.push(current); current = ""; index += 1; continue; }
    if (ch === "&" && command[index + 1] === "&") { parts.push(current); current = ""; index += 1; continue; }
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") { parts.push(current); current = ""; if (ch === "|" && command[index + 1] === "|") index += 1; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

function bare(segment: string): string {
  let out = segment;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(ENV_PREFIX, "").replace(WRAPPERS, "").replace(/^cd\s+\S+\s*$/, "");
    if (next === out) break;
    out = next;
  }
  return out.trim().replace(COMMAND_PATH, "");
}

function asksOrRehearses(plain: string): boolean {
  if (ASKS_OR_REHEARSES.test(plain)) return true;
  const sole = SOLE_FLAG.exec(plain.replace(SOLE_FLAG_LAUNCHER, ""));
  return sole !== null && !(sole[1] === "pytest" && sole[2] === "-v");
}

function wholeSuite(plain: string): boolean {
  const match = SUITE.exec(plain);
  if (!match) return false;
  const targets = plain.slice(match[0].length).replace(SUITE_VALUE_FLAGS, " ").split(/\s+/)
    .filter((word) => word && !word.startsWith("-") && !/^\d*[<>]/.test(word));
  return !targets.length || targets.some((target) => !SINGLE_FILE.test(target.replace(/^["']|["']$/g, "")));
}

function heavyKind(command: string, depth: number): string | null {
  const assigned = new Map<string, string>();
  for (const segment of segments(withoutWrittenText(command))) {
    const assignment = ASSIGNMENT.exec(segment);
    if (assignment) {
      assigned.set(assignment[1]!, assignment[2] ?? assignment[3] ?? assignment[4]!);
      continue;
    }
    const plain = bare(bare(segment).replace(VARIABLE_COMMAND, (whole, braced: string | undefined, named: string | undefined) => assigned.get(braced ?? named!) ?? whole));
    if (!plain) continue;
    const shellString = depth < MAX_SHELL_STRING_DEPTH ? SHELL_STRING.exec(plain) : null;
    if (shellString) {
      const inner = heavyKind(shellString[1]?.replace(/\\(["\\$`])/g, "$1") ?? shellString[2]!, depth + 1);
      if (inner) return inner;
      continue;
    }
    if (asksOrRehearses(plain)) continue;
    for (const [pattern, kind] of HEAVY) if (pattern.test(plain)) return kind;
    if (wholeSuite(plain)) return "a build or test suite";
  }
  return null;
}

export function heavyCommandKind(command: string): string | null {
  return heavyKind(command, 0);
}

const REMEMBER_MS = 30 * 60_000;
const MAX_REMEMBERED = 2_000;

export class HeavyCommandGuard {
  readonly #refused = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  check(threadId: string, command: string): string | null {
    const kind = heavyCommandKind(command);
    if (!kind) return null;
    const key = `${threadId}\0${command.trim().replace(/\s+/g, " ")}`;
    const now = this.#now();
    const refusedAt = this.#refused.get(key);
    if (refusedAt !== undefined && now - refusedAt < REMEMBER_MS) {
      this.#refused.delete(key);
      return null;
    }
    this.#refused.set(key, now);
    if (this.#refused.size > MAX_REMEMBERED) {
      for (const [old, at] of this.#refused) if (now - at >= REMEMBER_MS || this.#refused.size > MAX_REMEMBERED) this.#refused.delete(old);
    }
    return `This looks like ${kind}. Every dog in this home shares one machine, so run it on your own cloud computer with run_on_computer (folder and command), which keeps installed packages there between runs. If run_on_computer is unavailable or fails for this command, run the same command here again and it will go ahead.`;
  }
}

export interface ShellGuardContext {
  active: boolean;
  threadId: string;
  payload: Record<string, unknown>;
}

export function preToolUseDecision(guard: HeavyCommandGuard, context: ShellGuardContext): Record<string, unknown> | null {
  if (!context.active || context.payload.tool_name !== "Bash") return null;
  const input = context.payload.tool_input;
  const command = input && typeof input === "object" ? (input as Record<string, unknown>).command : undefined;
  if (typeof command !== "string") return null;
  const refusal = guard.check(context.threadId, command);
  return refusal ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: refusal } : null;
}
