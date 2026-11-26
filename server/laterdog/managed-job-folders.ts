import { assignedCwd, linkedProjects, visibleAliases, scopeForPath, folderGrant, type FolderScope } from "./work-folder-locations.ts";
import type { WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import type { RunBox, SyncRunFolder } from "./computer-runs.ts";
import { syncComputerWorkFolder } from "./engine-opener.ts";

export function managedJobFolders(layout: WorkFolderLayout | null, home: { publicOrigin: string; bootstrapSecret: string } | null, dataDir: string) {
  if (!layout) return null;
  if (!home) throw new Error("Missing cloud home authority for assigned work folders.");
  const sync: SyncRunFolder = async (box: RunBox, botId: string, scope: FolderScope, action) => {
    if (!box.computerId || !box.stream) throw new Error("The selected computer cannot open this work folder.");
    const assigned = scopeForPath(layout, dataDir, scope.path, botId);
    if (assigned?.owner !== scope.owner || assigned?.id !== scope.id || assigned?.path !== scope.path) throw new Error("This work folder is no longer assigned to the dog.");
    const pending = new Map([[scope.path, scope]]);
    const dependencies = new Map<string, FolderScope[]>();
    for (const folder of pending.values()) {
      const linked = linkedProjects(layout, dataDir, folder, botId);
      dependencies.set(folder.path, linked);
      for (const project of linked) if (!pending.has(project.path)) pending.set(project.path, project);
    }
    const folders = [...pending.values()].sort((a,b)=>Number(b.id.startsWith("project-"))-Number(a.id.startsWith("project-")));
    for (const folder of folders) {
      const grant = await folderGrant(home.publicOrigin, home.bootstrapSecret, folder, botId, box.computerId);
      await syncComputerWorkFolder({ box, stream: box.stream }, {
        path: folder.path, grant, linkProjects: dependencies.get(folder.path)!.map(project => project.path),
        ...(folder.id === "loose" ? { aliases: visibleAliases(layout, botId) } : {}),
      }, action);
    }
  };
  const path = (botId:string, folder:string) => assignedCwd(layout,dataDir,botId,folder)!;
  return { path, resolve: (botId: string, folder: string) => scopeForPath(layout, dataDir, path(botId,folder), botId), sync };
}
