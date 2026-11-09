import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const scratch = mkdtempSync(join(tmpdir(), "laterdog-codex-guard-"));
vi.stubEnv("LATERDOG_HOME", scratch);
const { prepareCodexShellGuard } = await import("./codex-shell-guard.ts");
afterEach(() => vi.unstubAllEnvs());
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

it("gives concurrent native Codex turns separate scoped hook files and never places a token in argv", () => {
  const first: NodeJS.ProcessEnv = {};
  const second: NodeJS.ProcessEnv = {};
  prepareCodexShellGuard(first, "one", { url: "http://127.0.0.1:8799", token: "fixture-first", guardShell: true });
  prepareCodexShellGuard(second, "two", { url: "http://127.0.0.1:8799", token: "fixture-second", guardShell: true });
  expect(first.LATERDOG_HOOK_URL).toBe("http://127.0.0.1:8799");
  expect(first.LATERDOG_HOOK_TOKEN_FILE).not.toBe(second.LATERDOG_HOOK_TOKEN_FILE);
  expect(readFileSync(first.LATERDOG_HOOK_TOKEN_FILE!, "utf8")).toBe("fixture-first");
  expect(readFileSync(second.LATERDOG_HOOK_TOKEN_FILE!, "utf8")).toBe("fixture-second");
  expect(statSync(first.LATERDOG_HOOK_TOKEN_FILE!).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(first)).not.toContain("fixture-first");
});

it("removes inherited hook authority when the home guard is off", () => {
  for (const hooks of [undefined, { url: "http://127.0.0.1:8799", token: "fixture", guardShell: false }]) {
    const env: NodeJS.ProcessEnv = { LATERDOG_HOOK_URL: "old", LATERDOG_HOOK_TOKEN_FILE: "old" };
    prepareCodexShellGuard(env, "off", hooks);
    expect(env).toEqual({});
  }
});
