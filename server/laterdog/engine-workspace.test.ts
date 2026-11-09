import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactBudget, acceptManifest, beginOwnership, computerOwnsWork, ownedWorkspace, pointerPaths, readPointer, savePointer, workspaceKey } from "./engine-pointer.ts";
import { planClaudeRemote, remoteEngineChoice, setRemoteEngineBot, workspacePlacement, type ClaudePlacement } from "./engine-placement.ts";
import { pickArtifacts, workspaceManifest, type WorkspaceCaps, WORKSPACE_CAPS } from "./engine-workspace.ts";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const temp = (prefix: string) => { const dir = realpathSync(mkdtempSync(`/tmp/${prefix}`)); scratch.push(dir); return dir; };
const caps = (overrides: Partial<WorkspaceCaps>): WorkspaceCaps => ({ ...WORKSPACE_CAPS, ...overrides });
const HASH = "c".repeat(64);

describe("the bounded workspace manifest", () => {
  it("lists paths, sizes and hashes, skips rebuildable folders, and stops at its file cap while still counting everything", () => {
    const root = temp("ldman-");
    for (let index = 0; index < 5; index++) writeFileSync(join(root, `f${index}.txt`), "x".repeat(index + 1));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules", "big"), "y".repeat(1000));
    const manifest = workspaceManifest(root, caps({ manifestFiles: 3 }), [], 42);
    expect(manifest.at).toBe(42);
    expect(manifest.files.map((file) => file.path)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
    expect(manifest.files[0]).toMatchObject({ size: 1, hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(manifest).toMatchObject({ totalFiles: 5, totalBytes: 15, truncated: true });
  });

  it("stops at its byte cap", () => {
    const root = temp("ldman-");
    for (const name of ["a", "b", "c"]) writeFileSync(join(root, name), name);
    const manifest = workspaceManifest(root, caps({ manifestBytes: 2 * 97 }));
    expect(manifest.files).toHaveLength(2);
    expect(manifest.truncated).toBe(true);
  });

  it("reuses a known hash when size and time are unchanged", () => {
    const root = temp("ldman-");
    writeFileSync(join(root, "same.txt"), "same");
    const first = workspaceManifest(root);
    const reused = workspaceManifest(root, WORKSPACE_CAPS, [{ ...first.files[0]!, hash: HASH }]);
    expect(reused.files[0]!.hash).toBe(HASH);
  });

  it("is re-capped and validated when it reaches the home", () => {
    const files = Array.from({ length: 10 }, (_, index) => ({ path: `dir/f${index}`, size: 1, hash: HASH, mtimeMs: index }));
    const accepted = acceptManifest({ at: 5, files, totalFiles: 10, totalBytes: 10, truncated: false, git: { head: "a".repeat(40), branch: "main", patchHash: HASH, patchBytes: 3 } }, caps({ manifestFiles: 4 }));
    expect(accepted.files).toHaveLength(4);
    expect(accepted).toMatchObject({ truncated: true, totalFiles: 10, git: { head: "a".repeat(40), branch: "main", patchHash: HASH, patchBytes: 3, patchTooLarge: false } });
    for (const path of ["../escape", "/etc/passwd", "a//b", "a/./b"]) {
      expect(() => acceptManifest({ at: 1, files: [{ path, size: 1, hash: HASH }] })).toThrow(/invalid entry/);
    }
    expect(() => acceptManifest({ at: 1, files: [{ path: "a", size: 1, hash: "short" }] })).toThrow(/invalid entry/);
    expect(() => acceptManifest({ files: [] })).toThrow(/no time/);
  });
});

describe("the capped artifacts", () => {
  const entry = (path: string, size: number, mtimeMs: number) => ({ path, size, hash: HASH, mtimeMs });

  it("keeps the newest small files under the per-file, count and total caps, after the git patch", () => {
    const manifest = { files: [entry("old.txt", 10, 1), entry("new.txt", 10, 9), entry("huge.bin", 500, 8), entry("mid.txt", 10, 5), entry("last.txt", 10, 4)] };
    const limits = caps({ artifactFileBytes: 100, artifactTotalBytes: 35, artifactFiles: 10 });
    expect(pickArtifacts(manifest, limits).map((artifact) => artifact.path)).toEqual(["new.txt", "mid.txt", "last.txt"]);
    expect(pickArtifacts(manifest, limits, 20).map((artifact) => artifact.path)).toEqual(["new.txt"]);
    expect(pickArtifacts(manifest, { ...limits, artifactFiles: 2 }).map((artifact) => artifact.path)).toEqual(["new.txt", "mid.txt"]);
  });

  it("is enforced again on the home as files arrive", () => {
    const budget = new ArtifactBudget(caps({ artifactFileBytes: 10, artifactTotalBytes: 25, artifactFiles: 3 }), [{ path: "a", size: 10 }]);
    expect(budget.admit("big", 11)).toMatch(/file cap/);
    expect(budget.admit("b", 10)).toBeNull();
    expect(budget.admit("c", 10)).toMatch(/total cap/);
    expect(budget.admit("a", 5)).toBeNull();
    expect(budget.admit("c", 10)).toBeNull();
    expect(budget.admit("d", 1)).toMatch(/file cap/);
    budget.removed("c");
    expect(budget.admit("d", 1)).toBeNull();
    expect(budget.total).toBe(16);
  });
});

function placement(overrides: Partial<ClaudePlacement> = {}) {
  const base = temp("ldown-");
  const cwd = join(base, "work"); const config = join(base, "config");
  const pkg = join(base, "lib", "node_modules", "@anthropic-ai", "claude-code");
  for (const dir of [cwd, config, join(pkg, "bin")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.316" }));
  writeFileSync(join(pkg, "bin", "claude"), "");
  writeFileSync(join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "a", expiresAt: Date.now() + 3600_000 } }));
  const input: ClaudePlacement = { botId: "bot-1", threadId: "thread", sessionId: "s", cliCommand: join(pkg, "bin", "claude"), args: ["-p"], cwd,
    env: { HOME: base, CLAUDE_CONFIG_DIR: config, PATH: "/usr/bin" }, managed: false, dataDir: join(base, "data"), proxyPath: "/x/engine-proxy.js", ...overrides };
  return { base, cwd, input };
}

describe("the per-dog workspace option", () => {
  it("leaves the default plan exactly as before: the home keeps the workspace and nothing is held", () => {
    const { input } = placement();
    const before = planClaudeRemote(input);
    if (!("plan" in before)) throw new Error(before.stay);
    expect(before.plan.launch.outputIds).toEqual(["workspace", "session", "session-extra", "file-history"]);
    expect(before.plan.launch).not.toHaveProperty("ownership");
    const owned = planClaudeRemote({ ...input, workspaceOnComputer: true });
    if (!("plan" in owned)) throw new Error(owned.stay);
    expect(owned.plan.launch.outputIds).toEqual(["session", "session-extra", "file-history"]);
    expect(owned.plan.launch.ownership).toMatchObject({ root: "workspace", key: workspaceKey("bot-1", input.cwd), homeFallback: true });
    expect(owned.plan.launch.roots.map((root) => root.id)).toEqual(before.plan.launch.roots.map((root) => root.id));
    expect(existsPointer(input.dataDir)).toBe(false);
  });

  it("is saved per dog beside the placement and only matters while the engine is placed", () => {
    const data = temp("ldopt-");
    expect(remoteEngineChoice(data, "bot-1", {})).toEqual({ botId: "bot-1", computer: false, fromEnvironment: false, workspaceOnComputer: false, heldWorkspaces: 0 });
    setRemoteEngineBot(data, "bot-1", true, {});
    expect(remoteEngineChoice(data, "bot-1", {}).workspaceOnComputer).toBe(false);
    expect(workspacePlacement(data, "bot-1", "/w", { placed: true, trial: false })).toEqual({ owned: false, required: false });
    setRemoteEngineBot(data, "bot-1", { computer: true, workspaceOnComputer: true }, {});
    expect(JSON.parse(readFileSync(join(data, "remote-engines.json"), "utf8"))).toEqual({ bots: ["bot-1"], workspaceOnComputer: ["bot-1"] });
    expect(workspacePlacement(data, "bot-1", "/w", { placed: true, trial: false })).toEqual({ owned: true, required: false });
    expect(workspacePlacement(data, "bot-1", "/w", { placed: false, trial: false })).toEqual({ owned: false, required: false });
    expect(workspacePlacement(data, "bot-1", "/w", { placed: true, trial: true })).toMatchObject({ owned: false, why: expect.stringMatching(/trial/) });
    expect(workspacePlacement(data, "bot-2", "/w", { placed: true, trial: false })).toEqual({ owned: false, required: false });
    setRemoteEngineBot(data, "bot-1", true, {});
    expect(remoteEngineChoice(data, "bot-1", {}).workspaceOnComputer).toBe(true);
  });

  it("keeps a workspace the computer owns on the computer even after the option is switched off, and refuses the home fallback", () => {
    const { input } = placement();
    const pointer = beginOwnership(input.dataDir, "bot-1", input.cwd, 1);
    expect(computerOwnsWork(pointer)).toBe(false);
    expect(workspacePlacement(input.dataDir, "bot-1", input.cwd, { placed: false, trial: true })).toEqual({ owned: false, required: false });
    savePointer(input.dataDir, { ...pointer, seeded: true });
    expect(workspacePlacement(input.dataDir, "bot-1", input.cwd, { placed: false, trial: true })).toEqual({ owned: true, required: true });
    expect(remoteEngineChoice(input.dataDir, "bot-1", {}).heldWorkspaces).toBe(1);
    expect(ownedWorkspace({ dataDir: input.dataDir, botId: "bot-1", cwd: input.cwd, remoteBase: "/rb" }).homeFallback).toBe(false);
    savePointer(input.dataDir, { ...readPointer(input.dataDir, "bot-1", input.cwd)!, state: "home" });
    expect(workspacePlacement(input.dataDir, "bot-1", input.cwd, { placed: false, trial: false })).toEqual({ owned: false, required: false });
  });

  it("keys a pointer by dog and folder, inside the home's data folder", () => {
    const paths = pointerPaths("/data", "bot-1", "/w/./x");
    expect(paths.key).toBe(workspaceKey("bot-1", "/w/x"));
    expect(paths.dir).toBe(`/data/engine-workspaces/bot-1/${paths.key}`);
    expect(() => pointerPaths("/data", "../bot", "/w")).toThrow(/Invalid dog id/);
  });
});

function existsPointer(dataDir: string): boolean {
  try { return readdirSync(join(dataDir, "engine-workspaces")).length > 0; } catch { return false; }
}

describe("Codex dogs", () => {
  it("never reach engine or workspace placement", () => {
    const drivers = fileURLToPath(new URL("../drivers/", import.meta.url));
    const codex = readdirSync(drivers).filter((name) => /^codex.*\.ts$/.test(name) && !name.endsWith(".test.ts"));
    expect(codex).toContain("codex.ts");
    for (const name of codex) {
      const source = readFileSync(join(drivers, name), "utf8");
      expect(source).not.toMatch(/engine-placement|engine-pointer|engine-workspace|workspaceOnComputer|planClaudeRemote/);
    }
  });
});
