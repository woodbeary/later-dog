import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.ts";
import type { WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import { safeWorkFolderPath, validWorkFolderScope } from "../../shared/work-folder-store.ts";
import { projectFolderId, type FolderScope } from "./work-folder-locations.ts";

export function folderError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export function directoryAttr(name: string, uid: number, gid: number) {
  const ino = BigInt("0x" + createHash("sha256").update(name).digest("hex").slice(0, 15)) + 2n;
  return { ino: ino.toString(), mode: 0o40700, size: "4096", nlink: 2, atimeNs: "0", mtimeNs: "0", ctimeNs: "0", uid, gid };
}

export interface FolderLocation {
  scope: FolderScope;
  inside: string;
}

export class WorkFolderNamespace {
  readonly dogs: Set<string>;
  readonly tasks: Map<string, Set<string>>;
  readonly projects: Map<string, FolderScope>;
  readonly stateFile: string;
  readonly loose?: FolderScope;
  constructor(readonly layout: WorkFolderLayout, readonly dataDir: string, looseDirectory: string) {
    this.stateFile = join(dataDir, "work-folder-names.json");
    const saved: {dogs: string[]; tasks: Record<string, string[]>} = existsSync(this.stateFile)
      ? JSON.parse(readFileSync(this.stateFile, "utf8")) : layout;
    if (!Array.isArray(saved.dogs) || !saved.tasks || typeof saved.tasks !== "object") throw new Error("Invalid working folder names");
    this.dogs = new Set(saved.dogs);
    this.tasks = new Map(Object.entries(saved.tasks).map(([dog, threads]) => [dog, new Set(threads)]));
    this.projects = new Map(layout.projects.map(project => {
      const id = projectFolderId(project.path);
      return [id, { id, owner: project.owner, path: project.path }];
    }));
    if (layout.loose) this.loose = { owner: layout.loose.owner, id: "loose", path: looseDirectory };
  }
  list(path: string): string[] | null {
    if (!path) return ["dogs", "tasks", ...this.projects.keys(), ...(this.loose ? ["loose"] : [])];
    if (path === "dogs") return [...this.dogs];
    if (path === "tasks") return [...this.tasks.keys()];
    const [kind, dog, more] = path.split("/");
    if (kind === "tasks" && dog && more === undefined && this.tasks.has(dog)) return [...this.tasks.get(dog)!];
    return null;
  }
  isFolderRoot(path: string): boolean {
    const fields = path.split("/");
    return fields[0] === "dogs" && fields.length === 2 || fields[0] === "tasks" && fields.length === 3;
  }
  resolve(path: string): FolderLocation | null {
    if (!path) return null;
    if (!safeWorkFolderPath(path)) throw folderError("EINVAL");
    const [kind, dog, thread, ...tail] = path.split("/");
    const project = kind === "loose" ? this.loose : this.projects.get(kind!);
    if (project) return { scope: project, inside: path.slice(kind!.length + 1) };
    if (!dog) return null;
    if (kind === "dogs" && this.dogs.has(dog) && validWorkFolderScope(dog, "dog")) {
      return { scope: { owner: dog, id: "dog", path: join(this.dataDir, "workspaces", dog) }, inside: path.split("/").slice(2).join("/") };
    }
    if (kind === "tasks" && thread && validWorkFolderScope(dog, "task-" + thread) && this.tasks.get(dog)?.has(thread)) {
      return { scope: { owner: dog, id: "task-" + thread, path: join(this.dataDir, "task-workspaces", dog, thread) }, inside: tail.join("/") };
    }
    return null;
  }
  update(path: string, add: boolean): void {
    if (!safeWorkFolderPath(path)) throw folderError("EINVAL");
    const [kind, dog, thread, ...rest] = path.split("/");
    if (!dog || !validWorkFolderScope(dog, thread ? "task-" + thread : "dog") || rest.length) throw folderError("EINVAL");
    let set: Set<string> | undefined;
    let name: string;
    if (kind === "dogs" && !thread) { set = this.dogs; name = dog; }
    else if (kind === "tasks" && thread) { set = this.tasks.get(dog); name = thread; }
    else if (kind === "tasks" && !thread) {
      if (add && this.tasks.has(dog)) throw folderError("EEXIST");
      if (!add && this.tasks.get(dog)?.size) throw folderError("ENOTEMPTY");
      if (!add && !this.tasks.has(dog)) throw folderError("ENOENT");
      const before = this.tasks.get(dog);
      if (add) this.tasks.set(dog, new Set()); else this.tasks.delete(dog);
      try {
        this.persist();
      } catch (error) {
        if (before) this.tasks.set(dog, before); else this.tasks.delete(dog);
        throw error;
      }
      return;
    } else throw folderError("EINVAL");
    if (!set || (!add && !set.has(name))) throw folderError("ENOENT");
    if (add && set.has(name)) throw folderError("EEXIST");
    if (add) set.add(name); else set.delete(name);
    try {
      this.persist();
    } catch (error) {
      if (add) set.delete(name); else set.add(name);
      throw error;
    }
  }
  private persist(): void {
    writeFileAtomic(this.stateFile, JSON.stringify({ dogs: [...this.dogs], tasks: Object.fromEntries([...this.tasks].map(([dog, threads]) => [dog, [...threads]])) }), { mode: 0o600 });
  }
}
