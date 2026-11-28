import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { DurableFolderRead } from "./work-folder-durable-read.ts";

afterEach(() => vi.unstubAllGlobals());

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

it("looks up many files in a sleeping dog's folder with one listing range read and one head read", async () => {
  const objects = new Map<string, string>();
  const put = (value: unknown) => { const text = JSON.stringify(value); objects.set(hashOf(text), text); return hashOf(text); };
  const files = Array.from({ length: 80 }, (_, n) => ({ kind: "file", path: `memory/note-${String(n).padStart(2, "0")}.md`, mode: 0o600, size: 1, sha256: "0".repeat(64), contents: "1".repeat(64) }));
  const first = put({ v: 1, kind: "entries", entries: files.slice(0, 64) });
  const second = put({ v: 1, kind: "entries", entries: files.slice(64) });
  const pages = put({ v: 1, kind: "pages", of: "entries", children: [first, second] });
  const root = put({ v: 1, kind: "root", mode: 0o700, entries: pages });
  const ranges = { children: [
    { hash: first, of: "entries", bytes: 64, count: 64, first: files[0]!.path, last: files[63]!.path },
    { hash: second, of: "entries", bytes: 16, count: 16, first: files[64]!.path, last: files[79]!.path },
  ] };
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url).pathname.split("/").slice(-2).join("/");
    calls.push(path.startsWith("manifests/") ? "manifests" : path.split("/")[0] === "ranges" ? "ranges" : path);
    if (path.endsWith("/head") || path === "head") return Response.json({ revision: "a".repeat(64), manifest: root, state: "live" });
    if (path.startsWith("ranges/")) return Response.json(ranges);
    const text = objects.get(path.split("/")[1]!);
    return text ? new Response(text) : new Response("missing", { status: 404 });
  }));
  const reader = new DurableFolderRead("https://test.invalid/api/work-folders/v1/dog_A/dog", "scoped", 1000, 1000);
  for (const file of [files[3]!, files[70]!, files[40]!, files[79]!]) expect((await reader.lookup(file.path)).item.path).toBe(file.path);
  expect(calls.filter((call) => call === "ranges")).toHaveLength(1);
  expect(calls.filter((call) => call.endsWith("head"))).toHaveLength(1);
});

it("lists a sleeping dog's memory folder page by page with the mount's numeric positions", async () => {
  const objects = new Map<string, string>();
  const put = (value: unknown) => { const text = JSON.stringify(value); objects.set(hashOf(text), text); return hashOf(text); };
  const notes = Array.from({ length: 70 }, (_, n) => ({ kind: "file", path: `memory/note-${String(n).padStart(2, "0")}.md`, mode: 0o600, size: 1, sha256: "0".repeat(64), contents: "1".repeat(64) }));
  const entries = [{ kind: "file", path: "AGENTS.md", mode: 0o600, size: 1, sha256: "0".repeat(64), contents: "1".repeat(64) }, { kind: "dir", path: "memory", mode: 0o700 }, ...notes, { kind: "dir", path: "memory/log", mode: 0o700 }, { kind: "file", path: "memory/log/today.md", mode: 0o600, size: 1, sha256: "0".repeat(64), contents: "1".repeat(64) }, { kind: "file", path: "notes.txt", mode: 0o600, size: 1, sha256: "0".repeat(64), contents: "1".repeat(64) }];
  const page = put({ v: 1, kind: "entries", entries });
  const root = put({ v: 1, kind: "root", mode: 0o700, entries: page });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url).pathname.split("/").slice(-2).join("/");
    if (path.endsWith("/head") || path === "head") return Response.json({ revision: "a".repeat(64), manifest: root, state: "live" });
    const text = objects.get(path.split("/")[1]!);
    return text ? new Response(text) : new Response("missing", { status: 404 });
  }));
  const reader = new DurableFolderRead("https://test.invalid/api/work-folders/v1/dog_A/dog", "scoped", 1000, 1000);
  const memory = await reader.lookup("memory");
  const first = await reader.operate(memory, { op: "readdir", root: "dog", path: "", cursor: "0" });
  expect(first.ok).toBe(true);
  expect(first.entries).toHaveLength(64);
  expect(first.next).toBe("64");
  const second = await reader.operate(memory, { op: "readdir", root: "dog", path: "", cursor: "64" });
  expect((second.entries as { name: string }[]).map((entry) => entry.name)).toEqual([...notes.slice(64).map((note) => note.path.slice("memory/".length)), "log"]);
  expect(second.next).toBeUndefined();
  const top = await reader.operate(await reader.lookup(""), { op: "readdir", root: "dog", path: "", cursor: "0" });
  expect((top.entries as { name: string }[]).map((entry) => entry.name)).toEqual(["AGENTS.md", "memory", "notes.txt"]);
});
