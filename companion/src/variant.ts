import { homedir } from "node:os";
import { join } from "node:path";

export function companionDefaults(env: NodeJS.ProcessEnv = process.env, home: string = homedir()) {
  const dev = env.LATERDOG_APP_VARIANT === "dev" || env.LATERDOG_VARIANT === "dev";
  return dev
    ? { companionPort: 8910, controlPort: 8909, dataDir: join(home, ".laterdog-dev", "companion") }
    : { companionPort: 8810, controlPort: 8811, dataDir: join(home, ".laterdog-companion") };
}
