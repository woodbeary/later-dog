#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CRATE = path.join(ROOT, "deploy/laterdog/computers/pool-agent");
export const TARGET = "x86_64-unknown-linux-musl";
export const AGENT_PATH = "usr/local/bin/laterdog-pool-agent";
export const RELAY_PATH = "home/dog/.laterdog-engine/cli/pool-relay";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--base") options.base = value();
    else if (arg === "--to") options.to = value();
    else if (arg === "--work") options.work = value();
    else if (arg === "--build-only") options.buildOnly = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!options.buildOnly && (!options.base || !options.to)) throw new Error("--base <task image> and --to <registry/repository:tag> are required, or --build-only");
  return options;
}

export function buildAgent(targetDir) {
  run("cargo", ["build", "--release", "--locked", "--target", TARGET, "--manifest-path", path.join(CRATE, "Cargo.toml")], {
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, [`CARGO_TARGET_${TARGET.toUpperCase().replaceAll("-", "_")}_LINKER`]: "rust-lld" },
  });
  return path.join(targetDir, TARGET, "release", "laterdog-pool-agent");
}

export function repositoryOf(ref) {
  return ref.includes("@") ? ref.split("@")[0] : ref.replace(/:[^/:]+$/, "");
}

export async function main(argv) {
  const options = parseArgs(argv);
  const work = fs.mkdtempSync(path.join(options.work ?? os.tmpdir(), "laterdog-pool-image-"));
  try {
    const binary = buildAgent(path.join(options.work ?? work, "target"));
    const report = { agentBytes: fs.statSync(binary).size, at: new Date().toISOString() };
    if (options.buildOnly) return print({ ...report, binary });
    const stage = path.join(work, "root");
    fs.mkdirSync(path.join(stage, path.dirname(AGENT_PATH)), { recursive: true });
    fs.copyFileSync(binary, path.join(stage, AGENT_PATH));
    fs.chmodSync(path.join(stage, AGENT_PATH), 0o755);
    fs.mkdirSync(path.join(stage, path.dirname(RELAY_PATH)), { recursive: true });
    fs.copyFileSync(path.join(CRATE, "pool-relay"), path.join(stage, RELAY_PATH));
    fs.chmodSync(path.join(stage, RELAY_PATH), 0o755);
    const layer = path.join(work, "agent.tar.gz");
    run("tar", ["--no-mac-metadata", "--no-xattrs", "--no-acls", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root", "-C", stage, "-czf", layer, AGENT_PATH, RELAY_PATH], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    run(process.env.CRANE ?? "crane", ["append", "--base", options.base, "--new_layer", layer, "--new_tag", options.to]);
    const digest = run(process.env.CRANE ?? "crane", ["digest", options.to]).trim();
    return print({ ...report, base: options.base, layerBytes: fs.statSync(layer).size, image: `${repositoryOf(options.to)}@${digest}` });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function print(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`pool image: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
