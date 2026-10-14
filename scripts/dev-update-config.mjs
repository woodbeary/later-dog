import { execFile } from "node:child_process";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DEV, describeVariant } from "../electron/app-variant.mjs";

const run = promisify(execFile);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEV_UPDATE_CONFIG = path.join(root, "electron", "resources", "app-update-dev.yml");

export function packagesDevVariant(context) {
  return context?.packager?.appInfo?.id === describeVariant(DEV).appId || context?.packager?.config?.appId === describeVariant(DEV).appId;
}

export async function installDevUpdateConfig(context, resources) {
  if (!packagesDevVariant(context)) return false;
  await copyFile(DEV_UPDATE_CONFIG, path.join(resources, "app-update.yml"));
  return true;
}

export function urlTypesWithOnlyScheme(urlTypes, scheme) {
  return (Array.isArray(urlTypes) ? urlTypes : [])
    .map((entry) => ({ ...entry, CFBundleURLSchemes: (entry.CFBundleURLSchemes ?? []).filter((candidate) => candidate === scheme) }))
    .filter((entry) => entry.CFBundleURLSchemes.length > 0);
}

export async function keepOnlyDevScheme(context) {
  if (!packagesDevVariant(context) || context.electronPlatformName !== "darwin") return false;
  const plist = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Info.plist");
  const { stdout } = await run("plutil", ["-convert", "json", "-o", "-", plist]);
  const kept = urlTypesWithOnlyScheme(JSON.parse(stdout).CFBundleURLTypes, describeVariant(DEV).scheme);
  if (kept.length === 0) throw new Error("The Dev app has no laterdog-dev URL scheme to keep.");
  await run("plutil", ["-replace", "CFBundleURLTypes", "-json", JSON.stringify(kept), plist]);
  return true;
}
