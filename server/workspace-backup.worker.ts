import { parentPort, workerData } from "node:worker_threads";
import { createWorkspaceBackupSnapshot, type CreateWorkspaceBackupOptions } from "./workspace-backup.ts";

import type { HistoryBackupAccess } from "./laterdog/portable-history.ts";

const { dataDir, options, jobId, history } = workerData as { dataDir: string; options: CreateWorkspaceBackupOptions; jobId: string; history?:HistoryBackupAccess };
try {
  parentPort!.postMessage({ result: await createWorkspaceBackupSnapshot(dataDir, options, jobId, history) });
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : "The workspace backup could not finish." });
}
