import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_FOLDER_STATE, guestFolderDir, retireEmptyGuestFolder, syncFolder, type EngineWorkFolder } from "./engine-folder-sync.ts";

const entry = fileURLToPath(import.meta.url);

async function runLocked(path: string, state: string, input: string): Promise<void> {
  const dir = guestFolderDir(path, state);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
    process.stderr.write("folder-progress\n");
  }
}

async function main() {
  const [, , action, path, state = ENGINE_FOLDER_STATE] = process.argv;
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
      await runLocked(binding.path, ENGINE_FOLDER_STATE, "");
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
