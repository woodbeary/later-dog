import fs from "node:fs";
import path from "node:path";

const STAGED_ARCHES = new Set(["arm64", "x64"]);

export function stagedMacDriver({
  appPath,
  platform = process.platform,
  arch = process.arch,
  isFile = (file) => fs.statSync(file, { throwIfNoEntry: false })?.isFile() === true,
}) {
  if (platform !== "darwin" || !STAGED_ARCHES.has(arch)) return null;
  const staged = path.join(appPath, "dist-native", arch, "cua-driver");
  return isFile(staged) ? staged : null;
}
