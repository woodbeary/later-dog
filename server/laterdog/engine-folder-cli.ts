import { projectDependents, releaseGuestProject } from "./engine-folder-release.ts";
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_FOLDER_STATE, guestFolderDir, retireEmptyGuestFolder, syncFolder, type EngineWorkFolder } from "./engine-folder-sync.ts";

const entry = fileURLToPath(import.meta.url);

export const LOCK_WAIT_MS = 2 * 60_000;

export class FolderBusy extends Error {
  constructor(path: string) { super("Another checkout still holds this working folder: " + path); }
}

async function runLocked(path: string, state: string, input: string, waitMs = LOCK_WAIT_MS): Promise<void> {
  const dir = guestFolderDir(path, state);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const giveUpAt = Date.now() + waitMs;
  for (;;) {
    const code = await new Promise<number | null>((ok, fail) => {
      const child = spawn(
        "flock",
        [
          "--exclusive",
          "--timeout",
          "15",
          "--conflict-exit-code",
          "74",
          join(dir, "checkout.lock"),
          process.execPath,
          entry,
          "locked",
          path,
          state,
        ],
        { stdio: ["pipe", "inherit", "inherit"] },
      );
      child.once("error", fail);
      child.stdin.on("error", () => {});
      child.once("close", ok);
      child.stdin.end(input);
    });
    if (code === 0) return;
    if (code !== 74) throw new Error("Working folder checkout did not complete");
    if (Date.now() >= giveUpAt) throw new FolderBusy(path);
  }
}

async function main() {
  const [, , action, path, state = ENGINE_FOLDER_STATE] = process.argv;
  if (action === "release-member" && path) {
    const expected = JSON.parse(Buffer.from(process.argv[5] ?? "", "base64url").toString("utf8")) as { uri:string; guest:string };
    for (const binding of projectDependents(path,state)) await runLocked(binding.path,state,JSON.stringify(binding));
    await runLocked(path,state,JSON.stringify({release:expected}));
    return;
  }
  if (action === "retire-empty" && path) {
    try {
      if (!await retireEmptyGuestFolder(path, state)) throw new Error("Missing working folder head");
      process.stdout.write(JSON.stringify({ ok: true }) + "\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, errno: (error as NodeJS.ErrnoException).code ?? "EIO" }) + "\n");
    }
    return;
  }
  if (action === "turn-files" && path && /^[a-zA-Z0-9_-]{1,16000}$/.test(path)) {
    const { runGuestCheckpoint } = await import("./engine-turn-files.ts");
    const result = await runGuestCheckpoint(JSON.parse(Buffer.from(path, "base64url").toString("utf8")));
    process.stdout.write(JSON.stringify({ result: result ?? null }) + "\n");
    return;
  }
  if (action === "flush-all") {
    if (!existsSync(ENGINE_FOLDER_STATE)) return;
    for (const name of readdirSync(ENGINE_FOLDER_STATE)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const file = join(ENGINE_FOLDER_STATE, name, "grant.json");
      if (!existsSync(file)) continue;
      const binding = JSON.parse(readFileSync(file, "utf8")) as EngineWorkFolder;
      if (guestFolderDir(binding.path) !== join(ENGINE_FOLDER_STATE, name))
        throw new Error("Invalid guest working folder registration");
      try {
        await runLocked(binding.path, ENGINE_FOLDER_STATE, "");
      } catch (error) {
        if (!(error instanceof FolderBusy)) throw error;
        process.stderr.write(`skipped a working folder another checkout holds; its saved copy stays in durable storage: ${binding.path}\n`);
      }
    }
    return;
  }
  if (!["locked", "hydrate", "checkpoint"].includes(action) || !path)
    throw new Error("Unknown working folder operation");
  let input = "";
  for await (const bytes of process.stdin) {
    input += bytes.toString();
    if (input.length > 32768) throw new Error("Working folder capability is too large");
  }
  if (action === "locked") {
    const file = join(guestFolderDir(path, state), "grant.json");
    if (!input && (!existsSync(file) || !lstatSync(path, { throwIfNoEntry: false }) && await retireEmptyGuestFolder(path, state, true))) return;
    const payload = input ? JSON.parse(input) : undefined;
    if (payload?.release) {
      await releaseGuestProject(path,state,payload.release.uri,payload.release.guest);
      process.stdout.write(JSON.stringify({released:true})+"\n");
      return;
    }
    const binding: EngineWorkFolder = input
      ? {
          path,
          grant: payload.grant ?? payload,
          ...(payload.aliases !== undefined ? { aliases: payload.aliases } : {}),
          ...(payload.linkProjects !== undefined ? { linkProjects: payload.linkProjects } : {}),
        }
      : JSON.parse(readFileSync(file, "utf8"));
    let last = 0;
    const result = await syncFolder(binding, state, undefined, () => {
      if (Date.now() - last > 1000) {
        process.stderr.write("folder-progress\n");
        last = Date.now();
      }
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } else await runLocked(path, state, input);
}

if (process.argv[1] === entry)
  void main().catch((e: Error) => {
    console.error(e.message);
    process.exitCode = 1;
  });
