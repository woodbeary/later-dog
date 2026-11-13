import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export function permissionCommand(command: unknown, cwd: unknown): { command: string; cwd: string } | undefined {
  if (typeof command !== "string" || !command.trim() || command.includes("\0")) return undefined;
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) return undefined;
  return { command, cwd };
}

export function permissionPaths(values: readonly unknown[], cwd: string | undefined): string[] | undefined {
  const paths = values.filter((value): value is string => typeof value === "string" && value.length > 0 && !value.includes("\0"));
  if (!paths.length || paths.length !== values.length) return undefined;
  if (paths.some((path) => !isAbsolute(path)) && (!cwd || !isAbsolute(cwd))) return undefined;
  return paths.map((path) => resolve(cwd ?? "/", path));
}

const CLAUDE_EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CLAUDE_READS = new Set(["Read", "Grep", "Glob", "LS"]);
const ESCAPING_PATTERN = /(^|[\\/])\.\.([\\/]|$)|^[\\/~]|\{|\$/;

export function claudeEditPaths(tool: unknown, input: unknown, cwd: string | undefined): string[] | undefined {
  if (typeof tool !== "string" || !input || typeof input !== "object") return undefined;
  const fields = input as Record<string, unknown>;
  if (CLAUDE_EDITS.has(tool)) return permissionPaths([fields.file_path ?? fields.notebook_path], cwd);
  if (!CLAUDE_READS.has(tool)) return undefined;
  if ([fields.pattern, fields.glob].some((pattern) => typeof pattern === "string" && tool !== "Grep" && ESCAPING_PATTERN.test(pattern))) return undefined;
  if (typeof fields.glob === "string" && ESCAPING_PATTERN.test(fields.glob)) return undefined;
  return permissionPaths([fields.file_path ?? fields.path ?? cwd], cwd);
}

function locationPaths(location: unknown): unknown[] {
  if (!location || typeof location !== "object") return [undefined];
  const fields = location as { path?: unknown; move_path?: unknown; movePath?: unknown; kind?: { move_path?: unknown; movePath?: unknown } };
  const moved = fields.move_path ?? fields.movePath ?? fields.kind?.move_path ?? fields.kind?.movePath;
  return moved === undefined || moved === null ? [fields.path] : [fields.path, moved];
}

export function locatedPaths(locations: unknown, cwd: string | undefined): string[] | undefined {
  if (!Array.isArray(locations)) return undefined;
  return permissionPaths(locations.flatMap(locationPaths), cwd);
}

export function permissionLaunchCwd(cwd: string): string | undefined {
  try { return realpathSync(cwd); } catch { return undefined; }
}

export function acpPermissionCommand(rawInput: unknown, launchCwd: string | undefined): ReturnType<typeof permissionCommand> {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return undefined;
  const input = rawInput as Record<string, unknown>;
  const directories = ["cwd", "workdir", "working_directory", "directory", "dir"]
    .filter((key) => input[key] !== undefined)
    .map((key) => input[key]);
  if (directories.some((value) => typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))) return undefined;
  if (new Set(directories).size > 1) return undefined;
  return permissionCommand(input.command, directories[0] ?? launchCwd);
}
