import { REPO_CACHE_ROOT, sharedClone } from "./shared-clones.ts";

const git = process.env.LATERDOG_REAL_GIT;
if (!git) {
  process.stderr.write("git: the home's git could not be found\n");
  process.exit(127);
}
process.exitCode = sharedClone(process.argv.slice(2), { git, cacheRoot: process.env.LATERDOG_REPO_CACHE || REPO_CACHE_ROOT(), cwd: process.cwd() }).status;
