import { copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEV, describeVariant } from "../electron/app-variant.mjs";

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
