export const BUILD_OUTPUT_DIRS: ReadonlySet<string> = new Set([
  "node_modules", ".open-next", ".next", ".nuxt", ".svelte-kit", ".turbo", ".parcel-cache", ".vite", ".cache",
  "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
]);

export const SCRATCH_PARENT = ".wrangler";
export const SCRATCH_CHILD = "tmp";

export function isGeneratedPath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part, index) => BUILD_OUTPUT_DIRS.has(part) || part === SCRATCH_CHILD && parts[index - 1] === SCRATCH_PARENT);
}
