import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export async function fileIsUnopened(file, { proc = "/proc", maxDescriptors = 100_000, budgetMs = 2000 } = {}) {
  const target = await stat(file);
  const started = Date.now();
  let checked = 0;
  const gone = error => error?.code === "ENOENT" || error?.code === "ESRCH";
  try {
    for (const pid of await readdir(proc)) {
      if (!/^\d+$/.test(pid)) continue;
      let fds;
      try { fds = await readdir(join(proc, pid, "fd")); }
      catch (error) { if (gone(error)) continue; return false; }
      for (const fd of fds) {
        if (++checked > maxDescriptors || Date.now() - started > budgetMs) return false;
        let info;
        try { info = await stat(join(proc, pid, "fd", fd)); }
        catch (error) { if (gone(error)) continue; return false; }
        if (info.dev === target.dev && info.ino === target.ino) return false;
      }
    }
    return true;
  } catch { return false; }
}
