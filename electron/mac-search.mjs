import { spawn } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

export const SEARCH_RESULTS_DEFAULT = 100;
export const SEARCH_RESULTS_MAX = 500;
const SEARCH_TIMEOUT_MS = 20_000;
const LINE_MAX = 300;
const SKIPPED_FOLDERS = [".git", "node_modules", ".next", ".turbo", ".cache", ".pnpm-store", "coverage", ".venv", "venv", "__pycache__", "Pods", "DerivedData"];
const HOLDS_SECRETS = "Search a project folder, not a folder that holds your keys and settings, such as your whole home folder.";

export function ripgrepCandidates(env = process.env, home = os.homedir()) {
  const fromPath = String(env.PATH ?? "").split(":").filter(Boolean).map(dir => path.join(dir, "rg"));
  return [...new Set(["/opt/homebrew/bin/rg", "/usr/local/bin/rg", path.join(home, ".cargo", "bin", "rg"), ...fromPath])];
}

export async function findRipgrep(candidates = ripgrepCandidates()) {
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return null;
}

export function searchArguments(engine, { pattern, glob, ignoreCase, target }) {
  if (engine === "rg") {
    return ["--line-number", "--no-heading", "--color=never", `--max-columns=${LINE_MAX}`, "--max-columns-preview", "--max-filesize=2M",
      ...SKIPPED_FOLDERS.flatMap(name => ["-g", `!${name}/`]), ...(ignoreCase ? ["-i"] : []), ...(glob ? ["-g", glob] : []), "-e", pattern, "--", target];
  }
  return ["-rIn", "-E", ...(ignoreCase ? ["-i"] : []), ...SKIPPED_FOLDERS.map(name => `--exclude-dir=${name}`), ...(glob ? [`--include=${glob}`] : []), "-e", pattern, "--", target];
}

async function holdsProtected(target, protectedPaths) {
  for (const candidate of protectedPaths ?? []) {
    if (typeof candidate !== "string" || !candidate) continue;
    let real;
    try { real = await fs.realpath(candidate); } catch { continue; }
    if (real === target || real.startsWith(`${target}${path.sep}`)) return true;
  }
  return false;
}

export async function searchFolder({ target, protectedPaths, pattern, glob, ignoreCase = false, maxResults, signal, ripgrep = findRipgrep, spawnImpl = spawn }) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 2000) throw new Error("Give a search pattern of at most 2000 characters");
  if (glob !== undefined && (typeof glob !== "string" || !glob || glob.length > 300)) throw new Error("Give glob as a file name pattern such as *.ts");
  const limit = Math.max(1, Math.min(SEARCH_RESULTS_MAX, Number.isSafeInteger(maxResults) ? maxResults : SEARCH_RESULTS_DEFAULT));
  const info = await fs.stat(target);
  const folder = info.isDirectory() ? target : path.dirname(target);
  if (info.isDirectory() && await holdsProtected(target, protectedPaths)) throw new Error(HOLDS_SECRETS);
  signal?.throwIfAborted();
  const rg = await ripgrep();
  const engine = rg ? "rg" : "grep";
  const shown = info.isDirectory() ? "." : path.basename(target);
  const child = spawnImpl(rg ?? "/usr/bin/grep", searchArguments(engine, { pattern, glob, ignoreCase, target: shown }), {
    cwd: folder, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", HOME: os.homedir(), LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
  });
  return new Promise((resolve, reject) => {
    const matches = [];
    let truncated = false;
    let timedOut = false;
    let complaint = "";
    const stop = () => { try { child.kill("SIGKILL"); } catch {} };
    const timer = setTimeout(() => { timedOut = true; stop(); }, SEARCH_TIMEOUT_MS);
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", chunk => { if (complaint.length < 2000) complaint += chunk; });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", line => {
      if (matches.length >= limit) { truncated = true; stop(); return; }
      const relative = line.startsWith("./") ? line.slice(2) : line;
      matches.push(relative.length > LINE_MAX + 200 ? `${relative.slice(0, LINE_MAX + 200)}…` : relative);
    });
    child.once("error", error => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (signal?.aborted) return reject(new Error("The search was stopped because the requesting turn ended"));
      if (code === 2 && matches.length === 0 && !timedOut && !truncated) return reject(new Error(complaint.trim().split("\n")[0] || "The search pattern isn't valid"));
      resolve({ matches, ...(truncated ? { truncated: true } : {}), ...(timedOut ? { timed_out: true } : {}), engine });
    });
  });
}
