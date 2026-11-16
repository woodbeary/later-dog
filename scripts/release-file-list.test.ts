import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acceptedFrom, appFiles, goneFiles, serverScriptsShrank } from "./release-file-list.mjs";

const script = fileURLToPath(new URL("./release-file-list.mjs", import.meta.url));
const app = "later.dog.app/Contents";
const previous = [
  `${app}/`,
  `${app}/Info.plist`,
  `${app}/MacOS/later.dog`,
  `${app}/Resources/later.dog Speech.app/Contents/MacOS/speech-helper`,
  `${app}/Resources/server/laterdog/old-route.js`,
  `${app}/Resources/server/native/screen.node`,
  `${app}/Resources/server/bin/helper`,
  `${app}/Resources/server/model-catalog/snapshot.json`,
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

  it("names every file that is gone except server/ scripts and hashed ui bundles, native files in server/ included, and nothing that was added", () => {
    expect(goneFiles(previous, current)).toEqual([
      `${app}/Resources/later.dog Speech.app/Contents/MacOS/speech-helper`,
      `${app}/Resources/server/bin/helper`,
      `${app}/Resources/server/model-catalog/snapshot.json`,
      `${app}/Resources/server/native/screen.node`,
    ]);
    expect(goneFiles(previous, previous)).toEqual([]);
  });

  it("stops when every server/ script is gone, or fewer than half of them are left, whatever was accepted", () => {
    const scripts = (count: number) => Array.from({ length: count }, (_, index) => `${app}/Resources/server/laterdog/part-${index}.js`).join("\n");
    const base = `${app}/Info.plist\n`;
    expect(serverScriptsShrank(base + scripts(10), base + scripts(10))).toBeNull();
    expect(serverScriptsShrank(base + scripts(10), base + scripts(5))).toBeNull();
    expect(serverScriptsShrank(base + scripts(10), base + scripts(4))).toBe(`the new app has 4 .js scripts under server/, fewer than half of the previous release's 10`);
    expect(serverScriptsShrank(base + scripts(10), base)).toBe("the new app has no .js scripts under server/ (the previous release had 10)");
    expect(serverScriptsShrank(base, base + scripts(3))).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "laterdog-release-list-"));
    dirs.push(dir);
    writeFileSync(join(dir, "previous.txt"), base + scripts(10));
    writeFileSync(join(dir, "current.txt"), base);
    const stopped = spawnSync(process.execPath, [script, join(dir, "previous.txt"), join(dir, "current.txt")], { encoding: "utf8", env: { ...process.env, LATERDOG_RELEASE_ACCEPT_GONE: "" } });
    expect(stopped.status).toBe(1);
    expect(stopped.stderr).toContain("The new app has no .js scripts under server/");
  });

  it("lets the person accept a file that is meant to be gone", () => {
    const accepted = acceptedFrom(`\n  ${app}/Resources/later.dog Speech.app/Contents/MacOS/speech-helper  \n${app}/Resources/server/bin/helper\n${app}/Resources/server/model-catalog/snapshot.json\n${app}/Resources/server/native/screen.node\n`);
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
    writeFileSync(join(dir, "empty.txt"), `${app}/\n\n`);
    for (const pair of [["empty.txt", "current.txt"], ["previous.txt", "empty.txt"]]) {
      const empty = spawnSync(process.execPath, [script, ...pair.map((name) => join(dir, name))], { encoding: "utf8", env });
      expect(empty.status, pair.join(" ")).toBe(1);
      expect(empty.stderr).toContain("file list is empty");
    }
  });
});
