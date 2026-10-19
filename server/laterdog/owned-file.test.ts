import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { damagedCopyName, readOwnedJson } from "./owned-file.ts";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-owned-file-"));
  dirs.push(dir);
  return dir;
};
const list = (raw: unknown) => (Array.isArray(raw) ? raw as number[] : undefined);
const at = (iso: string) => () => new Date(iso);
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readOwnedJson", () => {
  it("says a missing file is absent and makes no copy", () => {
    const dir = temp();
    expect(readOwnedJson(join(dir, "bots.json"), list)).toEqual({ state: "absent" });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("returns a readable file's value and makes no copy", () => {
    const dir = temp();
    writeFileSync(join(dir, "bots.json"), "[1,2]");
    expect(readOwnedJson(join(dir, "bots.json"), list)).toEqual({ state: "ok", value: [1, 2] });
    expect(readdirSync(dir)).toEqual(["bots.json"]);
  });

  it.each([
    ["truncated JSON", '[{"id":"rex","name":"Re'],
    ["an empty file", ""],
    ["the wrong shape", '{"id":"rex"}'],
  ])("keeps %s byte for byte as a private .damaged copy and leaves the file in place", (_label, bytes) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = temp();
    const file = join(dir, "bots.json");
    writeFileSync(file, bytes);
    const read = readOwnedJson(file, list, at("2026-10-18T07:12:03.456Z"));
    expect(read).toEqual({ state: "damaged", keptAs: "bots.json.damaged-2026-10-18T07-12-03-456Z" });
    const kept = join(dir, "bots.json.damaged-2026-10-18T07-12-03-456Z");
    expect(readFileSync(kept, "utf8")).toBe(bytes);
    expect(readFileSync(file, "utf8")).toBe(bytes);
    if (process.platform !== "win32") expect(statSync(kept).mode & 0o777).toBe(0o600);
  });

  it("treats a parser that throws as damage", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = temp();
    writeFileSync(join(dir, "routines.json"), '{"routines":[null]}');
    const read = readOwnedJson(join(dir, "routines.json"), (raw) => (raw as { routines: Array<{ id: string }> }).routines.map((routine) => routine.id));
    expect(read.state).toBe("damaged");
  });

  it("reuses the last copy when the same damaged bytes are read again on the next start", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = temp();
    const file = join(dir, "groups.json");
    writeFileSync(file, "[{");
    expect(readOwnedJson(file, list, at("2026-10-18T07:00:00.000Z"))).toMatchObject({ keptAs: "groups.json.damaged-2026-10-18T07-00-00-000Z" });
    expect(readOwnedJson(file, list, at("2026-10-18T08:00:00.000Z"))).toMatchObject({ keptAs: "groups.json.damaged-2026-10-18T07-00-00-000Z" });
    writeFileSync(file, "[{,");
    expect(readOwnedJson(file, list, at("2026-10-18T09:00:00.000Z"))).toMatchObject({ keptAs: "groups.json.damaged-2026-10-18T09-00-00-000Z" });
    expect(readdirSync(dir).sort()).toEqual([
      "groups.json",
      "groups.json.damaged-2026-10-18T07-00-00-000Z",
      "groups.json.damaged-2026-10-18T09-00-00-000Z",
    ]);
  });

  it("names copies with no colons so every file system accepts them", () => {
    expect(damagedCopyName("/data/bots.json", new Date("2026-10-18T07:12:03.456Z"))).toBe("bots.json.damaged-2026-10-18T07-12-03-456Z");
  });
});
