import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, sep } from "node:path";
import type { McpServerSpec, SendTurnInput, StdioMcpSpec } from "../contracts.ts";
import { mcpStdioServer } from "../mcp-gate-config.ts";
import type { GuestProviderProfile } from "./guest-provider-types.ts";
import { REMOTE_ENGINE_BASE, type EngineOpener, type PlacedEnginePlan } from "./engine-placement.ts";
import type { StdioSpec } from "./engine-remote.ts";

function guestIntegrations(turn: SendTurnInput, proxy: string, socket: string) {
  const source = turn.integrations ?? {};
  const mcp: Record<string, StdioSpec> = Object.create(null);
  const integrations: NonNullable<SendTurnInput["integrations"]> = {};
  const pipe = (name: string, original: McpServerSpec): StdioMcpSpec => {
    const spec = mcpStdioServer(original);
    if (!spec) throw new Error("The computer could not carry the selected tool connection.");
    mcp[name] = { command: spec.command, args: spec.args ?? [], env: spec.env };
    return { command: "node", args: [proxy, "mcp", socket, name], env: {} };
  };
  for (const key of ["agents", "composio", "browser"] as const) {
    if (source[key]) integrations[key] = pipe(key, source[key]);
  }
  if (source.localComputer) {
    const { platform, scope, generation } = source.localComputer;
    integrations.localComputer = { ...pipe("localComputer", source.localComputer), platform, scope, generation };
  }
  if (source.custom) integrations.custom = Object.fromEntries(Object.entries(source.custom).map(([name, original], i) => [name, pipe("custom-" + i, original)]));
  if (source.hooks) throw new Error("This engine requires a hook connection that cannot be carried to the dog's computer.");
  return { integrations, mcp };
}

export function guestProviderPlan(dataDir: string, driver: string, profile: GuestProviderProfile, turn: SendTurnInput, opener: EngineOpener) {
  if (!turn.botId || !/^[\w-]{1,128}$/.test(turn.botId)) throw new Error("The engine needs a dog to select its computer.");
  const programs = opener.guestProvider;
  if (!programs) throw new Error("The dog's computer is missing its provider runtime.");
  const base = opener.remoteBase ?? REMOTE_ENGINE_BASE;
  const threadKey = createHash("sha256").update([driver, profile.input.instanceId, turn.botId, turn.threadId].join("\0")).digest("hex").slice(0, 32);
  const socketPath = join(base, "run", randomUUID() + ".sock");
  const { integrations, mcp } = guestIntegrations(turn, programs.proxy, socketPath);
  const parent = join(dataDir, "engine-launch");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stagingDir = mkdtempSync(join(parent, "provider-"));
  try {
    const cwd = turn.cwd ? realpathSync(turn.cwd) : stagingDir;
    const root = realpathSync(dataDir);
    if (cwd === parse(cwd).root || cwd === homedir() || root === cwd || root.startsWith(cwd + sep)) throw new Error("The selected working folder cannot be mirrored safely.");
    if (turn.cwd && cwd.startsWith(root + sep) && !["workspaces", "task-workspaces"].some(dir => {
      const owned = join(root, dir, turn.botId!);
      return cwd === owned || cwd.startsWith(owned + sep);
    })) throw new Error("The selected folder is outside this dog's workspaces.");
    const roots = [...(profile.roots ?? [])];
    if (turn.cwd) roots.push({ id: "workspace", path: cwd, writable: true, streamedTree: true });
    const images = turn.images?.map((image, i) => {
      const path = join(stagingDir, "attachment-" + i + "." + image.mime.split("/")[1]);
      copyFileSync(image.path, path);
      return { ...image, path };
    });
    roots.push({ id: "launch", path: stagingDir, writable: false });
    const plan: PlacedEnginePlan = {
      threadId: turn.threadId, stagingDir, cli: { name: "node", version: process.versions.node },
      guestRuntime: profile.runtime ? { kind: "acp", cli: profile.runtime } : { kind: "node" },
      mkdirs: [...new Set([...roots.map(root => root.path), ...(profile.mkdirs ?? [])])],
      launch: {
        cli: "node", args: [programs.entry], cwd, roots, outputIds: roots.filter(root => root.writable).map(root => root.id),
        env: { HOME: "/home/dog", PATH: "/home/dog/.local/bin:/usr/local/bin:/usr/bin:/bin", LATERDOG_HOME: join(base, "providers", threadKey), ...profile.env },
        mcp, hooks: [], hookEnv: {}, proxyEnv: { PATH: process.env.PATH ?? "", HOME: homedir() },
        socketPath, stateFile: join(base, "state", threadKey + ".json"), lockFile: join(base, "locks", threadKey + ".lock"),
        acknowledgedInput: true, requireCompleteCheckpoint: roots.some(root => root.writable),
      },
    };
    return { plan, turn: { ...turn, cwd, images, integrations, mcpFromUserConfig: false } };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}
