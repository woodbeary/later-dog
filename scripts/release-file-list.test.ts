import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acceptedFrom, appFiles, goneFiles } from "./release-file-list.mjs";

const script = fileURLToPath(new URL("./release-file-list.mjs", import.meta.url));
const app = "later.dog.app/Contents";
const previous = [
  `${app}/`,
  `${app}/Info.plist`,
  `${app}/MacOS/later.dog`,
  `${app}/Resources/later.dog Speech.app/Contents/MacOS/speech-helper`,
  `${app}/Resources/server/laterdog/old-route.js`,
  `${app}/Resources/ui/assets/index-Ab12Cd34.js`,
  `${app}/Resources/ui/index.html`,
].join("\n");
const current = [
  `${app}/`,
  `${app}/Info.plist`,
  `${app}/MacOS/later.dog`,
  `${app}/Resources/server/laterdog/new-route.js`,
  `${app}/Resources/ui/assets/index-Zz99Yy88.js`,
  `${app}/Resources/ui/index.html`,
  `${app}/Resources/brand-new.txt`,
].join("\n");

describe("release file list", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("reads files and links, not folders", () => {
    expect([...appFiles(`${app}/\n${app}/Info.plist\n\n`)]).toEqual([`${app}/Info.plist`]);
  });

  it("names a file gone outside server/ and the hashed ui bundles, and nothing that was added", () => {
    expect(goneFiles(previous, current)).toEqual([`${app}/Resources/later.dog Speech.app/Contents/MacOS/speech-helper`]);
    expect(goneFiles(previous, previous)).toEqual([]);
  });

  it("lets the person accept a file that is meant to be gone", () => {
    const accepted = acceptedFrom(`\n  ${app}/Resources/later.dog Speech.app/Contents/MacOS/speech-helper  \n`);
    expect(goneFiles(previous, current, accepted)).toEqual([]);
  });

  it("stops with a non-zero exit and names the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "laterdog-release-list-"));
    dirs.push(dir);
    writeFileSync(join(dir, "previous.txt"), previous);
    writeFileSync(join(dir, "current.txt"), current);
    const env = { ...process.env, LATERDOG_RELEASE_ACCEPT_GONE: "" };
    const stopped = spawnSync(process.execPath, [script, join(dir, "previous.txt"), join(dir, "current.txt")], { encoding: "utf8", env });
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain("speech-helper");
    const same = spawnSync(process.execPath, [script, join(dir, "previous.txt"), join(dir, "previous.txt")], { encoding: "utf8", env });
    expect(same.status).toBe(0);
    expect(spawnSync(process.execPath, [script], { encoding: "utf8" }).status).toBe(2);
  });
});
