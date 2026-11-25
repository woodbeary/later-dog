export const CODEX_MANAGED_HOOKS = "/etc/codex/laterdog-hooks";
export const CODEX_GUARD_COMMAND = `/usr/local/bin/node ${CODEX_MANAGED_HOOKS}/guard.cjs`;
export const CODEX_GUARD_REQUIREMENTS = `[features]
hooks = true
[hooks]
managed_dir = "${CODEX_MANAGED_HOOKS}"
[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = "${CODEX_GUARD_COMMAND}"
timeout = 30
`;

export function verifiedCodexGuard(value: unknown): boolean {
  const requirements = (value as { requirements?: { hooks?: { managedDir?: unknown; PreToolUse?: Array<{ matcher?: unknown; hooks?: Array<{ command?: unknown }> }> } } } | null)?.requirements;
  const hooks = requirements?.hooks;
  return hooks?.managedDir === CODEX_MANAGED_HOOKS && Array.isArray(hooks.PreToolUse)
    && hooks.PreToolUse.some(group => group.matcher === "^Bash$" && Array.isArray(group.hooks) && group.hooks.some(handler => handler.command === CODEX_GUARD_COMMAND));
}
