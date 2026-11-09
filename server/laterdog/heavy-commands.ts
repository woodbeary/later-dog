const RUNNERS = "(?:pnpm|npm|yarn|bun)";
const HEAVY: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`^${RUNNERS}(?:\\s+(?:-\\S+|--\\S+))*\\s+(?:install|i|ci|add)(?:\\s|$)`), "a package install"],
  [/^(?:pnpm|yarn|bun)$/, "a package install"],
  [new RegExp(`^${RUNNERS}(?:\\s+(?:-\\S+|--\\S+))*\\s+(?:run\\s+)?(?:build|test|tests|typecheck|type-check|e2e|test:\\S+|build:\\S+)(?:\\s|$)`), "a build or test suite"],
  [/^(?:npx|pnpx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+(?:-\S+\s+)*(?:tsc|next|vite|webpack|playwright|turbo|nx)(?:\s|$)/, "a build or test suite"],
  [/^(?:tsc|next\s+build|vite\s+build|webpack|turbo\s+run|nx\s+run|playwright\s+test)(?:\s|$)/, "a build or test suite"],
  [/^(?:pip3?|python3?\s+-m\s+pip|uv\s+pip)\s+install(?:\s|$)/, "a package install"],
  [/^(?:uv\s+sync|poetry\s+install|pipenv\s+install|conda\s+(?:install|create)|bundle\s+install|composer\s+install)(?:\s|$)/, "a package install"],
  [/^(?:cargo\s+(?:build|test|install)|go\s+(?:build|test)|gradle\w*|\.\/gradlew|mvn|xcodebuild|swift\s+build|cmake\s+--build)(?:\s|$)/, "a build or test suite"],
  [/^(?:docker|podman)\s+(?:build|compose|buildx|run)(?:\s|$)/, "a container build or run"],
  [/^(?:ffmpeg|whisper|blender)(?:\s|$)/, "media processing"],
];
const QUICK = /(?:^|\s)(?:--version|-v|--help|-h)(?:\s|$)/;
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)+/;
const WRAPPERS = /^(?:sudo|time|nice|nohup|env|exec|command)\s+/;

function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||\n|\(|\)|`|\$\(/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function bare(segment: string): string {
  let out = segment;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(ENV_PREFIX, "").replace(WRAPPERS, "").replace(/^cd\s+\S+\s*$/, "");
    if (next === out) break;
    out = next;
  }
  return out.trim();
}

export function heavyCommandKind(command: string): string | null {
  for (const segment of segments(command)) {
    const plain = bare(segment);
    if (!plain || QUICK.test(plain)) continue;
    for (const [pattern, kind] of HEAVY) if (pattern.test(plain)) return kind;
  }
  return null;
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
