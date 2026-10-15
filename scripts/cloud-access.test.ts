import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloudAccessPath, readCloudAccess } from "./cloud-access.ts";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function file(content: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-cloud-access-"));
  made.push(dir);
  const path = join(dir, "cloud-access.json");
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
  return path;
}
const good = JSON.stringify({ url: "https://abc-home.later.dog", token: "laterdog_sess_abc123" });

describe("apps on this Mac reaching My Cloud", () => {
  it("lives next to the local tools token", () => {
    expect(cloudAccessPath({}, "darwin", "/Users/someone")).toBe("/Users/someone/Library/Application Support/later.dog/cloud-access.json");
  });

  it("reads a private file the desktop app wrote", () => {
    expect(readCloudAccess(file(good))).toEqual({ url: "https://abc-home.later.dog", token: "laterdog_sess_abc123" });
  });

  it("ignores a file others can read, a plain-HTTP or pathed address, and anything that is not a session", () => {
    expect(readCloudAccess(file(good, 0o644))).toBeUndefined();
    expect(readCloudAccess(file(JSON.stringify({ url: "http://abc-home.later.dog", token: "laterdog_sess_abc" })))).toBeUndefined();
    expect(readCloudAccess(file(JSON.stringify({ url: "https://abc-home.later.dog/x", token: "laterdog_sess_abc" })))).toBeUndefined();
    expect(readCloudAccess(file(JSON.stringify({ url: "https://abc-home.later.dog", token: "secret" })))).toBeUndefined();
    expect(readCloudAccess(join(tmpdir(), "laterdog-missing", "cloud-access.json"))).toBeUndefined();
  });
});
