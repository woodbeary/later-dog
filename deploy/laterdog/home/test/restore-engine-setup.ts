import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CRATE = join(import.meta.dirname, "..", "..", "home-restore");

function cargo(): string {
  const candidates = [process.env.CARGO, join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin", "cargo"), "cargo"].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) if (spawnSync(candidate, ["--version"]).status === 0) return candidate;
  throw new Error("The restore engine tests need Rust's cargo: install Rust, or set CARGO (and CARGO_HOME, RUSTUP_HOME) to an existing toolchain");
}

export default function setup() {
  if (process.env.LATERDOG_RESTORE_ENGINE && existsSync(process.env.LATERDOG_RESTORE_ENGINE)) return;
  const built = spawnSync(cargo(), ["build", "--release", "--locked"], { cwd: CRATE, stdio: ["ignore", "inherit", "inherit"] });
  if (built.status !== 0) throw new Error("the restore engine did not build");
  process.env.LATERDOG_RESTORE_ENGINE = join(CRATE, "target", "release", "laterdog-restore");
}
