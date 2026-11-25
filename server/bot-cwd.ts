import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export type CwdValidation =
  | { ok: true; cwd: string | null }
  | { ok: false; error: string; forbidden?: true };

export function validateBotCwd(input: unknown, roots?: readonly string[]): CwdValidation {
  if (input === null) return { ok: true, cwd: null };
  if (typeof input !== "string") return { ok: false, error: "working folder must be a path" };
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, cwd: null };
  const expanded =
    trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  if (!isAbsolute(expanded)) return { ok: false, error: "working folder must be an absolute path" };
  const cwd = resolve(expanded);
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return { ok: false, error: `that folder doesn't exist: ${cwd}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `that path is not a folder: ${cwd}` };
  if (roots !== undefined) {
    const denied = {
      ok: false as const,
      error: "The new dog's working folder must stay inside the creating chat's working folder.",
      forbidden: true as const,
    };
    try {
      const canonical = realpathSync(cwd);
      const contained = roots.some((root) => {
        try {
          const path = relative(realpathSync(root), canonical);
          return (
            path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`))
          );
        } catch {
          return false;
        }
      });
      return contained ? { ok: true, cwd: canonical } : denied;
    } catch {
      return denied;
    }
  }
  return { ok: true, cwd };
}
