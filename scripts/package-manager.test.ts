import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gateSteps } from "./merge-gate.mjs";
import { pushChecks } from "./git-hooks/check-push.mjs";

const ROOT = join(import.meta.dirname, "..");
const BUN = join(ROOT, "node_modules", "bun", "bin", "bun.exe");
const PACKAGES = [
  ".",
  "deploy/laterdog/home",
  "deploy/laterdog/computers",
  "deploy/laterdog/cloudflare",
];
const made: string[] = [];
const manifest = (folder: string) =>
  JSON.parse(readFileSync(join(ROOT, folder, "package.json"), "utf8"));

afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function installPolicy(folder: string, agent: string | undefined, binary = BUN) {
  const env: NodeJS.ProcessEnv = { ...process.env, npm_execpath: binary };
  if (agent === undefined) delete env.npm_config_user_agent;
  else env.npm_config_user_agent = agent;
  return spawnSync(
    manifest(folder).scripts?.preinstall ?? (process.platform === "win32" ? "exit /b 0" : "true"),
    {
      cwd: join(ROOT, folder),
      env,
      shell: true,
      encoding: "utf8",
    },
  );
}

describe("the declared repository package manager", () => {
  it.each(PACKAGES)("pins Bun 1.4.5 and explicit lifecycle trust in %s", (folder) => {
    const pkg = manifest(folder);
    expect(pkg.packageManager).toBe("bun@1.4.5");
    expect(pkg.trustedDependencies).toEqual(
      folder === "." ? ["bun", "electron", "esbuild", "workerd"] : ["esbuild", "workerd"],
    );
    expect(pkg.pnpm).toBeUndefined();
  });

  it("keeps the existing control-plane workspace and Node production commands", () => {
    const pkg = manifest(".");
    expect(pkg.workspaces).toEqual(["cloudflare/control-plane"]);
    expect(pkg.scripts.gate).toBe("node scripts/merge-gate.mjs");
    expect(pkg.scripts.typecheck).toBe("node scripts/typecheck.mjs");
    expect(pkg.scripts["build:server"]).toContain("tsc -p tsconfig.server.build.json");
  });

  it("dispatches every own manifest script without a removed package manager", () => {
    for (const folder of [...PACKAGES, "cloudflare/control-plane"]) {
      for (const [name, command] of Object.entries(manifest(folder).scripts ?? {})) {
        expect(command, folder + ":" + name).not.toMatch(/\b(?:pnpm|npm|npx|yarn)\b/);
      }
    }
  });

  it.each(PACKAGES)("accepts the real pinned manager in %s", (folder) => {
    const result = installPolicy(folder, "bun/1.4.5");
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
  });

  for (const agent of [undefined, "pnpm/10.33.0", "npm/11.11.0", "bun/1.4.4", "bun/1.4.50"]) {
    it.each(PACKAGES)("refuses " + String(agent) + " before installing %s", (folder) => {
      const result = installPolicy(folder, agent);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Bun 1\.4\.5/);
    });
  }

  it.each(PACKAGES)(
    "rejects a claimed manager whose actual binary version differs in %s",
    (folder) => {
      const result = installPolicy(folder, "bun/1.4.5", process.execPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Bun 1\.4\.5/);
    },
  );

  it.each(PACKAGES)("fails closed when the claimed Bun binary is missing in %s", (folder) => {
    const absent = mkdtempSync(join(tmpdir(), "laterdog-manager-absent-"));
    made.push(absent);
    const result = installPolicy(folder, "bun/1.4.5", join(absent, "bun"));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Bun 1\.4\.5/);
  });
});

describe("repository check dispatch", () => {
  it("uses explicit Bun run for every complete gate step", () => {
    const steps = gateSteps();
    expect(steps).toHaveLength(16);
    for (const step of steps) expect(step.command.slice(0, 2), step.name).toEqual(["bun", "run"]);
    expect(steps.filter((step) => step.name.startsWith("suite "))).toHaveLength(8);
  });

  it.each(["bun.lock", "bunfig.toml", ".bun-version", "deploy/laterdog/home/bun.lock"])(
    "runs full lint for a changed or removed %s",
    (file) => {
      const checks = pushChecks([file], new Set<string>(), ROOT);
      expect(checks.find((check: { label: string }) => check.label === "lint")).toMatchObject({
        command: "bun",
        args: ["run", "lint"],
      });
      for (const label of ["typecheck", "locale"]) {
        expect(checks.find((check: { label: string }) => check.label === label)).toMatchObject({
          command: "bun",
        });
      }
    },
  );
});
