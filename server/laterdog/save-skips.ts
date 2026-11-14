export const RESTORING_PREFIX = ".laterdog-restoring-";

export const SAVE_SKIPPED_NAMES: ReadonlySet<string> = new Set([
  "node_modules", ".cache", ".tmp", ".npm", ".pnpm-store", "Cache", "Code Cache", "GPUCache", "ShaderCache", "Crashpad", ".Trash", "lost+found",
]);
const REFRESH_LOCK_NAMES: ReadonlySet<string> = new Set([".oauth_refresh.lock", ".oauth_refresh.lock.owner"]);
const SKIPPED_SUFFIXES = ["-wal", "-shm", "-journal"];
const LOCK_DIRECTORY_SUFFIX = ".lock";

export function saveSkips(name: string, type: "file" | "dir" | "link"): boolean {
  if (SAVE_SKIPPED_NAMES.has(name) || REFRESH_LOCK_NAMES.has(name) || name.startsWith(RESTORING_PREFIX)) return true;
  if (type === "dir") return name.endsWith(LOCK_DIRECTORY_SUFFIX);
  return SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}
