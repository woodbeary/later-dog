import { describe, expect, it } from "vitest";
import type { EngineWorkFolder } from "./engine-folder-sync.ts";
import { publishNewTaskFolders, taskFolderOf } from "./task-machine-folders.ts";

const folder = (scope: string, path = `/data/${scope}`) => ({ path, grant: { baseUrl: `https://home.example/api/work-folders/v1/dog-1/${scope}` } }) as unknown as EngineWorkFolder;

function stores(heads: Record<string, boolean>, race = false) {
  const published: string[] = [];
  const open = (f: EngineWorkFolder) => ({
    head: async () => heads[f.path] ? { revision: "r" } : null,
    publishEmpty: async () => { if (race) throw new Error("Another writer has already published this working folder"); published.push(f.path); },
  });
  return { open, published };
}

describe("a new task's folder on a task machine", () => {
  it("names the thread a task folder belongs to", () => {
    expect(taskFolderOf(folder("task-t1"))).toBe("t1");
    expect(taskFolderOf(folder("dog"))).toBeNull();
  });

  it("publishes an empty first version only for this new task's own unpublished folder", async () => {
    const s = stores({ "/data/dog": true });
    const done = await publishNewTaskFolders([folder("dog"), folder("task-t1"), folder("task-t2")], "t1", true, s.open);
    expect(done).toEqual(["/data/task-t1"]);
    expect(s.published).toEqual(["/data/task-t1"]);
  });

  it("leaves an older task's folder and an already published one alone, and accepts losing the race to another writer", async () => {
    const old = stores({});
    expect(await publishNewTaskFolders([folder("task-t1")], "t1", false, old.open)).toEqual([]);
    const live = stores({ "/data/task-t1": true });
    expect(await publishNewTaskFolders([folder("task-t1")], "t1", true, live.open)).toEqual([]);
    expect(await publishNewTaskFolders([folder("task-t1")], "t1", true, stores({}, true).open)).toEqual([]);
  });
});
