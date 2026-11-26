import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "../atomic.ts";
import { folderHash } from "./engine-folder-store.ts";
import { visitFolder } from "./engine-folder-files.ts";
import { guestFolderDir, syncFolder, type EngineWorkFolder } from "./engine-folder-sync.ts";

const read = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const idleScript = `import glob,os,sys
root=sys.argv[1]
def below(value):
 return value==root or value.startswith(root+"/")
for process in glob.glob("/proc/[0-9]*"):
 try:
  for ref in [process+"/cwd",process+"/root",*glob.glob(process+"/fd/*")]:
   try:
    if below(os.readlink(ref)): sys.exit(73)
   except FileNotFoundError: pass
  with open(process+"/maps") as rows:
   for row in rows:
    fields=row.rstrip("\\n").split(None,5)
    if len(fields)==6 and below(fields[5]): sys.exit(73)
 except (FileNotFoundError,ProcessLookupError): pass`;

export function assertProjectClosed(path: string) {
  if (process.platform !== "linux") throw new Error("Guest process ownership is unavailable.");
  const owned = process.getuid?.() === 0;
  try {
    execFileSync(owned ? "python3" : "sudo", [...(owned ? [] : ["-n", "python3"]), "-c", idleScript, path], {
      stdio: "ignore",
      timeout: 30_000,
    });
  } catch {
    throw new Error("Close files and processes using the shared project before changing access.");
  }
}

export async function releaseGuestProject(
  path: string,
  state: string,
  uri: string,
  guest: string,
  closed = assertProjectClosed,
  dataRoot = "/data",
) {
  if (
    dirname(path) !== dataRoot ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(basename(path)) ||
    !new URL(uri).pathname.endsWith("/project-" + folderHash(path))
  )
    throw new Error("Invalid shared project release.");
  const dir = guestFolderDir(path, state);
  const identity = join(dir, "grant.json"),
    checkpoint = join(dir, "checked.json"),
    journal = join(dir, "release.json");
  if (!existsSync(identity) && !existsSync(journal)) return;
  const binding = existsSync(identity) ? read<EngineWorkFolder>(identity) : null;
  if (binding && (binding.path !== path || binding.grant.baseUrl !== uri || binding.grant.guestId !== guest))
    throw new Error("Shared project belongs to a different computer.");
  let held: string,
    verified = false;
  if (existsSync(journal)) {
    const row = read<{ held: string; uri: string; guest: string; verified: boolean }>(journal);
    if (row.uri !== uri || row.guest !== guest)
      throw new Error("Shared project release belongs to a different computer.");
    held = row.held;
    verified = row.verified;
    if (dirname(held) !== dataRoot || !/^\.laterdog-release-[a-f0-9-]{36}$/.test(basename(held)))
      throw new Error("Invalid shared project recovery record.");
  } else {
    if (!binding || !existsSync(checkpoint) || realpathSync(path) !== path)
      throw new Error("The registered project is unavailable.");
    closed(path);
    await syncFolder(binding, state, undefined, undefined, dataRoot);
    held = join(dataRoot, ".laterdog-release-" + randomUUID());
    writeFileAtomic(journal, JSON.stringify({ held, uri, guest, verified: false }), { mode: 0o600 });
  }
  if (existsSync(path) && !verified) {
    if (existsSync(held) || realpathSync(path) !== path)
      throw new Error("Shared project changed while finishing its checkpoint.");
    closed(path);
    renameSync(path, held);
  }
  if (!verified && existsSync(held)) {
    try {
      if (realpathSync(held) !== held) throw new Error("Shared project identity changed.");
      closed(held);
      const saved = read<{ rootId: string; files: { entry: { path: string }; stamp: string }[] }>(checkpoint);
      const stat = lstatSync(held, { bigint: true });
      const current = await visitFolder(held);
      if (
        saved.rootId !== [stat.dev, stat.ino].join(":") ||
        current.stamps.size !== saved.files.length ||
        !saved.files.every((file) => current.stamps.get(file.entry.path) === file.stamp)
      )
        throw new Error("Working files changed after checkpoint.");
      closed(held);
      writeFileAtomic(journal, JSON.stringify({ held, uri, guest, verified: true }), { mode: 0o600 });
      verified = true;
    } catch (e) {
      if (!existsSync(path) && existsSync(held)) {
        renameSync(held, path);
        rmSync(journal, { force: true });
      }
      throw e;
    }
  }
  if (!verified) throw new Error("The saved project release could not be verified.");
  rmSync(held, { force: true, recursive: true });
  rmSync(checkpoint, { force: true });
  rmSync(join(dir, "rebuilding.json"), { force: true });
  rmSync(identity, { force: true });
  rmSync(journal, { force: true });
}

export function projectDependents(path: string, state: string) {
  if (!existsSync(state)) return [];
  return readdirSync(state)
    .filter((name) => /^[a-f0-9]{64}$/.test(name))
    .flatMap((name) => {
      const file = join(state, name, "grant.json");
      if (!existsSync(file)) return [];
      const binding = read<EngineWorkFolder>(file);
      if (guestFolderDir(binding.path, state) !== resolve(state, name))
        throw new Error("Working folder identity changed.");
      if (!binding.linkProjects?.includes(path) && !binding.aliases?.some((alias) => alias.target === path)) return [];
      return [
        {
          ...binding,
          linkProjects: (binding.linkProjects ?? []).filter((p) => p !== path),
          aliases: (binding.aliases ?? []).filter((alias) => alias.target !== path),
        },
      ];
    });
}
