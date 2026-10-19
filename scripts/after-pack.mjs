import { chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { LICENSE_FILES } from "./cua-linux-release.mjs";
import { verifyBrowserBundle } from "./prepare-browser.mjs";
import { installDevUpdateConfig, keepOnlyDevScheme } from "./dev-update-config.mjs";

async function requireRealDirectory(directory, mode = 0o755) {
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`Package resource must be a real directory: ${directory}`);
  }
  if (mode !== undefined) await chmod(directory, mode);
}

async function requireRegularFile(file, mode) {
  const details = await lstat(file);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`Package resource must be a regular file: ${file}`);
  }
  if (mode !== undefined) await chmod(file, mode);
}

export default async function afterPack(context) {
  const resources = context.packager?.getResourcesDir?.(context.appOutDir) ?? (
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, "later.dog.app", "Contents", "Resources")
      : path.join(context.appOutDir, "resources")
  );
  await installDevUpdateConfig(context, resources);
  await keepOnlyDevScheme(context);
  const browserRoot = path.join(resources, "browser-engine");
  const hasBrowser = await lstat(browserRoot).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  const arch = { 1: "x64", 3: "arm64" }[context.arch];
  if (hasBrowser || context.packager) {
    if (!arch) throw new Error(`Unsupported desktop browser package architecture: ${context.arch}`);
    await verifyBrowserBundle(browserRoot, `${context.electronPlatformName}-${arch}`);
  }

  if (context.electronPlatformName !== "linux") return;

  const cuaRoot = path.join(resources, "cua-linux-x64");
  const licenses = path.join(cuaRoot, "licenses");
  for (const directory of [context.appOutDir, resources, cuaRoot, licenses]) {
    await requireRealDirectory(directory);
  }
  for (const executable of ["cua-driver", "cua-cursor-theme"]) {
    await requireRegularFile(path.join(cuaRoot, executable), 0o755);
  }
  await requireRegularFile(path.join(cuaRoot, "release.json"), 0o644);
  for (const license of LICENSE_FILES) {
    await requireRegularFile(path.join(licenses, license), 0o644);
  }
}
