import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const isolatedEnv = (home, extra = {}) => ({ PATH: process.env.PATH, HOME: home, USERPROFILE: home, LATERDOG_HOME: join(home, ".laterdog"), LATERDOG_TRIAL_API: "off", ...extra });

it("the production MCP bundle initializes and drains without source dependencies", () => {
  execFileSync(process.execPath, [join(root, "scripts/bundle-server.mjs")], { cwd: root, timeout: 60_000, stdio: "pipe" });
  const home = mkdtempSync(join(tmpdir(), "laterdog-mcp-bundle-test-"));
  try {
    const entry = join(home, "mcp-server.js");
    copyFileSync(join(root, "dist-server/mcp-server.js"), entry);
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "bundle-regression", version: "1" } } },
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ].map(value => JSON.stringify(value)).join("\n") + "\n";
    const result = spawnSync(process.execPath, [entry], { cwd: home, env: isolatedEnv(home), input, encoding: "utf8", timeout: 10_000 });
    expect(result.stderr).not.toContain("Dynamic require");
    expect(result.status, result.stderr).toBe(0);
    const replies = result.stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    expect(replies.find(reply => reply.id === 1)?.result?.serverInfo?.name).toBe("laterdog-mcp");
    expect(replies.find(reply => reply.id === 2)?.result).toEqual({});
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 75_000);

it("the package check finishes when MCP exits before its health probe", () => {
  const home = mkdtempSync(join(tmpdir(), "laterdog-package-failure-test-"));
  try {
    writeFileSync(join(home, "index.js"), `import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(home, "server.pid"))}, String(process.pid));
createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(request.url === "/api/health" ? { pid: process.pid } : request.url.startsWith("/api/search") ? { hits: [] } : {}));
}).listen(Number(process.env.LATERDOG_SERVER_PORT), "127.0.0.1");
`);
    writeFileSync(join(home, "mcp-server.js"), "process.exit(23);\n");
    writeFileSync(join(home, "proxy-paths.js"), "export const SPAWNED_PROXIES = {};\n");
    const result = spawnSync(process.execPath, [join(root, "scripts/smoke-packaged-server.mjs")], {
      cwd: home, env: isolatedEnv(home, { LATERDOG_SMOKE_DIST: home }), encoding: "utf8", timeout: 8_000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the packaged container launcher did not run the server");
  } finally {
    try { process.kill(Number(readFileSync(join(home, "server.pid"), "utf8")), "SIGKILL"); } catch {}
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);
