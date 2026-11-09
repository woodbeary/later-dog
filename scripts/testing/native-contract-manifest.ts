import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const NATIVE_CONTRACT_SOURCES = [
  "shared/native-runs.ts",
  "shared/native-run-selectors.ts",
] as const;

export const NATIVE_CONTRACT_MANIFEST = "shared/native-runs.manifest.json";

export interface NativeContractManifest {
  version: 1;
  sources: Array<{ path: string; sha256: string }>;
  wire: { list: string; detail: string; stop: string; frame: string };
}

export function buildNativeContractManifest(read: (path: string) => string = path => readFileSync(join(ROOT, path), "utf8")): NativeContractManifest {
  return {
    version: 1,
    sources: NATIVE_CONTRACT_SOURCES.map(path => ({ path, sha256: createHash("sha256").update(read(path)).digest("hex") })),
    wire: {
      list: "GET /api/threads/:threadId/runs?limit&cursor -> NativeRunList",
      detail: "GET /api/threads/:threadId/runs/:runId?limit&cursor -> NativeRunDetail",
      stop: "POST /api/threads/:threadId/runs/:runId/actors/:actorId/stop -> 202 {status:'requested'}",
      frame: "SSE {kind:'native.run.updated', threadId, run: NativeRun}",
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(join(ROOT, NATIVE_CONTRACT_MANIFEST), `${JSON.stringify(buildNativeContractManifest(), null, 2)}\n`);
}
