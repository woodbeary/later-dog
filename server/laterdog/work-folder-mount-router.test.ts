import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkFolderLayout } from "../../shared/work-folder-layout.ts";
import { assignedCwd, engineFolderScopes, linkedProjects, projectFolderId, projectLink, scopeForPath } from "./work-folder-locations.ts";
import { WorkFolderNamespace } from "./work-folder-namespace.ts";
import { WorkFolderMountRouter } from "./work-folder-mount-router.ts";
import { DurableFolderRead } from "./work-folder-durable-read.ts";

const data = "/data/.laterdog";
const layout: WorkFolderLayout = {
  dogs: ["lab", "pup"], tasks: { lab: ["build"] },
  projects: [
    { path: "/data/shared", owner: "pup", members: ["lab"] },
    { path: "/data/other", owner: "pup", members: [] },
  ],
  loose: { owner: "lab", members: [], names: ["notes.txt"] },
  links: { "lab/task-build": ["/data/shared", "/data/other"] },
};

describe("working folder placement", () => {
  it("limits historical link dependencies to projects already shared with the dog", () => {
    const cwd = data + "/task-workspaces/lab/build";
    const task = scopeForPath(layout, data, cwd, "lab")!;
    expect(linkedProjects(layout, data, task, "lab").map(item => item.path)).toEqual(["/data/shared"]);
    expect(projectLink(layout, data, task, "link", "/data/shared/example")).toBe("/run/laterdog-work-folders/tree/" + projectFolderId("/data/shared") + "/example");
    expect(projectLink(layout, data, task, "link", "/data/other/private")).toBeNull();
    const scopes = engineFolderScopes(layout, data, { botId: "lab", cwd, roots: [{ id: "workspace", path: cwd, writable: true }] });
    expect(scopes.map(item => item.id)).toEqual([projectFolderId("/data/shared"), "dog", "task-build"]);
    expect(scopeForPath(layout, data, cwd, "pup")).toBeNull();
    expect(assignedCwd(layout, data, "lab", "/data")).toBe("/data/.laterdog-owned-work/visible");
    expect(() => assignedCwd(layout, data, "pup", "/data")).toThrow();
  });
});

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

it("allows a new empty cold folder to be listed and removed without starting a computer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folder-mount-"));
  folders.push(dir);
  const names = new WorkFolderNamespace(layout, dir, join(dir, "visible"));
  const open = vi.fn(async () => { throw Error("unexpected computer start"); });
  const remove = vi.fn(async () => {});
  const entries = JSON.stringify({ v: 1, kind: "entries", entries: [] });
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const manifest = JSON.stringify({ v: 1, kind: "root", mode: 0o700, entries: hash(entries) });
  const head = { manifest: hash(manifest) };
  const create = vi.fn(async () => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/head")) return Response.json(head);
    if (url.endsWith(hash(manifest))) return new Response(manifest);
    if (url.endsWith(hash(entries))) return new Response(entries);
    throw Error("Unexpected cold read");
  }));
  const router = new WorkFolderMountRouter(names, open, remove, 1000, 1000, () => {}, async () => new DurableFolderRead("https://test.invalid", "scoped", 1000, 1000), undefined, create);
  const path = "dogs/new";
  const send = (op: string, handle?: string) => router.dispatch({ op, path, root: "work-folders", handle });
  const made = await send("mkdir");
  expect(made.ok).toBe(true);
  expect(create).toHaveBeenCalledOnce();
  await expect(send("mkdir")).rejects.toHaveProperty("code", "EEXIST");
  expect((await send("getattr")).attr).toMatchObject({ ino: (made.attr as {ino:string}).ino });
  const handle = (await send("opendir")).handle;
  expect(handle).toBeTruthy();
  expect(await send("readdir", handle)).toEqual({ ok: true, entries: [] });
  await send("releasedir", handle);
  expect(await send("rmdir")).toEqual({ ok: true });
  await expect(send("getattr")).rejects.toHaveProperty("code", "ENOENT");
  expect(open).not.toHaveBeenCalled();
  expect(remove).toHaveBeenCalledOnce();
  await router.close();
});

it("restores the namespace after an unsuccessful metadata write", () => {
  const dir = mkdtempSync(join(tmpdir(), "folder-names-"));
  const names = new WorkFolderNamespace(layout, dir, join(dir, "visible"));
  rmSync(dir, { recursive: true });
  expect(() => names.update("dogs/new", true)).toThrow();
  expect(names.resolve("dogs/new")).toBeNull();
});

it("closes pending guest operations even when the transport never acknowledges a close", async () => {
  const { EventEmitter } = await import("node:events");
  const { GuestFsChannel } = await import("./work-folder-guest-fs.ts");
  const link = Object.assign(new EventEmitter(), { send: vi.fn(), close: vi.fn() });
  const channel = new GuestFsChannel(link);
  link.emit("line", '{"ready":true,"version":1}');
  await channel.ready;
  const pending = channel.call({ op: "getattr", root: "dog", path: "" });
  channel.close();
  await expect(pending).rejects.toHaveProperty("code", "EIO");
});

it("keeps an idle dog folder open after saving it, so the next look does not reopen and re-check it out", async () => {
  vi.useFakeTimers();
  try {
    const dir = mkdtempSync(join(tmpdir(), "folder-mount-"));
    folders.push(dir);
    const names = new WorkFolderNamespace(layout, dir, join(dir, "visible"));
    const close = vi.fn();
    const checkpoint = vi.fn(async () => {});
    const open = vi.fn(async () => ({ channel: { closed: false, close, call: async () => ({ ok: true, attr: { ino: "7", mode: 0o100600, size: "1" } }) }, checkpoint }));
    const router = new WorkFolderMountRouter(names, open as never, vi.fn(async () => {}), 1000, 1000, () => {}, async () => null);
    const look = () => router.dispatch({ op: "getattr", path: "dogs/lab/MEMORY.md", root: "work-folders" });
    await look();
    expect(open).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    await look();
    expect(open).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(close).toHaveBeenCalledOnce();
    await look();
    expect(open).toHaveBeenCalledTimes(2);
    await router.close();
  } finally { vi.useRealTimers(); }
});
