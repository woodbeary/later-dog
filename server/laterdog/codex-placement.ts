import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { codexHome } from "../drivers/codex-identity.ts";
import type { McpServerSpec, TurnImageInput } from "../contracts.ts";
import { mcpStdioServer } from "../mcp-gate-config.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { ChangedCodexCheckpoint, codexCheckpoint } from "./codex-checkpoint.ts";
import { codexExternalAccount } from "./codex-external-auth.ts";
import { validatedCodexRollout } from "./codex-rollout.ts";
import { botFolderRoot, engineCliPackage, REMOTE_ENGINE_BASE, type EngineOpener, type PlacedEnginePlan } from "./engine-placement.ts";
import type { StdioSpec } from "./engine-remote.ts";

const quoted = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

export function codexComputerWorkspace(dataDir: string, bot: string, thread: string, cwd: string): boolean {
  if (![bot, thread].every(value => /^[\w-]{1,128}$/.test(value))) return false;
  const data = resolve(dataDir);
  const folder = resolve(cwd);
  const owned = [join(data, "workspaces", bot), join(data, "task-workspaces", bot, thread)].some(root => {
    const rel = relative(root, folder);
    return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
  });
  if (!owned) return false;
  try { return realpathSync(folder) === join(realpathSync(data), relative(data, folder)); }
  catch { return false; }
}

export interface CodexPlacement {
  dataDir: string; botId: string; threadId: string; instanceId: string; cli: string; cwd: string;
  env: NodeJS.ProcessEnv; cursor?: string; opener: EngineOpener; guardShell: boolean;
  required?: boolean; images?: TurnImageInput[];
  refresh(): Promise<unknown>;
}

export async function planCodexRemote(input: CodexPlacement) {
  const home = codexHome(input.env);
  if (!home) return { stay: "no selected account directory" } as const;
  const readAuth = () => JSON.parse(readFileSync(join(home, "auth.json"), "utf8"));
  let accountId: string;
  try { accountId = readAuth().tokens.account_id; } catch { return { stay: "no native Codex sign-in to lend" } as const; }
  if (typeof accountId !== "string" || !accountId) return { stay: "no selected native account" } as const;
  const binding = codexCheckpoint(input.dataDir, home, input.botId, input.threadId, input.instanceId, accountId);
  let bound: Awaited<ReturnType<typeof binding.lookup>> = null;
  if (input.cursor && !input.required) {
    try { bound = await binding.lookup(input.cursor); }
    catch (error) { if (!(error instanceof ChangedCodexCheckpoint) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!bound) return { stay: "saving the current native session on the home before moving it", binding } as const;
  }
  const cli = engineCliPackage(input.cli, input.env.PATH, "@openai/codex");
  if (!cli) return { stay: "the selected Codex CLI package could not be identified" } as const;
  const cwd = resolve(input.cwd);
  if (!codexComputerWorkspace(input.dataDir, input.botId, input.threadId, cwd)) return { stay: "this working folder is outside the dog's cloud workspace" } as const;
  if (input.cursor && input.required) bound = await binding.bindSaved(input.cursor, cwd);
  const run = randomUUID();
  const remoteBase = input.opener.remoteBase ?? REMOTE_ENGINE_BASE;
  const stagingDir = join(input.dataDir, "engine-launch", run);
  const sessions = join(stagingDir, "sessions");
  const socketPath = `${remoteBase}/run/${run}.sock`;
  const bin = `${remoteBase}/cli/codex-${cli.version}/node_modules/.bin`;
  const proxyEnv = Object.fromEntries(Object.entries(input.env).filter((e): e is [string, string] =>
    ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TZ"].includes(e[0]) && typeof e[1] === "string"));
  const hookEnv = { ...proxyEnv, LATERDOG_HOOK_URL: input.env.LATERDOG_HOOK_URL ?? "", LATERDOG_HOOK_TOKEN_FILE: input.env.LATERDOG_HOOK_TOKEN_FILE ?? "", LATERDOG_REQUIRE_HOOK_REPLY: "1" };
  const mcp: Record<string, StdioSpec> = Object.create(null);
  const plan: PlacedEnginePlan = {
    cli, threadId: input.threadId, stagingDir, mkdirs: [cwd, sessions],
    launch: {
      cli: `${bin}/codex`, args: [], cwd, env: { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: "/home/dog", CODEX_HOME: stagingDir },
      roots: [{ id: "workspace", path: cwd, writable: true }, { id: "config", path: stagingDir, writable: false, files: ["config.toml"] }, { id: "sessions", path: sessions, writable: true, transcript: true, files: bound ? [bound.path] : [] }],
      outputIds: ["workspace", "sessions"], requireCompleteCheckpoint: true, ephemeralCodexHome: stagingDir, mcp, hookEnv, proxyEnv,
      hooks: input.guardShell ? [`${quoted(process.execPath)} ${quoted(SPAWNED_PROXIES.hook)}`] : [],
      socketPath, stateFile: `${remoteBase}/state/${binding.key}.json`, lockFile: `${remoteBase}/locks/${binding.key}.lock`,
    },
  };
  const botRoot = botFolderRoot(input.dataDir, input.botId, cwd, home, stagingDir);
  if (botRoot) {
    plan.launch.roots.push(botRoot);
    plan.mkdirs.push(botRoot.path);
  }
  const imagePaths: string[] = [];
  try {
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    writeFileSync(join(stagingDir, "config.toml"), 'cli_auth_credentials_store = "ephemeral"\n', { mode: 0o600 });
    if (input.images?.length) {
      const root = { id: "images", path: join(stagingDir, "images"), writable: false, readOnly: true, files: [] as string[] };
      mkdirSync(root.path, { mode: 0o700 });
      for (const [index, image] of input.images.entries()) {
        const extension = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/gif": "gif" }[image.mime];
        const source = lstatSync(image.path);
        if (!extension || !source.isFile() || source.size !== image.bytes) throw new Error("The selected image attachment has changed.");
        const name = `${index}.${extension}`;
        const path = join(root.path, name);
        await copyFile(image.path, path);
        root.files.push(name);
        imagePaths.push(path);
      }
      plan.launch.roots.push(root);
      plan.mkdirs.push(root.path);
    }
    if (bound && input.cursor) await binding.stage(input.cursor, sessions, bound);
  } catch (error) { rmSync(stagingDir, { recursive: true, force: true }); throw error; }
  let selectedPath: string | undefined;
  return {
    plan, binding, imagePaths,
    selectedRollout(cursor: string, nativePath: string) {
      const name = validatedCodexRollout(relative(sessions, nativePath), cursor);
      if (nativePath !== join(sessions, name)) throw new Error("The native Codex checkpoint path is not canonical.");
      if (bound && (cursor !== input.cursor || name !== bound.path)) throw new Error("The resumed native Codex thread did not match its selected checkpoint.");
      selectedPath = name;
      return { name, needsSelection: !bound };
    },
    account: codexExternalAccount(accountId, { read: async () => readAuth(), refresh: async () => { await input.refresh(); return readAuth(); } }),
    proxy(name: string, server: McpServerSpec): McpServerSpec {
      const spec = mcpStdioServer(server, { sourceEnv: input.env });
      if (!spec) throw new Error("The selected Codex tool could not be mounted through the home.");
      mcp[name] = spec;
      return { command: "node", args: [input.opener.proxyPath, "mcp", socketPath, name], env: {} };
    },
    publish(cursor: string, nativePath: string, turnId: string) {
      const name = relative(sessions, nativePath);
      if (!existsSync(sessions)) throw new Error("The Codex session did not reach the home.");
      if (name !== selectedPath) throw new Error("The native Codex thread changed its selected checkpoint.");
      return binding.publish(cursor, sessions, name, bound, turnId);
    },
  } as const;
}
