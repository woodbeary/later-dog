import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { typecheck } from "./typecheck.mjs";

const clean = { status: 0, signal: null, stdout: "", stderr: "No type errors in 10 files [1.00ms]\n" };

function check(responses: object[] = [clean, clean], version: object = { ...clean, stdout: "1.4.5\n", stderr: "" }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const run = vi.fn().mockReturnValueOnce(version);
  for (const response of responses) run.mockReturnValueOnce(response);
  const code = typecheck({ run, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) });
  return { code, run, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("the pinned type checker", () => {
  it("fails the real command when the checkout has no local checker", () => {
    const root = mkdtempSync(join(tmpdir(), "laterdog-typecheck-test-"));
    try {
      mkdirSync(join(root, "scripts"));
      copyFileSync(new URL("./typecheck.mjs", import.meta.url), join(root, "scripts", "typecheck.mjs"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { bun: "1.4.5" } }));
      for (const project of ["app", "server"]) {
        writeFileSync(join(root, `${project}.ts`), `export const ${project} = 1;\n`);
        writeFileSync(join(root, project === "app" ? "tsconfig.json" : "tsconfig.server.json"), JSON.stringify({ files: [`${project}.ts`] }));
      }
      const result = spawnSync(process.execPath, [join(root, "scripts", "typecheck.mjs")], { cwd: root, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("pinned Bun 1.4.5 is unavailable");
      expect(result.stderr).toContain(join(root, "node_modules", "bun", "bin", "bun.exe"));
      expect(result.stdout).not.toContain(": checked");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks both complete project configs with the local binary and emits separate file counts", () => {
    const result = check();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("typecheck tsconfig.json: checked 10 files\n");
    expect(result.stdout).toContain("typecheck tsconfig.server.json: checked 10 files\n");
    const checker = join(import.meta.dirname, "..", "node_modules", "bun", "bin", "bun.exe");
    expect(result.run.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [checker, ["--version"]],
      [checker, ["check", "--no-script", "--no-pretty", "-p", "tsconfig.json"]],
      [checker, ["check", "--no-script", "--no-pretty", "-p", "tsconfig.server.json"]],
    ]);
  });

  it("normalizes the grouped file counts printed by the real checker", () => {
    const result = check([
      { ...clean, stderr: "✓ No type errors in 1,118 files [813.24ms]\n" },
      { ...clean, stderr: "✓ No type errors in 1,737 files [1147.53ms]\n" },
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("typecheck tsconfig.json: checked 1118 files\n");
    expect(result.stdout).toContain("typecheck tsconfig.server.json: checked 1737 files\n");
  });

  it.each([
    { ...clean, status: 1 },
    { ...clean, signal: "SIGTERM", status: null },
    { ...clean, error: new Error("ENOENT"), status: null },
    { ...clean, stderr: "" },
    { ...clean, stderr: "No type errors in 0 files [1.00ms]\n" },
    { ...clean, stderr: "No type errors in 1,11 files [1.00ms]\n" },
    { ...clean, stderr: "No type errors in 10 files\nNo type errors in 10 files\n" },
    { ...clean, stdout: "a.ts(1,1): error TS2322: wrong\n" },
    { ...clean, stdout: "error: TS2322: wrong\n" },
    { ...clean, stdout: "error: unable to read the project\n" },
    { ...clean, stderr: `${clean.stderr}error: unable to read the project\n` },
    { ...clean, stdout: "TS2322: wrong\n" },
    { ...clean, stdout: '<error file="a.ts" code="TS2322">wrong</error>\n' },
  ])("fails closed on a bad app result and still checks the server: %j", (response) => {
    const result = check([response, clean]);
    expect(result.code).toBe(1);
    expect(result.run).toHaveBeenCalledTimes(3);
    expect(result.stdout).not.toContain("typecheck tsconfig.json: checked");
    expect(result.stdout).toContain("typecheck tsconfig.server.json: checked 10 files");
    expect(result.stderr).toContain("typecheck tsconfig.json failed");
  });

  it("does not let an app pass hide a failing server or discard its diagnostics", () => {
    const result = check([clean, { ...clean, status: 1, stdout: "server.ts(1,1): error TS2339: missing\n", stderr: "server diagnostic\n" }]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("server.ts(1,1): error TS2339: missing");
    expect(result.stderr).toContain("server diagnostic");
    expect(result.stdout).not.toContain("typecheck tsconfig.server.json: checked");
  });

  it.each([
    { ...clean, error: new Error("ENOENT"), status: null },
    { ...clean, signal: "SIGKILL", status: null },
    { ...clean, status: 1 },
    { ...clean, stdout: "1.3.0\n" },
  ])("refuses a missing, broken or different checker before accepting any graph: %j", (version) => {
    const result = check([], version);
    expect(result.code).toBe(1);
    expect(result.run).toHaveBeenCalledTimes(1);
    expect(result.stderr).toContain("pinned Bun 1.4.5 is unavailable");
    expect(result.stdout).not.toContain(": checked");
  });
});
