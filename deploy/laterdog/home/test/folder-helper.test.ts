import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { pinFolderHelper } from "../runtime/folder-helper.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function server(root: string, name: string, helper: string) {
  const dir = join(root, name);
  mkdirSync(join(dir, "laterdog"), { recursive: true });
  writeFileSync(join(dir, "cloud-home-start.js"), "");
  writeFileSync(join(dir, "laterdog", "engine-folder-cli.js"), helper);
  return join(dir, "cloud-home-start.js");
}

it("pins the folder helper of whichever server the home runs, replacing it on a switch", async () => {
  const root = mkdtempSync(join(tmpdir(), "pin-helper-"));
  dirs.push(root);
  const target = join(root, "run", "engine-folder-cli.js");
  expect(await pinFolderHelper(server(root, "image", "image helper"), target)).toBe(target);
  expect(readFileSync(target, "utf8")).toBe("image helper");
  expect(statSync(target).mode & 0o777).toBe(0o644);
  await pinFolderHelper(server(root, "pushed", "pushed helper"), target);
  expect(readFileSync(target, "utf8")).toBe("pushed helper");
});

it("keeps the pinned helper when the next server has none", async () => {
  const root = mkdtempSync(join(tmpdir(), "pin-helper-"));
  dirs.push(root);
  const target = join(root, "run", "engine-folder-cli.js");
  await pinFolderHelper(server(root, "image", "image helper"), target);
  mkdirSync(join(root, "bare"));
  await expect(pinFolderHelper(join(root, "bare", "cloud-home-start.js"), target)).rejects.toThrow();
  expect(readFileSync(target, "utf8")).toBe("image helper");
});
