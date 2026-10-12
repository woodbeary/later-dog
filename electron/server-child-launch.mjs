import fs from "node:fs";
import path from "node:path";

export function serverChildLaunch({ resourcesPath, userData, env = process.env, exists = fs.existsSync }) {
  const serverDir = path.join(resourcesPath, "server");
  const bootstrap = path.join(serverDir, "desktop-entry.mjs");
  if (!exists(bootstrap)) return { entry: path.join(serverDir, "index.js"), compileCacheDir: null };
  const pathChangesEachLaunch = Boolean(env.APPIMAGE) || resourcesPath.includes("/AppTranslocation/");
  return {
    entry: bootstrap,
    compileCacheDir: pathChangesEachLaunch ? null : path.join(userData, "server-compile-cache"),
  };
}
