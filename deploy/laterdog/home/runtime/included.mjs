import { existsSync } from "node:fs";
import { chown, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const INCLUDED_SERVICES = ["decisions", "voice", "ai"];
const INCLUDED_KEY = /^ldt_[A-Za-z0-9_-]{43}$/;

export async function seedIncluded(laterdogHome, { key, api }, owner) {
  if (!key || !api || !INCLUDED_KEY.test(key)) return "skipped";
  const keyFile = join(laterdogHome, "computers-trial-key");
  if (existsSync(keyFile)) return "kept";
  await mkdir(laterdogHome, { recursive: true, mode: 0o700 });
  const stateFile = join(laterdogHome, "computers-trial.json");
  await writeFile(keyFile, `${key}\n`, { mode: 0o600 });
  await writeFile(stateFile, `${JSON.stringify({ api, confirmed: true, included: INCLUDED_SERVICES })}\n`, { mode: 0o600 });
  if (owner) {
    for (const path of [laterdogHome, keyFile, stateFile]) await chown(path, owner.uid, owner.gid);
  }
  return "seeded";
}
