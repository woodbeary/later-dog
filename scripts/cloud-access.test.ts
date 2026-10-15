import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cloudAccessPath as desktopCloudAccessPath, createCloudAppsAccess } from "../electron/cloud-apps-access.mjs";
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

  it("is the file the installed desktop app writes", () => {
    expect(desktopCloudAccessPath("/Users/someone/Library/Application Support/later.dog")).toBe(cloudAccessPath({}, "darwin", "/Users/someone"));
  });

  it("reads exactly what the desktop app saves after minting the apps session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-cloud-access-"));
    made.push(dir);
    const saved = join(dir, "cloud-access.json");
    const fetchImpl = async () => new Response(JSON.stringify({ token: "laterdog_sess_minted" }), { status: 200, headers: { "content-type": "application/json" } });
    const destination = { kind: "cloud", origin: "https://abc-home.later.dog", grant: async () => ({ origin: "https://abc-home.later.dog", code: "ABCD-EFGH-JKLM" }) };
    await createCloudAppsAccess({ file: saved, fetchImpl }).ensure(destination);
    expect(readCloudAccess(saved)).toEqual({ url: "https://abc-home.later.dog", token: "laterdog_sess_minted" });
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

  it("ignores a link to the file and a file owned by someone else", () => {
    const real = file(good);
    const link = `${real}.link`;
    symlinkSync(real, link);
    expect(readCloudAccess(link)).toBeUndefined();
    expect(readCloudAccess(real, { uid: (process.getuid?.() ?? 0) + 1, platform: "darwin" })).toBeUndefined();
  });
});
