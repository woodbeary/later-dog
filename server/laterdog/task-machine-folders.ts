import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineWorkFolder } from "./engine-folder-sync.ts";
import { FolderStore } from "./engine-folder-store.ts";
import { publishInitialWorkFolder } from "./engine-folder-files.ts";

export const NEW_TASK_MS = 15 * 60_000;

export function taskFolderOf(folder: EngineWorkFolder): string | null {
  return new URL(folder.grant.baseUrl).pathname.split("/").at(-1)?.match(/^task-(.+)$/)?.[1] ?? null;
}

export interface FolderHead { head(): Promise<unknown> }

export async function publishNewTaskFolders(
  folders: readonly EngineWorkFolder[],
  threadId: string,
  isNewTask: boolean,
  open: (folder: EngineWorkFolder) => FolderHead & { publishEmpty(): Promise<void> } = (folder) => {
    const store = new FolderStore(folder.grant, () => {});
    return {
      head: () => store.head(),
      publishEmpty: async () => {
        const empty = await mkdtemp(join(tmpdir(), "laterdog-new-task-"));
        try { await publishInitialWorkFolder(empty, store); }
        finally { await rm(empty, { recursive: true, force: true }); }
      },
    };
  },
): Promise<string[]> {
  const published: string[] = [];
  if (!isNewTask) return published;
  for (const folder of folders) {
    if (taskFolderOf(folder) !== threadId) continue;
    const store = open(folder);
    if (await store.head()) continue;
    try {
      await store.publishEmpty();
      published.push(folder.path);
    } catch (error) {
      if (!(error instanceof Error && error.message.includes("already published"))) throw error;
    }
  }
  return published;
}
