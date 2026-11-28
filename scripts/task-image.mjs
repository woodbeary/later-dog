#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENGINE_BASE = "home/dog/.laterdog-engine";
export const CLI_BASE = `${ENGINE_BASE}/cli`;
export const DOG_UID = 1000;
export const PNPM_VERSION = "10.33.0";
export const LINUX_X64 = { os: ["linux"], cpu: ["x64"], libc: ["glibc"] };
export const ENGINE_PACKAGES = {
  "@anthropic-ai/claude-code": { dir: "claude-code", binary: "claude", versionLine: (v) => `${v} (Claude Code)` },
  "@openai/codex": { dir: "codex", binary: "codex", versionLine: (v) => `codex-cli ${v}` },
  "@google/gemini-cli": { dir: "gemini", binary: "gemini", versionLine: (v) => v },
};

export function enginesFromArg(text) {
  const engines = [];
  for (const spec of text.trim().split(/\s+/).filter(Boolean)) {
    const at = spec.lastIndexOf("@");
    if (at <= 0) throw new Error(`"${spec}" names no version`);
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    if (!Object.hasOwn(ENGINE_PACKAGES, name)) throw new Error(`${name} is not an engine the task image carries`);
    if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error(`${spec} is not an exact version`);
    engines.push({ name, version });
  }
  return engines;
}

export function enginesFromDockerfile(text) {
  const match = /^ARG CLOUD_HOME_ENGINES="([^"]*)"$/m.exec(text);
  if (!match) throw new Error("the Dockerfile has no CLOUD_HOME_ENGINES pin");
  return enginesFromArg(match[1]);
}

export function enginesFromImageConfig(config) {
  for (const entry of config.history ?? []) {
    const match = /CLOUD_HOME_ENGINES=((?:@[\w.-]+\/[\w.-]+@[\w.+-]+\s?)+)/.exec(entry.created_by ?? "");
    if (match) return enginesFromArg(match[1]);
  }
  throw new Error("the home image's history names no CLOUD_HOME_ENGINES");
}

export function antigravityFromSource(text) {
  const version = /ANTIGRAVITY_RELEASE_VERSION = "([^"]+)"/.exec(text)?.[1];
  const block = /\[\s*"linux-x64",\s*\{([\s\S]*?)\}\s*,?\s*\]/.exec(text)?.[1] ?? "";
  const url = /url: "([^"]+)"/.exec(block)?.[1];
  const sha256 = /sha256: "([0-9a-f]{64})"/.exec(block)?.[1];
  if (!version || !url || !sha256) throw new Error("the Antigravity linux-x64 release is not pinned");
  return { version, url, sha256 };
}

export function desktopImageFrom(wranglerText) {
  const match = /"desktop":\s*\{\s*"image":\s*"([^"]+)"/.exec(wranglerText);
  if (!match) throw new Error("the computers Worker pins no desktop image");
  return match[1];
}

export function cliDirName(engine) {
  return `${ENGINE_PACKAGES[engine.name].dir}-${engine.version}`;
}

export function rewriteShim(text, stagedDir, imageDir) {
  return text.split(stagedDir).join(imageDir);
}

export function freeAfter(imageBytes, diskBytes) {
  return diskBytes - imageBytes;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    visit(full, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full, visit);
  }
}

function bytesUnder(dir) {
  let total = 0;
  const seen = new Set();
  walk(dir, (full, entry) => {
    if (!entry.isFile()) return;
    const stat = fs.lstatSync(full);
    if (seen.has(stat.ino)) return;
    seen.add(stat.ino);
    total += stat.size;
  });
  return total;
}

export function muslEntries(names) {
  return names.filter((name) => /-musl@/.test(name));
}

function dropMusl(dir) {
  const store = path.join(dir, "node_modules", ".pnpm");
  for (const name of muslEntries(fs.readdirSync(store))) fs.rmSync(path.join(store, name), { recursive: true, force: true });
  walk(path.join(dir, "node_modules"), (full, entry) => {
    if (entry.isSymbolicLink() && !fs.existsSync(full)) fs.rmSync(full);
  });
}

function stagePackage(stage, engine, store) {
  const imageDir = `/${CLI_BASE}/${cliDirName(engine)}`;
  const dir = path.join(stage, CLI_BASE, cliDirName(engine));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ pnpm: { supportedArchitectures: LINUX_X64 } }));
  run("pnpm", ["--dir", dir, "add", "--save-exact", "--ignore-workspace", "--ignore-scripts", `--store-dir=${store}`, "--config.package-import-method=copy", "--config.node-linker=isolated", `${engine.name}@${engine.version}`], { env: { ...process.env, npm_config_manage_package_manager_versions: "false" } });
  if (engine.name === "@anthropic-ai/claude-code") {
    const wrapper = fs.realpathSync(path.join(dir, "node_modules", "@anthropic-ai", "claude-code"));
    const native = fs.realpathSync(path.join(wrapper, "..", "claude-code-linux-x64", "claude"));
    fs.rmSync(path.join(wrapper, "bin", "claude.exe"));
    fs.linkSync(native, path.join(wrapper, "bin", "claude.exe"));
    fs.chmodSync(path.join(wrapper, "bin", "claude.exe"), 0o755);
  }
  dropMusl(dir);
  const bin = path.join(dir, "node_modules", ".bin");
  for (const name of fs.readdirSync(bin)) {
    const file = path.join(bin, name);
    if (fs.lstatSync(file).isFile()) fs.writeFileSync(file, rewriteShim(fs.readFileSync(file, "utf8"), dir, imageDir));
  }
  fs.rmSync(path.join(dir, "node_modules", ".modules.yaml"), { force: true });
  fs.writeFileSync(path.join(dir, ".ready"), "");
  return { name: engine.name, version: engine.version, dir: imageDir, bytes: bytesUnder(dir) };
}

async function stageAntigravity(stage, release, scratch) {
  const imageDir = `/${CLI_BASE}/antigravity-${release.version}`;
  const dir = path.join(stage, CLI_BASE, `antigravity-${release.version}`);
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(scratch, "antigravity.zip");
  run("curl", ["--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--retry", "2", release.url, "-o", archive]);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (digest !== release.sha256) throw new Error(`the Antigravity archive's digest ${digest} is not ${release.sha256}`);
  run("unzip", ["-joq", archive, "*agy_acp_server.par", "*localharness_external", "-d", dir]);
  fs.chmodSync(path.join(dir, "agy_acp_server.par"), 0o755);
  fs.chmodSync(path.join(dir, "localharness_external"), 0o755);
  fs.rmSync(archive);
  fs.writeFileSync(path.join(dir, ".ready"), "");
  return { name: "antigravity", version: release.version, dir: imageDir, bytes: bytesUnder(dir) };
}

function layer(stage, out) {
  for (const dir of [path.join(stage, ENGINE_BASE), path.join(stage, CLI_BASE)]) fs.chmodSync(dir, 0o700);
  run("tar", ["--no-mac-metadata", "--no-xattrs", "--no-acls", "--uid", String(DOG_UID), "--gid", String(DOG_UID), "--uname", "dog", "--gname", "dog", "-C", stage, "-czf", out, ENGINE_BASE], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return fs.statSync(out).size;
}

function crane(args, options = {}) {
  return run(process.env.CRANE ?? "crane", args, options).trim();
}

export function repositoryOf(ref) {
  return ref.includes("@") ? ref.split("@")[0] : ref.replace(/:[^/:]+$/, "");
}

function measureImage(ref) {
  const manifest = JSON.parse(crane(["manifest", ref]));
  let compressed = 0;
  let unpacked = 0;
  for (const entry of manifest.layers) {
    compressed += entry.size;
    const blob = spawnSync("sh", ["-c", `${process.env.CRANE ?? "crane"} blob "$0" | gzip -dc | wc -c`, `${repositoryOf(ref)}@${entry.digest}`], { encoding: "utf8", maxBuffer: 1024 * 1024 });
    if (blob.status !== 0) throw new Error(`could not measure layer ${entry.digest}: ${blob.stderr}`);
    unpacked += Number(blob.stdout.trim());
  }
  return { layers: manifest.layers.length, compressed, unpacked };
}

function parseArgs(argv) {
  const options = { engines: ["claude-code", "codex"], measure: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--to") options.to = value();
    else if (arg === "--base") options.base = value();
    else if (arg === "--home-image") options.homeImage = value();
    else if (arg === "--engines") options.engines = value().split(",");
    else if (arg === "--gemini") options.gemini = value();
    else if (arg === "--work") options.work = value();
    else if (arg === "--measure") options.measure = true;
    else if (arg === "--stage-only") options.stageOnly = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.to && !options.stageOnly) throw new Error("--to <registry/repository:tag> is required, or --stage-only");
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const base = options.base ?? desktopImageFrom(fs.readFileSync(path.join(ROOT, "deploy/laterdog/computers/wrangler.jsonc"), "utf8"));
  const pinned = options.homeImage ? enginesFromImageConfig(JSON.parse(crane(["config", options.homeImage]))) : enginesFromDockerfile(fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8"));
  const wanted = new Set(options.engines);
  const engines = pinned.filter((engine) => wanted.has(ENGINE_PACKAGES[engine.name].dir));
  if (options.gemini && wanted.has("gemini")) engines.push(...enginesFromArg(`@google/gemini-cli@${options.gemini}`));
  const pnpm = run("pnpm", ["--version"]).trim();
  if (pnpm !== PNPM_VERSION) throw new Error(`pnpm ${PNPM_VERSION} is needed, found ${pnpm}`);
  const work = fs.mkdtempSync(path.join(options.work ?? os.tmpdir(), "laterdog-task-image-"));
  const stage = path.join(work, "root");
  const store = path.join(work, "store");
  const report = { base, engines: [], at: new Date().toISOString() };
  try {
    for (const engine of engines) report.engines.push(stagePackage(stage, engine, store));
    if (wanted.has("antigravity")) report.engines.push(await stageAntigravity(stage, antigravityFromSource(fs.readFileSync(path.join(ROOT, "server/drivers/antigravity-release.ts"), "utf8")), work));
    report.layerUnpacked = bytesUnder(stage);
    report.layerCompressed = layer(stage, path.join(work, "engines.tar.gz"));
    if (!options.stageOnly) {
      crane(["append", "--base", base, "--new_layer", path.join(work, "engines.tar.gz"), "--new_tag", options.to]);
      report.image = `${repositoryOf(options.to)}@${crane(["digest", options.to])}`;
    }
    if (options.measure) {
      report.baseImage = measureImage(base);
      report.imageUnpacked = report.baseImage.unpacked + report.layerUnpacked;
      report.freeOnStandard1 = freeAfter(report.imageUnpacked, 8e9);
      report.leavesFourGb = report.freeOnStandard1 >= 4e9;
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`task image: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
