import { spawn } from "node:child_process";
import type { EngineWorkFolder } from "./engine-folder-sync.ts";

export const GUEST_FOLDER_HELPER = "/home/dog/.laterdog-engine/work-folders/helper.mjs";

export function runFolderCommand(
  action: "hydrate" | "checkpoint",
  binding: EngineWorkFolder,
  options: { entry?: string; state?: string; signal?: AbortSignal; onProgress?: () => void } = {},
): Promise<{ revision: string; manifest: string; changed: boolean }> {
  return new Promise((ok, fail) => {
    const child = spawn(
      process.execPath,
      [options.entry ?? GUEST_FOLDER_HELPER, action, binding.path, ...(options.state ? [options.state] : [])],
      { stdio: ["pipe", "pipe", "pipe"], signal: options.signal },
    );
    let error = "",
      receipt = "";
    child.stdout.on("data", (bytes) => {
      receipt = (receipt + bytes.toString()).slice(-4096);
    });
    child.stderr.on("data", (bytes) => {
      const diagnostic = bytes.toString();
      if (diagnostic.includes("folder-progress")) options.onProgress?.();
      error = (error + diagnostic.replaceAll("folder-progress\n", "")).slice(-8192);
    });
    child.once("error", fail);
    child.stdin.on("error", () => {});
    child.once("close", (code) => {
      if (code !== 0) {
        fail(new Error(error.trim() || "Working folder synchronization did not complete"));
        return;
      }
      try {
        const r = JSON.parse(receipt);
        if (!r.revision || !r.manifest) throw new Error();
        ok(r);
      } catch {
        fail(new Error("Guest returned an invalid working folder receipt"));
      }
    });
    child.stdin.end(
      JSON.stringify({ grant: binding.grant, aliases: binding.aliases, linkProjects: binding.linkProjects }),
    );
  });
}
