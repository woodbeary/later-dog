import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./sealed-installed-app.sh", import.meta.url));
const REAL_HOME = userInfo().homedir;
const DENIED = [".laterdog", "Library/Application Support/later.dog", ".claude", ".codex"].map(path => join(REAL_HOME, path));
const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

const workspaces: string[] = [];
afterEach(() => {
  for (const dir of workspaces.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

function workspace(port8799Busy: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "sealed-local-"));
  workspaces.push(dir);
  const parent = join(dir, "parent");
  const bin = join(dir, "bin");
  const app = join(dir, "build", "later.dog.app");
  const report = join(dir, "report.txt");
  const probes = join(dir, "probes.txt");
  mkdirSync(parent);
  mkdirSync(bin);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(bin, "lsof"), `#!/bin/sh\nexit ${port8799Busy ? 0 : 1}\n`);
  chmodSync(join(bin, "lsof"), 0o755);
  writeFileSync(probes, [...DENIED, dir].join("\n") + "\n");
  writeFileSync(join(app, "Contents", "MacOS", "later.dog"), `#!/bin/bash
port="\${3#--remote-debugging-port=}"
{
  printf 'args=%s\\n' "$*"
  env | sort | sed 's/^/env:/'
  while IFS= read -r probe; do
    if failure=$(ls "$probe" 2>&1 >/dev/null); then echo "read:$probe"; else echo "blocked:$probe:$failure"; fi
  done <'${probes}'
} >'${report}'
mkdir -p "$HOME/Library/Application Support/later.dog"
for _ in 1 2; do
  printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n{}' | nc -l 127.0.0.1 "$port" >/dev/null
done
`);
  chmodSync(join(app, "Contents", "MacOS", "later.dog"), 0o755);
  return { dir, parent, bin, app, report };
}

function runLocal(space: ReturnType<typeof workspace>, port: number) {
  return spawnSync("/bin/bash", [SCRIPT, "--local", space.app, String(port)], {
    encoding: "utf8",
    timeout: 60_000,
    env: { PATH: `${space.bin}:${SYSTEM_PATH}`, USER: userInfo().username, LATERDOG_SEALED_PARENT: space.parent, SEALED_TEST_LEAK: "leaked" },
  });
}

describe.skipIf(process.platform === "win32")("sealed launcher with a local build", () => {
  it("refuses to start while something serves on port 8799 and leaves nothing behind", async () => {
    const space = workspace(true);
    const result = runLocal(space, await freePort());
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("something already serves on port 8799");
    expect(existsSync(space.report)).toBe(false);
    expect(readdirSync(space.parent)).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin")("runs a copy of the build in the sandbox with a sealed home and no download", async () => {
    const space = workspace(false);
    const port = await freePort();
    const result = runLocal(space, port);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("skipped download, checksums, signature and notarization: local build");
    expect(result.stdout).toContain(`the local build ${space.app} is running sealed`);

    const report = readFileSync(space.report, "utf8").split("\n");
    const env = new Map(report.filter(line => line.startsWith("env:")).map(line => {
      const [key, ...value] = line.slice(4).split("=");
      return [key, value.join("=")] as const;
    }));
    const home = env.get("HOME") ?? "";
    expect(home).toMatch(new RegExp(`^${space.parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/laterdog-sealed\\.[^/]+/home$`));
    expect(env.get("CFFIXED_USER_HOME")).toBe(home);
    expect(env.get("LATERDOG_HOME")).toBe(`${home}/.laterdog`);
    expect(env.get("TMPDIR")).toBe(`${home}/tmp`);
    expect(env.has("SEALED_TEST_LEAK")).toBe(false);
    expect(report).toContain(`args=--no-sandbox --use-mock-keychain --remote-debugging-port=${port}`);

    const present = DENIED.filter(path => existsSync(path));
    expect(present.length).toBeGreaterThan(0);
    for (const path of present) expect(report).toContain(`blocked:${path}:ls: ${path}: Operation not permitted`);
    expect(report).toContain(`read:${space.dir}`);
    expect(readdirSync(space.parent)).toEqual([]);
    expect(existsSync(join(space.app, "Contents", "MacOS", "later.dog"))).toBe(true);
  }, 90_000);
});
