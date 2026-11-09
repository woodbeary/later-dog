import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { claudeProjectSlug, planClaudeRemote, spawnPlacedEngine, type ClaudeRemotePlan } from "./engine-placement.ts";
import { pointerPaths, readPointer } from "./engine-pointer.ts";
import { commandLink, type EngineLink } from "./engine-remote.ts";
import { bringWorkspaceHome, readOwnedWorkspaceFile } from "./engine-workspace-access.ts";
import { WORKSPACE_CAPS } from "./engine-workspace.ts";

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));
const RELAY = here("./engine-relay.ts");
const PROXY = here("./engine-proxy.ts");
const FAKE = here("../testing/fake-remote-engine.ts");
const scratch: string[] = [];
const running: Array<{ kill(): unknown }> = [];
const servers: Array<{ close(done: () => void): unknown }> = [];
afterEach(async () => {
  for (const child of running.splice(0)) try { child.kill(); } catch {}
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

type Control = Parameters<NonNullable<EngineLink["control"]>>[0];

function world() {
  const base = realpathSync(mkdtempSync("/tmp/ldown-"));
  scratch.push(base);
  const cwd = join(base, "home", "work");
  const configDir = join(base, "home", "config");
  const remoteRoot = join(base, "remote");
  const remoteBase = join(base, "rb");
  const dataDir = join(base, "data");
  for (const dir of [cwd, configDir, remoteRoot, join(base, "launch")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(cwd, "input.txt"), "from home");
  writeFileSync(join(cwd, "remove-me.txt"), "old");
  writeFileSync(join(cwd, "big.bin"), Buffer.alloc(WORKSPACE_CAPS.artifactFileBytes + 1, 7));
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "access-value", refreshToken: "refresh-value", expiresAt: Date.now() + 2 * 3600_000 } }));
  writeFileSync(join(configDir, ".claude.json"), "{}");
  const pkg = join(base, "pkg", "node_modules", "@anthropic-ai", "claude-code");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "9.9.9" }));
  writeFileSync(join(pkg, "bin", "claude"), "#!/bin/sh\n");
  const remoteBin = join(remoteBase, "cli", "claude-code-9.9.9", "node_modules", ".bin");
  mkdirSync(remoteBin, { recursive: true });
  writeFileSync(join(remoteBin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(remoteBin, "claude"), 0o755);
  symlinkSync(process.execPath, join(remoteBin, "node"));
  const mcpServer = join(base, "mcp-echo.mjs");
  writeFileSync(mcpServer, `process.stdin.once("data", () => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n"));\n`);
  const mcpPath = join(base, "launch", "mcp.json");
  writeFileSync(mcpPath, JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [mcpServer] } } }));
  const settingsPath = join(base, "launch", "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ hooks: { PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "cat >/dev/null", timeout: 5 }] }] } }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: join(base, "home"), CLAUDE_CONFIG_DIR: configDir, FAKE_ENGINE_SLUG: claudeProjectSlug(cwd) };
  const args = (resume: boolean) => ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--mcp-config", mcpPath, "--settings", settingsPath, resume ? "--resume" : "--session-id", "s-1"];
  const plan = (resume = false, workspaceOnComputer = true) => {
    const planned = planClaudeRemote({ botId: "bot-1", threadId: "thread-1", sessionId: "s-1", cliCommand: join(pkg, "bin", "claude"), args: args(resume), cwd, env,
      managed: false, dataDir, proxyPath: PROXY, remoteBase, workspaceOnComputer });
    if (!("plan" in planned)) throw new Error(planned.stay);
    return planned.plan;
  };
  const holds = new Map<string, number>();
  const controls: Control[] = [];
  const control = async (frame: Control) => {
    controls.push(frame);
    if (frame.channel === "hold") holds.set(frame.key, Math.max(holds.get(frame.key) ?? 0, frame.writtenAt!));
    else {
      if ((holds.get(frame.key) ?? 0) > frame.through!) throw new Error("The workspace changed after it was copied home, so the computer keeps holding it.");
      holds.delete(frame.key);
    }
    return null;
  };
  const relay = async (): Promise<EngineLink> => {
    const link = commandLink(process.execPath, [RELAY], { ...process.env, LATERDOG_ENGINE_TEST_ROOT: remoteRoot });
    link.control = control;
    return link;
  };
  let localLaunches = 0;
  const local = (resume = false) => () => {
    localLaunches += 1;
    const child = spawn(process.execPath, [FAKE, ...args(resume)], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    running.push(child);
    return child;
  };
  const start = (planned: ClaudeRemotePlan, link: () => Promise<EngineLink> = relay, resume = false) => {
    const placed: string[] = [];
    const reasons: string[] = [];
    const engine = spawnPlacedEngine(planned, link, local(resume), (where, why) => { placed.push(where); if (why) reasons.push(why); });
    running.push(engine);
    let stderr = "";
    engine.stderr.on("data", (bytes) => { stderr += bytes; });
    return { engine, placed, reasons, stderr: () => stderr };
  };
  const mirror = (path: string) => join(remoteRoot, path);
  const pointer = () => readPointer(dataDir, "bot-1", cwd);
  const paths = pointerPaths(dataDir, "bot-1", cwd);
  return { base, cwd, dataDir, remoteRoot, plan, start, relay, control, mirror, holds, controls, pointer, paths, localLaunches: () => localLaunches,
    sessionFile: join(configDir, "projects", claudeProjectSlug(cwd), "s-1.jsonl") };
}

const message = (text: string) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
function turn(engine: { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream }, text: string): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: engine.stdout });
    let stderr = "";
    (engine as unknown as { stderr: NodeJS.ReadableStream }).stderr.on("data", (bytes) => { stderr += bytes; });
    const timer = setTimeout(() => reject(new Error(`no result; stderr: ${stderr}`)), 30_000);
    lines.on("line", (line) => {
      const frame = JSON.parse(line);
      if (frame.type !== "result") return;
      clearTimeout(timer);
      lines.close();
      resolve(JSON.parse(frame.result));
    });
    engine.stdin.write(message(text));
  });
}
const closed = (engine: { once(event: "close", listener: (code: number | null) => void): unknown }) => new Promise<number | null>((resolve) => engine.once("close", resolve));
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

async function ownedRun(w: ReturnType<typeof world>, text: string, resume = false) {
  const run = w.start(w.plan(resume), w.relay, resume);
  const result = await turn(run.engine, text);
  run.engine.stdin.end();
  expect(await closed(run.engine)).toBe(0);
  return { ...run, result };
}

describe("a placed Claude dog whose workspace lives on its computer", () => {
  it("keeps new writes on the computer and gives the home only the manifest, capped artifacts and the session", async () => {
    const w = world();
    const launchedAt = Date.now();
    const { placed, reasons, result } = await ownedRun(w, "hello");
    expect({ placed, reasons }).toEqual({ placed: ["computer"], reasons: [] });
    expect(result.input).toBe("from home");
    expect(readFileSync(w.mirror(join(w.cwd, "turn-1.txt")), "utf8")).toBe("hello");
    expect(existsSync(join(w.cwd, "turn-1.txt"))).toBe(false);
    expect(readFileSync(join(w.cwd, "remove-me.txt"), "utf8")).toBe("old");
    expect(existsSync(w.mirror(join(w.cwd, "remove-me.txt")))).toBe(false);
    expect(existsSync(w.sessionFile)).toBe(true);

    const pointer = w.pointer()!;
    expect(pointer).toMatchObject({ state: "held", seeded: true, key: w.paths.key });
    const listed = new Map(pointer.manifest!.files.map((file) => [file.path, file]));
    expect([...listed.keys()].sort()).toEqual(["big.bin", "input.txt", "turn-1.txt"]);
    expect(listed.get("turn-1.txt")!.hash).toBe(sha("hello"));
    expect(pointer.manifest).toMatchObject({ totalFiles: 3, truncated: false });
    expect(pointer.artifacts.map((artifact) => artifact.path).sort()).toEqual(["input.txt", "turn-1.txt"]);
    expect(readFileSync(join(w.paths.artifacts, "turn-1.txt"), "utf8")).toBe("hello");
    expect(existsSync(join(w.paths.artifacts, "big.bin"))).toBe(false);

    expect(w.holds.get(w.paths.key)).toBeGreaterThanOrEqual(launchedAt);
    expect(w.controls.every((frame) => frame.channel === "hold" && frame.key === w.paths.key)).toBe(true);
    expect(w.controls.length).toBeGreaterThanOrEqual(2);
    expect(pointer.writtenAt).toBe(w.holds.get(w.paths.key));
  }, 60_000);

  it("lets the computer's copy win on the next launch instead of pushing the home's older copy", async () => {
    const w = world();
    await ownedRun(w, "one");
    writeFileSync(join(w.cwd, "input.txt"), "edited on the home later");
    const { result } = await ownedRun(w, "two", true);
    expect(result.input).toBe("from home");
    expect(readFileSync(w.mirror(join(w.cwd, "turn-1.txt")), "utf8")).toBe("two");
    expect(readFileSync(join(w.cwd, "input.txt"), "utf8")).toBe("edited on the home later");
  }, 60_000);

  it("reads a file on demand from the computer, and when it cannot be reached only from copies that match the manifest", async () => {
    const w = world();
    await ownedRun(w, "hello");
    const fresh = await readOwnedWorkspaceFile({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, path: "turn-1.txt", relay: w.relay });
    expect(fresh).toMatchObject({ source: "computer", matchesManifest: true, hash: sha("hello") });
    expect(fresh.bytes.toString()).toBe("hello");
    await expect(readOwnedWorkspaceFile({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, path: "nope.txt", relay: w.relay })).rejects.toMatchObject({ status: 404 });
    await expect(readOwnedWorkspaceFile({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, path: "../escape", relay: w.relay })).rejects.toMatchObject({ status: 400 });

    const asleep = async (): Promise<EngineLink> => { throw new Error("the cloud computer did not wake"); };
    const saved = await readOwnedWorkspaceFile({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, path: "turn-1.txt", relay: asleep });
    expect(saved).toMatchObject({ source: "artifact", matchesManifest: true, note: expect.stringMatching(/could not be reached/) });
    const unchanged = await readOwnedWorkspaceFile({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, path: "big.bin", relay: asleep });
    expect(unchanged).toMatchObject({ source: "home", matchesManifest: true });
    writeFileSync(join(w.cwd, "big.bin"), "stale");
    await expect(readOwnedWorkspaceFile({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, path: "big.bin", relay: asleep })).rejects.toMatchObject({ status: 503 });
  }, 60_000);

  it("fails the turn rather than running on the home's older copy once the computer owns the workspace", async () => {
    const w = world();
    await ownedRun(w, "hello");
    const plan = w.plan(true);
    expect(plan.launch.ownership!.homeFallback).toBe(false);
    const run = w.start(plan, async () => { throw new Error("computer could not start"); }, true);
    expect(await closed(run.engine)).toBe(1);
    expect(run.stderr()).toMatch(/computer could not start.*lives on its cloud computer, so the turn was not run on the home/s);
    expect(w.localLaunches()).toBe(0);
  }, 60_000);

  it("rebuilds a lost workspace from the home copy and saved artifacts, and names what could not be recovered", async () => {
    const w = world();
    await ownedRun(w, "hello");
    writeFileSync(w.mirror(join(w.cwd, "computer-only.bin")), Buffer.alloc(WORKSPACE_CAPS.artifactFileBytes + 5, 1));
    await ownedRun(w, "again", true);
    expect(w.pointer()!.manifest!.files.map((file) => file.path)).toContain("computer-only.bin");
    rmSync(w.mirror(w.cwd), { recursive: true, force: true });
    const run = w.start(w.plan(true), w.relay, true);
    const result = await turn(run.engine, "after loss");
    run.engine.stdin.end();
    expect(await closed(run.engine)).toBe(0);
    expect(result.input).toBe("from home");
    expect(run.stderr()).toMatch(/rebuilt from the home's copy and \d+ saved file\(s\).*1 file\(s\) that existed only on the computer could not be recovered: computer-only\.bin/s);
    expect(w.pointer()!.recovered).toMatchObject({ missing: 1 });
  }, 60_000);

  it("brings a workspace home through the relay, keeps home edits as conflicts, never deletes a home file, and only then releases the hold", async () => {
    const w = world();
    await ownedRun(w, "hello");
    writeFileSync(join(w.cwd, "input.txt"), "edited on the home");
    writeFileSync(w.mirror(join(w.cwd, "input.txt")), "edited on the computer");
    await expect(bringWorkspaceHome({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, relay: w.relay, freeBytes: () => 0 })).rejects.toMatchObject({ status: 507 });
    expect(w.holds.has(w.paths.key)).toBe(true);
    expect(w.pointer()!.state).toBe("held");

    const brought = await bringWorkspaceHome({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, relay: w.relay, freeBytes: () => 1e12 });
    expect(brought).toMatchObject({ released: true, conflicts: ["input.txt"] });
    expect(brought.files).toBe(3);
    expect(readFileSync(join(w.cwd, "turn-1.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(w.cwd, "input.txt"), "utf8")).toBe("edited on the home");
    expect(readFileSync(join(w.paths.conflicts, "input.txt"), "utf8")).toBe("edited on the computer");
    expect(readFileSync(join(w.cwd, "remove-me.txt"), "utf8")).toBe("old");
    expect(w.holds.has(w.paths.key)).toBe(false);
    expect(w.controls.at(-1)).toMatchObject({ channel: "release", key: w.paths.key });
    expect(w.pointer()).toMatchObject({ state: "home", seeded: false });
  }, 60_000);

  it("keeps the hold when the computer has newer work than the copy", async () => {
    const w = world();
    await ownedRun(w, "hello");
    w.holds.set(w.paths.key, Date.now() + 60_000);
    await expect(bringWorkspaceHome({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, relay: w.relay, freeBytes: () => 1e12 })).rejects.toMatchObject({ status: 409 });
    expect(w.holds.has(w.paths.key)).toBe(true);
    expect(w.pointer()!.state).toBe("held");
  }, 60_000);

  it("leaves the default path untouched: the home keeps every write and no hold is asked for", async () => {
    const w = world();
    const run = w.start(w.plan(false, false));
    await turn(run.engine, "hello");
    run.engine.stdin.end();
    expect(await closed(run.engine)).toBe(0);
    expect(readFileSync(join(w.cwd, "turn-1.txt"), "utf8")).toBe("hello");
    expect(existsSync(join(w.cwd, "remove-me.txt"))).toBe(false);
    expect(w.controls).toEqual([]);
    expect(w.pointer()).toBeNull();
  }, 60_000);

  it("falls back to the home on the first launch if the computer will not hold the workspace, and owns nothing afterwards", async () => {
    const w = world();
    const noHold = async (): Promise<EngineLink> => {
      const link = commandLink(process.execPath, [RELAY], { ...process.env, LATERDOG_ENGINE_TEST_ROOT: w.remoteRoot });
      link.control = async () => { throw new Error("This computer cannot hold workspaces."); };
      return link;
    };
    const run = w.start(w.plan(), noHold);
    await turn(run.engine, "hello");
    run.engine.stdin.end();
    await closed(run.engine);
    expect(run.placed).toEqual(["home"]);
    expect(readFileSync(join(w.cwd, "turn-1.txt"), "utf8")).toBe("hello");
    expect(w.pointer()).toBeNull();
  }, 60_000);
});

describe("a first launch that fails before the workspace is seeded", () => {
  it("runs on the home, releases the hold it took and leaves nothing owned by the computer", async () => {
    const w = world();
    const dying = async (): Promise<EngineLink> => {
      const link = commandLink(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ type: 'ready' }) + '\\n'); process.stdin.once('data', () => process.exit(1));"]);
      link.control = w.control;
      return link;
    };
    const run = w.start(w.plan(), dying);
    await turn(run.engine, "hello");
    run.engine.stdin.end();
    await closed(run.engine);
    expect(run.placed).toEqual(["home"]);
    expect(readFileSync(join(w.cwd, "turn-1.txt"), "utf8")).toBe("hello");
    expect(w.controls.map((frame) => frame.channel)).toEqual(["hold", "release"]);
    expect(w.holds.size).toBe(0);
    expect(w.pointer()).toMatchObject({ state: "home", seeded: false });
  }, 60_000);
});

describe("reading from a sleeping computer through the real home path", () => {
  it("wakes the computer, opens the process stream and reads through the relay", async () => {
    const w = world();
    await ownedRun(w, "hello");
    const key = `ldc_${"k".repeat(48)}`;
    const keyFile = join(w.base, "computers-key");
    writeFileSync(keyFile, `${key}\n`, { mode: 0o600 });
    const { DATA_DIR } = await import("../config.ts");
    const environmentId = (await import("../environment.ts")).loadEnvironmentId(DATA_DIR);
    const hex = (value: string) => createHash("sha256").update(value).digest("hex");
    const computer = { id: "cmp_sleepy", name: `dog-${hex(environmentId).slice(0, 12)}-bot1-${hex("bot-1").slice(0, 6)}`, state: "sleeping" };
    const calls: string[] = [];
    const api: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://stub.test");
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        calls.push(`${req.method} ${url.pathname}`);
        const send = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
        if (req.headers.authorization !== `Bearer ${key}`) return send(401, { error: { code: "unauthorized" } });
        if (url.pathname === "/v1/computers") return send(200, { computers: [computer] });
        if (url.pathname === `/v1/computers/${computer.id}`) return send(200, { computer });
        if (url.pathname === `/v1/computers/${computer.id}/wake`) { computer.state = "running"; return send(200, { computer }); }
        if (url.pathname === `/v1/computers/${computer.id}/exec`) {
          if (computer.state !== "running") return send(409, { error: { code: "asleep" } });
          return send(200, { exitCode: 0, stdout: String(JSON.parse(body).command).startsWith("test -f") ? "present\n" : "", stderr: "" });
        }
        return send(404, { error: { code: "not_found" } });
      });
    });
    const sockets = new WebSocketServer({ noServer: true });
    api.on("upgrade", (req, socket, head) => {
      if (req.url !== `/v1/computers/${computer.id}/process` || computer.state !== "running" || req.headers.authorization !== `Bearer ${key}`) { socket.destroy(); return; }
      calls.push("UPGRADE process");
      sockets.handleUpgrade(req, socket, head, (ws) => {
        let child: ChildProcess | null = null;
        ws.on("message", (raw) => {
          const frame = JSON.parse(String(raw));
          if (frame.channel === "start") {
            child = spawn(process.execPath, [RELAY], { env: { ...process.env, LATERDOG_ENGINE_TEST_ROOT: w.remoteRoot }, stdio: ["pipe", "pipe", "pipe"] });
            running.push(child);
            child.stdout!.on("data", (bytes: Buffer) => ws.send(JSON.stringify({ channel: "stdout", data: bytes.toString("base64") })));
            child.on("close", (code) => { ws.send(JSON.stringify({ channel: "exit", code })); ws.close(); });
          } else if (frame.channel === "stdin") child?.stdin!.write(Buffer.from(frame.data, "base64"));
          else if (frame.channel === "stop") child?.kill();
        });
        ws.on("close", () => child?.kill());
      });
    });
    servers.push(api, sockets);
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("LATERDOG_COMPUTERS_API", `http://127.0.0.1:${(api.address() as { port: number }).port}/v1`);
    vi.stubEnv("LATERDOG_COMPUTERS_KEY_FILE", keyFile);
    const { computerEngineOpener } = await import("./engine-opener.ts");
    const opener = computerEngineOpener();

    const read = await readOwnedWorkspaceFile({ dataDir: w.dataDir, botId: "bot-1", cwd: w.cwd, path: "turn-1.txt", relay: () => opener.relay!("bot-1") });
    expect(read).toMatchObject({ source: "computer", matchesManifest: true });
    expect(read.bytes.toString()).toBe("hello");
    expect(calls).toContain(`POST /v1/computers/${computer.id}/wake`);
    expect(calls.indexOf(`POST /v1/computers/${computer.id}/wake`)).toBeLessThan(calls.indexOf("UPGRADE process"));
    expect(computer.state).toBe("running");
  }, 60_000);
});
