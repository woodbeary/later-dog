import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export async function homeRuntimeBuild(moduleUrl: string): Promise<{ serverSha256: string; bundlePrefix?: string } | null> {
  const path = fileURLToPath(moduleUrl);
  if (basename(path) !== "index.js") return null;
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch { return null; }
  const parent = dirname(path);
  const prefix = basename(parent);
  const bundle = basename(dirname(parent)) === "laterdog-dev-server" && /^[a-f0-9]{16}$/.test(prefix);
  return { serverSha256: hash.digest("hex"), ...(bundle ? { bundlePrefix: prefix } : {}) };
}
