import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { prepareEngineFolderTools, type EngineBox } from "./engine-computer.ts";
import { PINNED_FOLDER_HELPER_ENV } from "./engine-folder-helper-source.ts";

const dirs: string[] = [];
afterEach(() => {
  delete process.env[PINNED_FOLDER_HELPER_ENV];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function computer() {
  let installed: Buffer | undefined;
  let staged: Buffer | undefined;
  const box: EngineBox = {
    async exec(command) {
      if (command.includes("mkdir -p")) {
        const wanted = /= '([0-9a-f]{64})'$/.exec(command)?.[1];
        const same = installed && createHash("sha256").update(installed).digest("hex") === wanted;
        return { exitCode: same ? 0 : 1, stdout: "", stderr: "" };
      }
      installed = staged;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async write(_path, bytes) { staged = Buffer.from(bytes); },
  };
  return { box, installed: () => installed?.toString("utf8") };
}

it("installs the folder helper of the server running now, and follows it when that server changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folder-helper-"));
  dirs.push(dir);
  const pinned = join(dir, "engine-folder-cli.js");
  writeFileSync(pinned, "export const helper = 'from the first bundle';\n");
  process.env[PINNED_FOLDER_HELPER_ENV] = pinned;
  const guest = computer();
  await prepareEngineFolderTools(guest.box);
  expect(guest.installed()).toBe("export const helper = 'from the first bundle';\n");
  writeFileSync(pinned, "export const helper = 'from the next bundle, which saves faster';\n");
  await prepareEngineFolderTools(guest.box);
  expect(guest.installed()).toBe("export const helper = 'from the next bundle, which saves faster';\n");
});

it("leaves a computer alone when it already has the running server's helper", async () => {
  const dir = mkdtempSync(join(tmpdir(), "folder-helper-"));
  dirs.push(dir);
  const pinned = join(dir, "engine-folder-cli.js");
  writeFileSync(pinned, "export const helper = 'current';\n");
  process.env[PINNED_FOLDER_HELPER_ENV] = pinned;
  const guest = computer();
  let writes = 0;
  const write = guest.box.write.bind(guest.box);
  guest.box.write = async (path, bytes) => { writes++; return write(path, bytes); };
  await prepareEngineFolderTools(guest.box);
  await prepareEngineFolderTools(guest.box);
  expect(writes).toBe(1);
});
