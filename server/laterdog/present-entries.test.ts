import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { presentEntry, presentNames, unlessGone } from "./present-entries.ts";

const folders: string[] = [];
function folder(): string {
  const path = mkdtempSync(join(tmpdir(), "laterdog-present-"));
  folders.push(path);
  return path;
}
afterEach(() => { for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true }); });

function missing(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });
}

describe("present entries", () => {
  it("reads what is there and answers nothing for what is gone", () => {
    const root = folder();
    writeFileSync(join(root, "bots.json"), "[]");
    expect(presentEntry(join(root, "bots.json"))?.isFile()).toBe(true);
    expect(presentEntry(join(root, "account-snapshots.json.4242.tmp"))).toBeNull();
    expect(presentNames(root)).toEqual(["bots.json"]);
    expect(presentNames(join(root, "removed"))).toEqual([]);
  });

  it("still fails on anything other than a missing entry", () => {
    const root = folder();
    writeFileSync(join(root, "bots.json"), "[]");
    expect(() => presentNames(join(root, "bots.json"))).toThrow(/ENOTDIR/);
  });

  it("drops a read whose file disappeared and undoes its partial copy", () => {
    const root = folder();
    const gone = join(root, "account-snapshots.json.4242.tmp");
    let forgotten = 0;
    expect(unlessGone(gone, () => { throw missing(gone); }, () => { forgotten++; })).toBeNull();
    expect(forgotten).toBe(1);
  });

  it("keeps the error when the file is still there", () => {
    const root = folder();
    const kept = join(root, "bots.json");
    writeFileSync(kept, "[]");
    expect(() => unlessGone(kept, () => { throw missing(join(root, "elsewhere")); }, () => {})).toThrow(/ENOENT/);
    expect(() => unlessGone(join(root, "gone"), () => { throw new Error("A workspace file changed during backup."); }, () => {})).toThrow(/changed during backup/);
  });
});
