import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = new URL("./smoke-laterdog-bundle.mjs", import.meta.url).pathname;
const root = resolve(script, "..", "..");
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDirectory = (name: string) => { const directory = join(root, ".laterdog-evidence", `${name}-${stamp()}`); mkdirSync(directory, { recursive: true }); return directory; };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Receipt { ok: boolean; error?: string; computersRequests: number; checks: { name: string; ok: boolean }[]; children: { name: string; pid: number }[] }
const readReceipt = (directory: string) => JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8")) as Receipt;

describe("the compiled supervisor bundle", () => {
  it("starts from pnpm laterdog:build and carries a delegated job's choices over HTTP, retry and restart", () => {
    const evidence = evidenceDirectory("supervisor-bundle-test");
    console.info(`evidence: ${evidence}`);
    const run = spawnSync(process.execPath, [script, "--evidence", evidence], { encoding: "utf8", timeout: 420_000 });
    expect(run.status, `${run.stdout}${run.stderr}\nevidence: ${evidence}`).toBe(0);
    const receipt = readReceipt(evidence);
    expect(receipt.ok).toBe(true);
    expect(receipt.computersRequests).toBe(0);
    expect(receipt.checks.every((check) => check.ok)).toBe(true);
    expect(receipt.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
      "pnpm laterdog:build exits 0",
      "job inherits model, account and effort from the dog",
      "requested xlarge clamps to the profile ceiling standard",
      "one computer_size_clamped event is stored with the asked and ceiling sizes",
      "an unknown computer size is a 400",
      "the same requestKey returns the same job",
      "restart retains model, account, effort and size",
    ]));
  }, 450_000);

  it("stops the server and MCP children it owns when the wrapper is interrupted, and keeps its evidence", async () => {
    const bundle = join(root, "dist-server", "laterdog", "main.js");
    expect(existsSync(bundle), "run the full smoke first so the bundle exists").toBe(true);
    const evidence = evidenceDirectory("supervisor-bundle-interrupt");
    console.info(`evidence: ${evidence}`);
    const wrapper = spawn(process.execPath, [script, "--skip-build", "--evidence", evidence], { stdio: "ignore" });
    const exited = new Promise<{ code: number | null; signal: string | null }>((done) => wrapper.once("exit", (code, signal) => done({ code, signal })));
    const pidsFile = join(evidence, "children.json");
    const deadline = Date.now() + 60_000;
    let owned: { name: string; pid: number }[] = [];
    while (Date.now() < deadline && !owned.some((child) => child.name === "mcp")) {
      await wait(50);
      try { owned = JSON.parse(readFileSync(pidsFile, "utf8")); } catch {}
    }
    expect(owned.map((child) => child.name)).toEqual(expect.arrayContaining(["server-1.log", "mcp"]));
    expect(owned.every((child) => alive(child.pid))).toBe(true);
    wrapper.kill("SIGTERM");
    const result = await Promise.race([exited, wait(40_000).then(() => "timeout" as const)]);
    expect(result).not.toBe("timeout");
    expect(result).toMatchObject({ code: 143 });
    expect(owned.filter((child) => alive(child.pid))).toEqual([]);
    const receipt = readReceipt(evidence);
    expect(receipt.ok).toBe(false);
    expect(receipt.error).toContain("interrupted by SIGTERM");
    expect(existsSync(join(evidence, "server-1.log"))).toBe(true);
  }, 120_000);
});
