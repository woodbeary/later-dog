import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { workFolderPlacementSchema, type WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import { validWorkFolderScope, workFolderAuthority, workFolderBaseUrl, type WorkFolderGrant } from "../../shared/work-folder-store.ts";
import type { EngineFileRoot } from "./engine-files.ts";

export type FolderScope = { owner: string; id: string; path: string };

export function projectFolderId(path: string): string {
  return "project-" + createHash("sha256").update(path, "utf8").digest("hex");
}

function below(root: string, path: string): string[] | null {
  const tail = relative(root, path);
  if (isAbsolute(tail) || tail === ".." || tail.startsWith(".." + sep)) return null;
  return tail ? tail.split(sep) : [];
}

export function scopeForPath(layout: WorkFolderLayout, dataDir: string, path: string, botId?: string): FolderScope | null {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) return null;
  const dogs = join(dataDir, "workspaces");
  const tasks = join(dataDir, "task-workspaces");
  const dogParts = below(dogs, path);
  if (dogParts?.length) {
    const dog = dogParts[0]!;
    return (!botId || dog === botId) && validWorkFolderScope(dog, "dog")
      ? { owner: dog, id: "dog", path: join(dogs, dog) } : null;
  }
  const taskParts = below(tasks, path);
  if (taskParts && taskParts.length >= 2) {
    const [dog, thread] = taskParts as [string, string, ...string[]];
    const id = "task-" + thread;
    return (!botId || dog === botId) && validWorkFolderScope(dog, id)
      ? { owner: dog, id, path: join(tasks, dog, thread) } : null;
  }
  const project = layout.projects.filter(item => below(item.path, path) !== null)
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!project || (botId && botId !== project.owner && !project.members.includes(botId))) return null;
  return { owner: project.owner, id: projectFolderId(project.path), path: project.path };
}

export function mountedWorkFolders(env: NodeJS.ProcessEnv = process.env): WorkFolderLayout | null {
  if (env.LATERDOG_CLOUD_ROLE !== "home" || !env.LATERDOG_WORK_FOLDER_LAYOUT) return null;
  const placement = workFolderPlacementSchema.parse(JSON.parse(readFileSync(env.LATERDOG_WORK_FOLDER_LAYOUT, "utf8")));
  if (placement.mode !== "folders") throw new Error("The mounted folder layout is inactive.");
  return placement.layout;
}

export async function folderGrant(origin: string, bootstrap: string, scope: FolderScope, botId: string, computerId: string): Promise<WorkFolderGrant> {
  const url = workFolderBaseUrl(origin, scope.owner, scope.id);
  const response = await fetch(url + "/grant", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { authorization: "Bearer " + await workFolderAuthority(bootstrap, scope.owner, scope.id), "content-type": "application/json" },
    body: JSON.stringify({ guestId: computerId, granteeBotId: botId }),
  });
  if (!response.ok) throw new Error("The work folder could not authorize its computer (" + response.status + ").");
  const grant = await response.json() as WorkFolderGrant;
  if (grant.baseUrl !== url || grant.guestId !== computerId || !grant.accessToken || !grant.refreshToken ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now()) throw new Error("Invalid work folder grant.");
  return grant;
}

export function engineFolderScopes(layout: WorkFolderLayout, dataDir: string, input: {
  botId: string; cwd: string; roots: readonly EngineFileRoot[];
}): FolderScope[] {
  const paths = [join(dataDir, "workspaces", input.botId), input.cwd];
  for (const root of input.roots) {
    if (root.id === "workspace" || root.id === "bot-workspace") paths.push(root.path);
  }
  const scopes = new Map<string, FolderScope>();
  for (const path of paths) {
    const scope = scopeForPath(layout, dataDir, path, input.botId);
    if (scope) scopes.set(scope.path, scope);
    else if (input.roots.some(root => root.id === "workspace" && root.path === path)) {
      throw new Error("The selected working folder has no storage assigned to this dog.");
    }
  }
  return [...scopes.values()];
}
