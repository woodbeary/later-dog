import { membershipFor, type ProjectAccess } from "../../shared/work-folder-project-access.ts";
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
  const visible = visibleWorkspace(dataDir);
  if (layout.loose && below(visible, path) !== null) {
    if (botId && layout.loose.owner !== botId && !layout.loose.members.includes(botId)) return null;
    return { owner: layout.loose.owner, id: "loose", path: visible };
  }
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

let mountedProjectAccess: { verification: string; access: ProjectAccess | null } | undefined;
export function rememberProjectAccess(verification: string, access: ProjectAccess | null) {
  const path = process.env.LATERDOG_WORK_FOLDER_LAYOUT;
  if (path) {
    const placement = workFolderPlacementSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    if (placement.mode !== "folders" || placement.verification !== verification)
      throw new Error("The mounted home and its project authority have different placements.");
  }
  mountedProjectAccess = { verification, access };
}
export function mountedWorkFolders(env: NodeJS.ProcessEnv = process.env): WorkFolderLayout | null {
  if (env.LATERDOG_CLOUD_ROLE !== "home" || !env.LATERDOG_WORK_FOLDER_LAYOUT) return null;
  const placement = workFolderPlacementSchema.parse(JSON.parse(readFileSync(env.LATERDOG_WORK_FOLDER_LAYOUT, "utf8")));
  if (placement.mode !== "folders") throw new Error("The mounted folder layout is inactive.");
  return membershipFor(placement.layout, mountedProjectAccess?.verification === placement.verification ? mountedProjectAccess.access : null);
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
  for (const scope of scopes.values()) {
    for (const project of linkedProjects(layout, dataDir, scope, input.botId)) scopes.set(project.path, project);
  }
  return [...scopes.values()].sort((a, b) => Number(b.id.startsWith("project-")) - Number(a.id.startsWith("project-")));
}

export function linkedProjects(layout: WorkFolderLayout, dataDir: string, scope: FolderScope, botId: string): FolderScope[] {
  const targets = scope.id === "loose" ? visibleAliases(layout, botId).map(alias => alias.target)
    : layout.links?.[scope.owner + "/" + scope.id] ?? [];
  const projects = new Map<string, FolderScope>();
  for (const target of targets) {
    if (target === scope.path) continue;
    const project = scopeForPath(layout, dataDir, target, botId);
    if (project?.path === target && project.id.startsWith("project-")) projects.set(target, project);
  }
  return [...projects.values()];
}

export function projectLink(layout: WorkFolderLayout, dataDir: string, scope: FolderScope, inside: string, target: string): string | null {
  if (!target || target.includes("\0")) return null;
  const destination = resolve(scope.path, inside, "..", target);
  for (const allowed of linkedProjects(layout, dataDir, scope, scope.owner)) {
    const suffix = below(allowed.path, destination);
    if (suffix) return join("/run/laterdog-work-folders/tree", allowed.id, ...suffix);
  }
  return null;
}

export function visibleWorkspace(dataDir: string): string {
  return resolve(dataDir, "..", ".laterdog-owned-work", "visible");
}

export function assignedCwd(layout: WorkFolderLayout | null, dataDir: string, botId: string, cwd: string | null | undefined): string | undefined {
  if (!layout || !cwd || cwd !== resolve(dataDir, "..")) return cwd ?? undefined;
  if (!layout.loose || (layout.loose.owner !== botId && !layout.loose.members.includes(botId))) throw new Error("Choose this dog's working folder before starting a task.");
  return visibleWorkspace(dataDir);
}

export function visibleAliases(layout: WorkFolderLayout, botId: string) {
  return layout.projects.filter(p => p.owner === botId || p.members.includes(botId)).map(p => ({
    name: p.path.slice(p.path.lastIndexOf("/") + 1), target: p.path,
  }));
}
