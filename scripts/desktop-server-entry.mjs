import module from "node:module";
import { lstatSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const cacheRoot = process.env.LATERDOG_SERVER_COMPILE_CACHE;
delete process.env.LATERDOG_SERVER_COMPILE_CACHE;

let enabled = false;
if (cacheRoot) {
  try {
    enabled = module.enableCompileCache(cacheRoot).status === module.constants.compileCacheStatus.ENABLED;
  } catch {}
}

await import("./index.js");

if (enabled) {
  setTimeout(() => {
    try {
      module.flushCompileCache();
      const current = module.getCompileCacheDir();
      if (dirname(current) !== resolve(cacheRoot)) return;
      const now = new Date();
      utimesSync(current, now, now);
      for (const name of readdirSync(cacheRoot)) {
        if (name === basename(current) || !/^v\d+\.\d+\.\d+-/.test(name)) continue;
        const stale = join(cacheRoot, name);
        const stat = lstatSync(stale);
        if (stat.isDirectory() && now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
          rmSync(stale, { recursive: true, force: true });
        }
      }
    } catch {}
  }, 10_000).unref();
}
