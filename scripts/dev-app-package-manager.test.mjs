import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDependencies } from "./dev-app.mjs";

const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fixture(packageManager) {
  const checkout = mkdtempSync(join(tmpdir(), "laterdog-dev-manager-"));
  folders.push(checkout);
  writeFileSync(join(checkout, "package.json"), JSON.stringify({ packageManager }));
  let missing = true;
  const calls = [];
  const check = () => (missing ? { kind: "dependencies" } : null);
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "--version") return "1.4.5\n";
    if (args.includes("install")) missing = false;
    return "";
  };
  return { checkout, calls, check, run, exists: () => false, node: "/node24/bin/node" };
}

describe("installing a source checkout from the Dev app", () => {
  it("checks the pinned Bun before installing the frozen dual-CPU root graph", async () => {
    const f = fixture("bun@1.4.5");
    expect(await installDependencies(f.checkout, f)).toBeNull();
    expect(f.calls).toEqual([
      ["bun", "--version"],
      ["bun", "install", "--frozen-lockfile", "--cpu=arm64", "--cpu=x64"],
    ]);
  });

  it("uses an already installed local pinned binary when one exists", async () => {
    const f = fixture("bun@1.4.5");
    const binary = join(f.checkout, "node_modules/bun/bin/bun.exe");
    f.exists = (path) => path === binary;
    expect(await installDependencies(f.checkout, f)).toBeNull();
    expect(f.calls.map((call) => call[0])).toEqual([binary, binary]);
  });

  it("rejects a different Bun before dispatching an install", async () => {
    const f = fixture("bun@1.4.5");
    const run = async (file, args) => {
      f.calls.push([file, ...args]);
      return "1.4.4\n";
    };
    await expect(installDependencies(f.checkout, { ...f, run })).rejects.toThrow(/Bun 1\.4\.5/);
    expect(f.calls).toEqual([["bun", "--version"]]);
  });

  it("reports a missing Bun without falling back to another package manager", async () => {
    const f = fixture("bun@1.4.5");
    const run = async (file, args) => {
      f.calls.push([file, ...args]);
      if (file === "bun") throw Object.assign(new Error("spawn bun ENOENT"), { code: "ENOENT" });
      return f.run(file, args);
    };
    await expect(installDependencies(f.checkout, { ...f, run })).rejects.toThrow(/Bun 1\.4\.5/);
    expect(f.calls).toEqual([["bun", "--version"]]);
  });

  it("keeps an earlier checkout's declared pnpm pin through Corepack", async () => {
    const f = fixture("pnpm@10.33.0");
    expect(await installDependencies(f.checkout, f)).toBeNull();
    expect(f.calls).toEqual([["corepack", "pnpm@10.33.0", "install", "--frozen-lockfile"]]);
  });

  it.each([undefined, "bun@latest", "npm@11.0.0"])(
    "rejects an unsupported checkout manager %s",
    async (manager) => {
      const f = fixture(manager);
      await expect(installDependencies(f.checkout, f)).rejects.toThrow(/package manager/);
      expect(f.calls).toEqual([]);
    },
  );
});
