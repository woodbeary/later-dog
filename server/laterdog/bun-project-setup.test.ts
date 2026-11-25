import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENVIRONMENT_PRELUDE } from "../../deploy/laterdog/computers/src/environments";
import { AUTO_SETUP_SCRIPT } from "./cloud-task-files";

const made: string[] = [];
afterEach(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});
function setup(
  script: string,
  {
    version = "1.4.5",
    pin = "bun@1.4.5",
    installed = "1.4.5",
    npmStatus = 0,
    own = true,
  }: {
    version?: string | null;
    pin?: string;
    installed?: string;
    npmStatus?: number;
    own?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "laterdog-bun-setup-"));
  made.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const state = join(root, "version");
  const calls = join(root, "calls");
  const template = join(root, "bun-template");
  writeFileSync(state, version ?? "");
  writeFileSync(
    template,
    [
      "#!/bin/bash",
      'if [ "$1" = --version ]; then cat "$BUN_FIXTURE_STATE"; exit 0; fi',
      'printf "bun %s\\n" "$*" >> "$BUN_FIXTURE_CALLS"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  if (version !== null) {
    writeFileSync(join(bin, "bun"), readFileSync(template), { mode: 0o755 });
  }
  writeFileSync(
    join(bin, "npm"),
    [
      "#!/bin/bash",
      'printf "npm %s\\n" "$*" >> "$BUN_FIXTURE_CALLS"',
      "if [ " + npmStatus + " -ne 0 ]; then exit " + npmStatus + "; fi",
      'mkdir -p "$HOME/.local/bin"',
      'cp "$BUN_FIXTURE_TEMPLATE" "$HOME/.local/bin/bun"',
      'printf "%s\\n" "' + installed + '" > "$BUN_FIXTURE_STATE"',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  chmodSync(join(bin, "npm"), 0o755);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: own ? "laterdog" : "other-project",
      packageManager: pin,
      repository: {
        url: own
          ? "https://github.com/woodbeary/later-dog.git"
          : "https://example.test/project.git",
      },
    }),
  );
  writeFileSync(join(root, "bun.lock"), "{}");
  const result = spawnSync("/bin/bash", ["-c", script], {
    cwd: root,
    encoding: "utf8",
    env: {
      PATH: bin + ":" + dirname(process.execPath) + ":/usr/bin:/bin",
      HOME: root,
      BUN_FIXTURE_STATE: state,
      BUN_FIXTURE_CALLS: calls,
      BUN_FIXTURE_TEMPLATE: template,
    },
  });
  let trace = "";
  try {
    trace = readFileSync(calls, "utf8");
  } catch {}
  return { ...result, trace, root };
}

describe.each([
  ["cloud task", AUTO_SETUP_SCRIPT],
  ["computer environment", ENVIRONMENT_PRELUDE + "\nlaterdog_install\n"],
])("%s Bun setup", (_label, script) => {
  it("keeps the exact available manager and the repository's two native CPU targets", () => {
    const result = setup(script);
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toBe("bun install --frozen-lockfile --cpu=arm64 --cpu=x64\n");
  });
  it.each([null, "1.4.4"])(
    "bootstraps the declared exact pin when the manager is %s",
    (version) => {
      const result = setup(script, { version });
      expect(result.status, result.stderr).toBe(0);
      expect(result.trace).toBe(
        "npm install -g --prefix " +
          result.root +
          "/.local bun@1.4.5\nbun install --frozen-lockfile --cpu=arm64 --cpu=x64\n",
      );
    },
  );
  it("preserves a failed bootstrap without dispatching an install", () => {
    const result = setup(script, { version: null, npmStatus: 17 });
    expect(result.status).toBe(17);
    expect(result.trace).not.toContain("bun install");
  });
  it("refuses an installer that did not provide the requested version", () => {
    const result = setup(script, { version: null, installed: "1.4.4" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Bun 1.4.5");
    expect(result.trace).not.toContain("bun install");
  });
  it("rejects a floating declared pin without fetching or installing", () => {
    const result = setup(script, { pin: "bun@latest" });
    expect(result.status).not.toBe(0);
    expect(result.trace).toBe("");
  });
  it("keeps other Bun projects' default CPU policy", () => {
    const result = setup(script, { own: false });
    expect(result.status, result.stderr).toBe(0);
    expect(result.trace).toBe("bun install --frozen-lockfile\n");
  });
});
