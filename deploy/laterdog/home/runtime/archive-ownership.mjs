import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const gone = error => error?.code === "ENOENT" || error?.code === "ESRCH";

async function descriptors(target, { proc, maxDescriptors, budgetMs, uid = null }) {
  const started = Date.now();
  let checked = 0;
  const otherUids = new Set();
  const result = safe => ({ safe, checked, otherUids: [...otherUids] });
  try {
    for (const pid of await readdir(proc)) {
      if (!/^[0-9]+$/.test(pid)) continue;
      if (Date.now() - started > budgetMs) return result(false);
      if (uid !== null) {
        let owner;
        try { owner = (await stat(join(proc, pid))).uid; }
        catch (error) { if (gone(error)) continue; return result(false); }
        if (owner !== uid) { otherUids.add(owner); continue; }
      }
      let fds;
      try { fds = await readdir(join(proc, pid, "fd")); }
      catch (error) { if (gone(error)) continue; return result(false); }
      for (const fd of fds) {
        if (++checked > maxDescriptors || Date.now() - started > budgetMs) return result(false);
        let info;
        try { info = await stat(join(proc, pid, "fd", fd)); }
        catch (error) { if (gone(error)) continue; return result(false); }
        if (info.dev === target.dev && info.ino === target.ino) return result(false);
      }
    }
    return result(true);
  } catch { return result(false); }
}

export async function fileIsUnopened(file, { proc = "/proc", maxDescriptors = 100_000, budgetMs = 2000, asOwner = null } = {}) {
  const info = await stat(file);
  const target = { dev: info.dev, ino: info.ino };
  const started = Date.now();
  const ownUid = process.getuid?.() ?? null;
  const checked = await descriptors(target, { proc, maxDescriptors, budgetMs, uid: asOwner ? ownUid : null });
  if (!checked.safe) return false;
  if (!asOwner || !checked.otherUids.length) return true;
  if (checked.otherUids.some(uid => uid !== asOwner.uid)) return false;
  const left = budgetMs - (Date.now() - started);
  if (left <= 0) return false;
  try {
    const input = { target, proc, uid: asOwner.uid, allowedUids: [ownUid, asOwner.uid],
      maxDescriptors: maxDescriptors - checked.checked, budgetMs: left };
    const result = await run(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(input)], {
      uid: asOwner.uid, gid: asOwner.gid, env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      timeout: left, maxBuffer: 128,
    });
    return result.stdout.trim() === "true";
  } catch { return false; }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const input = JSON.parse(process.argv[2]);
  const result = await descriptors(input.target, input);
  process.stdout.write(String(result.safe && result.otherUids.every(uid => input.allowedUids.includes(uid))));
}
