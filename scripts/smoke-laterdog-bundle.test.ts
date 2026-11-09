import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = new URL("./smoke-laterdog-bundle.mjs", import.meta.url).pathname;
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })); });

describe("the compiled supervisor bundle", () => {
  it("is built by the one server bundler", () => {
    expect(packageJson.scripts["laterdog:build"]).toBe("pnpm build:server");
  });

  it("starts from pnpm laterdog:build and carries a delegated job's choices over HTTP, retry and restart", () => {
    const evidence = mkdtempSync(join(tmpdir(), "laterdog-bundle-evidence-"));
    directories.push(evidence);
    const run = spawnSync(process.execPath, [script, "--evidence", evidence], { encoding: "utf8", timeout: 420_000 });
    const receipt = JSON.parse(readFileSync(join(evidence, "receipt.json"), "utf8")) as { ok: boolean; computersRequests: number; checks: { name: string; ok: boolean }[] };
    expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);
    expect(receipt.ok).toBe(true);
    expect(receipt.computersRequests).toBe(0);
    expect(receipt.checks.every((check) => check.ok)).toBe(true);
    expect(receipt.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "pnpm laterdog:build exits 0",
      "job inherits model, account and effort from the dog",
      "requested xlarge clamps to the profile ceiling standard",
      "an unknown computer size is a 400",
      "the same requestKey returns the same job",
      "restart retains model, account, effort and size",
    ]));
  }, 450_000);
});
