import path from "node:path";

export function resolveCompanionEntry({ isPackaged, resourcesPath, appPath, exists }) {
  const packaged = path.join(resourcesPath, "companion", "index.js");
  if (isPackaged) return exists(packaged) ? { entry: packaged, execArgv: [] } : null;
  const built = path.join(appPath, "dist-companion", "index.js");
  if (exists(built)) return { entry: built, execArgv: [] };
  const source = path.join(appPath, "companion", "src", "index.ts");
  if (exists(source)) return { entry: source, execArgv: ["--experimental-strip-types"] };
  return null;
}
