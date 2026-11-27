import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FOLDER_NOT_SAVED, folderAction, folderGlob, type FolderRun } from "./dog-folder.ts";
import { createMountGuard, MountDown } from "./mount-guard.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function folder() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "ld-folder-")));
  dirs.push(base);
  const work = join(base, "work");
  const other = join(base, "other");
  mkdirSync(join(work, "src"), { recursive: true });
  mkdirSync(join(work, "node_modules", "x"), { recursive: true });
  mkdirSync(other);
  writeFileSync(join(work, "notes.md"), "# Notes\nbuy milk\n");
  writeFileSync(join(work, "src", "app.ts"), "export const answer = 41;\n");
  writeFileSync(join(work, "node_modules", "x", "index.js"), "answer\n");
  writeFileSync(join(other, "secret.txt"), "not yours\n");
  const ran: string[] = [];
  const run: FolderRun = (path, op) => { ran.push(path); return op(); };
  return { base, work, other, run, ran, roots: [work] };
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

it("lists, reads and searches the dog's own folder, every call through the guard", async () => {
  const f = folder();
  const listed = await folderAction({ action: "list" }, f.roots, f.run);
  expect(listed.text).toContain("file notes.md");
  expect(listed.text).toContain("dir  src");
  const read = await folderAction({ action: "read", path: "notes.md" }, f.roots, f.run);
  expect(read.text).toContain(`sha256 ${sha("# Notes\nbuy milk\n")}`);
  expect(read.text).toContain("buy milk");
  const found = await folderAction({ action: "search", pattern: "answer" }, f.roots, f.run);
  expect(found.text).toBe("src/app.ts:1: export const answer = 41;");
  expect((await folderAction({ action: "search", pattern: "milk", glob: "*.ts" }, f.roots, f.run)).text).toBe("No matches.");
  expect(f.ran.every((path) => path.startsWith(f.work))).toBe(true);
});

it("writes new files, refuses to overwrite blind, edits exactly and deletes", async () => {
  const f = folder();
  expect((await folderAction({ action: "write", path: "plans/today.md", content: "one\n" }, f.roots, f.run)).text).toContain("Created plans/today.md");
  expect(readFileSync(join(f.work, "plans", "today.md"), "utf8")).toBe("one\n");
  const blind = await folderAction({ action: "write", path: "notes.md", content: "gone" }, f.roots, f.run);
  expect(blind.status).toBe(409);
  const over = await folderAction({ action: "write", path: "notes.md", content: "new", expected_sha256: sha("# Notes\nbuy milk\n") }, f.roots, f.run);
  expect(over.text).toContain("Replaced notes.md");
  const edited = await folderAction({ action: "edit", path: "src/app.ts", old_text: "41", new_text: "42" }, f.roots, f.run);
  expect(edited.status).toBe(200);
  expect(readFileSync(join(f.work, "src", "app.ts"), "utf8")).toBe("export const answer = 42;\n");
  expect((await folderAction({ action: "edit", path: "src/app.ts", old_text: "nope", new_text: "x" }, f.roots, f.run)).status).toBe(409);
  expect((await folderAction({ action: "delete", path: "plans" }, f.roots, f.run)).status).toBe(409);
  await folderAction({ action: "delete", path: "plans/today.md" }, f.roots, f.run);
  expect((await folderAction({ action: "delete", path: "plans" }, f.roots, f.run)).text).toBe("Deleted plans.");
  expect(existsSync(join(f.work, "plans"))).toBe(false);
  expect((await folderAction({ action: "delete", path: "." }, f.roots, f.run)).status).toBe(403);
});

it("keeps every path inside the dog's folders, links included", async () => {
  const f = folder();
  expect((await folderAction({ action: "read", path: "../other/secret.txt" }, f.roots, f.run)).status).toBe(403);
  expect((await folderAction({ action: "read", path: join(f.other, "secret.txt") }, f.roots, f.run)).status).toBe(403);
  symlinkSync(f.other, join(f.work, "escape"));
  expect((await folderAction({ action: "read", path: "escape/secret.txt" }, f.roots, f.run)).status).toBe(403);
  const outside = await folderAction({ action: "write", path: "escape/new.txt", content: "x" }, f.roots, f.run);
  expect(outside.status).toBe(403);
  expect(outside.error).toMatch(/^Not saved: /);
  expect(existsSync(join(f.other, "new.txt"))).toBe(false);
  expect((await folderAction({ action: "read", path: join(f.other, "secret.txt") }, [f.work, f.other], f.run)).text).toContain("not yours");
  expect((await folderAction({ action: "list" }, [], f.run)).status).toBe(409);
  expect((await folderAction({ action: "chmod" }, f.roots, f.run)).status).toBe(400);
});

it("answers 503 when the dog's folder is not answering instead of holding the home", async () => {
  const f = folder();
  const guard = createMountGuard({ roots: () => [f.base], timeoutMs: 50, coolMs: 60_000 });
  const stuck: FolderRun = (path, op) => guard.run(path, () => new Promise((resolve) => setTimeout(resolve, 10_000)).then(op));
  const began = Date.now();
  const first = await folderAction({ action: "read", path: "notes.md" }, f.roots, stuck);
  expect(first.status).toBe(503);
  const write = await folderAction({ action: "write", path: "new.md", content: "x" }, f.roots, stuck);
  expect(write).toEqual({ status: 503, error: FOLDER_NOT_SAVED });
  const second = await folderAction({ action: "list" }, f.roots, stuck);
  expect(second.status).toBe(503);
  expect(Date.now() - began).toBeLessThan(2_000);
  expect(new MountDown("x").code).toBe("EMOUNTDOWN");
});

it("matches globs by name or by path", () => {
  expect(folderGlob("*.ts").test("src/app.ts")).toBe(true);
  expect(folderGlob("*.ts").test("src/app.tsx")).toBe(false);
  expect(folderGlob("src/**/*.md").test("src/a/b/c.md")).toBe(true);
  expect(folderGlob("src/*.md").test("src/a/c.md")).toBe(false);
});
