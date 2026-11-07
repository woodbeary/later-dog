import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { bundleKey, HOME_BUCKET, pointerFor, POINTER_KEY } from "./dev-home.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const homeWorker = join(root, "deploy", "laterdog", "home");

export function releaseLabel(sha, subject) {
  return `main ${sha.slice(0, 9)} ${subject}`.trim().slice(0, 120);
}

export function stillCurrent(built, mainHead) {
  return Boolean(built) && built === mainHead;
}

async function wrangler(args) {
  await run(process.execPath, [join(homeWorker, "node_modules", "wrangler", "bin", "wrangler.js"), ...args], { cwd: homeWorker, maxBuffer: 16 << 20 });
}

async function git(args) {
  return (await run("git", args, { cwd: root })).stdout.trim();
}

export async function publish({ bucket = process.env.LATERDOG_HOME_BUCKET || HOME_BUCKET, mainHead } = {}) {
  if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error("CLOUDFLARE_API_TOKEN is not set: add it as a repository secret (R2 edit on the laterdog-homes bucket)");
  const sha = await git(["rev-parse", "HEAD"]);
  const subject = await git(["log", "-1", "--format=%s"]);
  await run(process.execPath, [join(root, "scripts", "bundle-server.mjs")], { cwd: root, maxBuffer: 16 << 20 });
  const archive = join(await mkdtemp(join(tmpdir(), "laterdog-home-code-")), "server.tgz");
  await run("tar", ["-czf", archive, "-C", join(root, "dist-server"), "."]);
  const bytes = await readFile(archive);
  const hash = createHash("sha256").update(bytes).digest("hex");
  await wrangler(["r2", "object", "put", `${bucket}/${bundleKey(hash)}`, "--file", archive, "--remote"]);
  if (mainHead !== undefined && !stillCurrent(sha, mainHead)) {
    process.stdout.write(`uploaded ${hash.slice(0, 12)} for ${sha.slice(0, 9)}, but main is now ${mainHead.slice(0, 9)}; leaving the pointer for the newer run\n`);
    return { hash, pointed: false };
  }
  const pointer = join(tmpdir(), `laterdog-home-pointer-${hash.slice(0, 12)}.json`);
  await writeFile(pointer, JSON.stringify(pointerFor(hash, releaseLabel(sha, subject))));
  await wrangler(["r2", "object", "put", `${bucket}/${POINTER_KEY}`, "--file", pointer, "--content-type", "application/json", "--remote"]);
  process.stdout.write(`homes now take ${hash.slice(0, 12)} (${releaseLabel(sha, subject)}) at their next moment with no dog mid-turn\n`);
  return { hash, pointed: true };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mainHead = process.env.MAIN_HEAD || undefined;
  publish({ mainHead }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
