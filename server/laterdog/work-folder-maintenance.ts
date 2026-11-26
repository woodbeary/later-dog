import { join } from "node:path";
import { mountedWorkFolders } from "./work-folder-locations.ts";
import type { WorkFolderLayout } from "../../shared/work-folder-layout.ts";

export function homeMountPaths(dataDir: string, home: string, layout: WorkFolderLayout | null = mountedWorkFolders()): string[] {
  if (!layout) return [];
  return [
    join(dataDir, "workspaces"), join(dataDir, "task-workspaces"),
    ...layout.projects.map(project => project.path),
    ...(layout.loose?.names ?? []).map(name => join(home, name)),
  ];
}
