import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export async function startLaterDogSupervisor({ app, dataDir, port, ownerToken, log }) {
  // A hosted supervisor (environment, or the saved connection beside the data directory) replaces the local one entirely.
  if (process.env.LATERDOG_SUPERVISOR_URL || fs.existsSync(path.join(dataDir,"supervisor.json")) || !app.isPackaged) return null;
  const directory = path.join(dataDir,"supervisor");
  fs.mkdirSync(directory,{ recursive: true, mode: 0o700 });
  const child = spawn(process.execPath,[path.join(process.resourcesPath,"server","laterdog","main.js")],{
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", LATERDOG_DATA_DIR: directory,
      LATERDOG_WORKSPACE_URL: `http://127.0.0.1:${port}`, LATERDOG_DESKTOP_OWNER_TOKEN: ownerToken },
    stdio: ["ignore","pipe","pipe"],
  });
  child.stdout.on("data",(data) => log(`[laterdog] ${String(data).trim()}`));
  child.stderr.on("data",(data) => log(`[laterdog] ${String(data).trim()}`));
  child.on("error",() => log("later.dog supervisor could not start; the workspace will show the connection failure"));
  return child;
}
