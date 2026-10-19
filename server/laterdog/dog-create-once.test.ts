import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DOG_CREATE_RETENTION_MS, DogCreateJournal, parseCreateId, parseHello } from "./dog-create-once.ts";

const dirs: string[] = [];
const journalFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-dog-create-"));
  dirs.push(dir);
  return join(dir, "dog-create-requests.json");
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseCreateId", () => {
  it("accepts a client id the same shape as a send id, and nothing at all", () => {
    expect(parseCreateId("2f1c0e4b-8d7a-4c1e-9b3f-0a1b2c3d4e5f")).toBe("2f1c0e4b-8d7a-4c1e-9b3f-0a1b2c3d4e5f");
    expect(parseCreateId(undefined)).toBeUndefined();
    expect(parseCreateId(null)).toBeUndefined();
  });

  it.each(["short", "has spaces in it ok", 42, "x".repeat(81)])("refuses %j with a 400", (value) => {
    expect(() => parseCreateId(value)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("parseHello", () => {
  it("defaults to no hello and refuses anything but a boolean", () => {
    expect(parseHello(undefined)).toBe(false);
    expect(parseHello(true)).toBe(true);
    expect(() => parseHello("yes")).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("DogCreateJournal", () => {
  it("remembers which dog a create id made, across restarts, in a private file", () => {
    const file = journalFile();
    new DogCreateJournal(file).remember("sheet-0123456789abcdef", "rex");
    expect(new DogCreateJournal(file).find("sheet-0123456789abcdef")).toBe("rex");
    expect(new DogCreateJournal(file).find("sheet-fedcba9876543210")).toBeUndefined();
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("forgets a create id after 24 hours", () => {
    const file = journalFile();
    let now = 1_000_000;
    const journal = new DogCreateJournal(file, () => now);
    journal.remember("sheet-0123456789abcdef", "rex");
    now += DOG_CREATE_RETENTION_MS - 1;
    expect(journal.find("sheet-0123456789abcdef")).toBe("rex");
    now += 1;
    expect(journal.find("sheet-0123456789abcdef")).toBeUndefined();
    journal.remember("sheet-fedcba9876543210", "juniper");
    expect(JSON.parse(readFileSync(file, "utf8")).requests.map((request: { botId: string }) => request.botId)).toEqual(["juniper"]);
  });

  it("starts empty when its own file cannot be read", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = journalFile();
    writeFileSync(file, "{");
    const journal = new DogCreateJournal(file);
    expect(journal.find("sheet-0123456789abcdef")).toBeUndefined();
    journal.remember("sheet-0123456789abcdef", "rex");
    expect(new DogCreateJournal(file).find("sheet-0123456789abcdef")).toBe("rex");
  });
});
