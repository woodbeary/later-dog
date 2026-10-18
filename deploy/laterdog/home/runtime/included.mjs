import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

export const INCLUDED_SERVICES = ["decisions", "voice", "ai"];
const INCLUDED_KEY = /^ldt_[A-Za-z0-9_-]{43}$/;

const kindOf = async (path) => {
  const found = await lstat(path).catch(() => null);
  if (!found) return "missing";
  if (found.isSymbolicLink()) return "link";
  if (found.isDirectory()) return "directory";
  return found.isFile() ? "file" : "other";
};

const readPlain = async (path) => ((await kindOf(path)) === "file" ? readFile(path, "utf8").catch(() => null) : null);

async function ownedDirectory(path, owner) {
  const kind = await kindOf(path);
  if (kind !== "directory" && kind !== "missing") await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true, mode: 0o700 });
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error(`${path} is not a folder`);
    if (owner) await handle.chown(owner.uid, owner.gid);
  } finally {
    await handle.close();
  }
}

async function writeOwned(path, text, owner) {
  await rm(path, { recursive: true, force: true });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.chmod(0o600);
    if (owner) await handle.chown(owner.uid, owner.gid);
  } finally {
    await handle.close();
  }
}

export async function seedIncluded(laterdogHome, { key, api }, owner) {
  if (!key || !api || !INCLUDED_KEY.test(key)) return "skipped";
  const keyFile = join(laterdogHome, "computers-trial-key");
  const stateFile = join(laterdogHome, "computers-trial.json");
  const state = `${JSON.stringify({ api, confirmed: true, included: INCLUDED_SERVICES })}\n`;
  const plainHome = (await kindOf(laterdogHome)) === "directory";
  const heldKey = plainHome ? await readPlain(keyFile) : null;
  const heldState = plainHome ? await readPlain(stateFile) : null;
  if (heldKey?.trim() === key && heldState === state) return "kept";
  await ownedDirectory(laterdogHome, owner);
  await writeOwned(keyFile, `${key}\n`, owner);
  await writeOwned(stateFile, state, owner);
  return heldKey === null ? "seeded" : "replaced";
}
