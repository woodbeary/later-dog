import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const MODEL = "@cf/meta/llama-guard-3-8b";
export const CHUNK_CHARS = 6000;
export const MAX_BYTES = 512 * 1024;
export const WORKERS = 4;

export const CATEGORIES = {
  S1: "Violent Crimes",
  S2: "Non-Violent Crimes",
  S3: "Sex-Related Crimes",
  S4: "Child Sexual Exploitation",
  S5: "Defamation",
  S6: "Specialized Advice",
  S7: "Privacy",
  S8: "Intellectual Property",
  S9: "Indiscriminate Weapons",
  S10: "Hate",
  S11: "Suicide & Self-Harm",
  S12: "Sexual Content",
  S13: "Elections",
  S14: "Code Interpreter Abuse",
};

const TEXT = /\.(md|mdx|mdc|markdown|txt|rst|adoc|org)$/i;
const INSTRUCTIONS = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".cursorrules", ".windsurfrules", ".clinerules"]);
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

export function isCandidate(path) {
  const parts = path.split("/");
  if (parts.some((part) => SKIPPED_DIRS.has(part))) return false;
  const name = parts.at(-1) ?? "";
  return TEXT.test(name) || INSTRUCTIONS.has(name);
}

function walk(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
}

export function listFiles(root) {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return walk(root);
  }
}

export function chunks(text, size = CHUNK_CHARS) {
  const parts = [];
  for (let at = 0; at < text.length; at += size) parts.push(text.slice(at, at + size));
  return parts.length > 0 ? parts : [""];
}

export function parseVerdict(result) {
  const answer = result && typeof result === "object" && "response" in result ? result.response : result;
  if (answer && typeof answer === "object" && typeof answer.safe === "boolean") {
    return { safe: answer.safe, categories: (answer.categories ?? []).map(String) };
  }
  if (typeof answer === "string") {
    const [first = "", ...rest] = answer.trim().split(/\s*\n\s*/);
    const word = first.trim().toLowerCase();
    if (word === "safe") return { safe: true, categories: [] };
    if (word === "unsafe") return { safe: false, categories: rest.join(",").match(/S\d{1,2}/g) ?? [] };
  }
  throw new Error("Llama Guard answered in a shape this script does not read");
}

export function workersAi({ accountId, token, gateway, fetchImpl = fetch }) {
  if (!accountId || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token that can run Workers AI)");
  const url = gateway
    ? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/workers-ai/${MODEL}`
    : `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;
  return async (text) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "cf-aig-collect-log": "false" },
      body: JSON.stringify({ messages: [{ role: "user", content: text }], temperature: 0, max_tokens: 24 }),
    });
    if (!response.ok) throw new Error(`Workers AI answered ${response.status}`);
    const body = await response.json();
    return parseVerdict(body && typeof body === "object" && "result" in body ? body.result : body);
  };
}

export async function judge(text, ask) {
  const categories = new Set();
  let safe = true;
  for (const part of chunks(text)) {
    const verdict = await ask(part);
    if (verdict.safe) continue;
    safe = false;
    for (const category of verdict.categories) categories.add(category);
  }
  return { safe, categories: [...categories].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))) };
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function addedBy(root, path) {
  try {
    const out = execFileSync("git", ["log", "--diff-filter=A", "--format=%H%x09%an%x09%aI", "--", path], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const first = out.split("\n").filter(Boolean).at(-1);
    if (!first) return null;
    const [commit, author, date] = first.split("\t");
    return { commit, author, date };
  } catch {
    return null;
  }
}

async function pool(items, limit, work) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await work(items[index]);
    }
  });
  await Promise.all(runners);
}

export async function sweep({ root, ask, quarantine = false, now = new Date(), list = listFiles, workers = WORKERS }) {
  const flagged = [];
  const unread = [];
  const skipped = [];
  let checked = 0;
  const candidates = list(root).filter(isCandidate).sort();
  await pool(candidates, workers, async (path) => {
    const full = join(root, path);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) return;
    if (info.size > MAX_BYTES) {
      skipped.push({ path, bytes: info.size, reason: `larger than ${MAX_BYTES} bytes` });
      return;
    }
    const bytes = await readFile(full);
    checked += 1;
    try {
      const verdict = await judge(bytes.toString("utf8"), ask);
      if (!verdict.safe) flagged.push({ path, bytes: info.size, sha256: sha256(bytes), categories: verdict.categories, added: addedBy(root, path) });
    } catch (error) {
      unread.push({ path, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  const byPath = (a, b) => a.path.localeCompare(b.path);
  const report = { root: resolve(root), model: MODEL, at: now.toISOString(), checked, flagged: flagged.sort(byPath), unread: unread.sort(byPath), skipped: skipped.sort(byPath) };
  if (quarantine && flagged.length > 0) report.quarantine = await isolate(root, report.flagged, now);
  return report;
}

export function quarantineDir(root, now) {
  const repository = resolve(root);
  return join(dirname(repository), `${basename(repository)}.quarantine`, now.toISOString().replace(/[:.]/g, "-"));
}

export function inside(base, path) {
  const target = resolve(base, path);
  const rel = relative(resolve(base), target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} points outside ${base}`);
  return target;
}

async function move(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await copyFile(from, to);
    await unlink(from);
  }
}

export async function isolate(root, flagged, now) {
  const dir = quarantineDir(root, now);
  for (const file of flagged) {
    const target = inside(join(dir, "files"), file.path);
    await mkdir(dirname(target), { recursive: true });
    await move(inside(root, file.path), target);
  }
  const manifest = join(dir, "manifest.json");
  await writeFile(manifest, `${JSON.stringify({ root: resolve(root), at: now.toISOString(), model: MODEL, files: flagged }, null, 2)}\n`);
  return { dir, manifest };
}

export async function restore(manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = join(dirname(resolve(manifestPath)), "files");
  const plan = [];
  for (const file of manifest.files) {
    const source = inside(files, file.path);
    const target = inside(manifest.root, file.path);
    if (await stat(target).catch(() => null)) throw new Error(`${file.path} exists in the repository again; put it back by hand`);
    if (sha256(await readFile(source)) !== file.sha256) throw new Error(`${file.path} changed in quarantine; nothing was restored`);
    plan.push({ source, target, path: file.path });
  }
  for (const step of plan) {
    await mkdir(dirname(step.target), { recursive: true });
    await move(step.source, step.target);
  }
  return plan.map((step) => step.path);
}

function describe(categories) {
  return categories.map((code) => `${code} ${CATEGORIES[code] ?? "unknown category"}`).join(", ");
}

export function summary(report) {
  const lines = [`Checked ${report.checked} files with ${report.model} on Workers AI. Contents were never printed.`];
  if (report.flagged.length === 0) lines.push("Nothing flagged.");
  else {
    lines.push(`Flagged ${report.flagged.length}:`);
    for (const file of report.flagged) {
      const added = file.added ? ` (added in ${file.added.commit.slice(0, 9)} by ${file.added.author}, ${file.added.date})` : " (not committed)";
      lines.push(`  ${file.path}: ${describe(file.categories)}${added}`);
    }
  }
  if (report.unread.length > 0) {
    lines.push(`Could not judge ${report.unread.length}, left in place for a person:`);
    for (const file of report.unread) lines.push(`  ${file.path}: ${file.reason}`);
  }
  if (report.skipped.length > 0) {
    lines.push(`Skipped ${report.skipped.length}, left in place for a person:`);
    for (const file of report.skipped) lines.push(`  ${file.path}: ${file.reason}`);
  }
  if (report.quarantine) lines.push(`Moved the flagged files to ${report.quarantine.dir}. Put them back with: node bait.mjs restore ${report.quarantine.manifest}`);
  else if (report.flagged.length > 0) lines.push("Nothing moved. Run again with --quarantine to move the flagged files out of the working tree.");
  return lines.join("\n");
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "restore" && rest[0]) {
    const restored = await restore(rest[0]);
    console.log(`Restored ${restored.length} files.`);
    return 0;
  }
  if (command !== "scan") {
    console.error("usage: node bait.mjs scan [repository] [--quarantine] [--json]\n       node bait.mjs restore <manifest.json>");
    return 2;
  }
  const root = rest.find((arg) => !arg.startsWith("--")) ?? process.cwd();
  const ask = workersAi({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, gateway: process.env.AI_GATEWAY_ID });
  const report = await sweep({ root, ask, quarantine: rest.includes("--quarantine") });
  console.log(rest.includes("--json") ? JSON.stringify(report, null, 2) : summary(report));
  return report.flagged.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(2);
    },
  );
}
