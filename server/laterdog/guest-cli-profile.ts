import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, statfs, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { AnyProviderDriver, DriverCreateInput, SendTurnInput } from "../contracts.ts";
import { CustomAcpDriver } from "../drivers/acp/custom.ts";
import { CursorAgentDriver } from "../drivers/acp/cursor.ts";
import { GrokAgentDriver } from "../drivers/acp/grok.ts";
import { GeminiAgentDriver } from "../drivers/acp/gemini.ts";
import { AntigravityDriver } from "../drivers/antigravity.ts";
import { antigravityProfileDirectory } from "../drivers/antigravity-acp.ts";
import { engineCliPackage } from "./engine-placement.ts";
import { guestCliBinary, type GuestDriverRuntime } from "./guest-cli-runtime.ts";
import { guestCliCredentials, type GuestCliCredentials } from "./guest-cli-credentials.ts";
import { guestCliSessions } from "./guest-cli-sessions.ts";
import type { GuestProviderProfile } from "./guest-provider-types.ts";

const descriptors = new Map<string, { driver: AnyProviderDriver; defaultCli: string; profile: string; sessions: string }>([
  ["customAcp", { driver: CustomAcpDriver, defaultCli: "", profile: ".acp", sessions: "sessions" }],
  ["grokAgent", { driver: GrokAgentDriver, defaultCli: "grok", profile: ".grok", sessions: "sessions" }],
  ["cursorAgent", { driver: CursorAgentDriver, defaultCli: "cursor-agent", profile: ".cursor", sessions: "chats" }],
  ["geminiAgent", { driver: GeminiAgentDriver, defaultCli: "gemini", profile: ".gemini", sessions: "tmp" }],
  ["antigravityAgent", { driver: AntigravityDriver, defaultCli: "agy", profile: "antigravity-acp", sessions: "sessions" }],
]);

type PrivateProfile = { sessionPath: string; file?: string };
const INTERNAL_PROFILE = "LATERDOG_GUEST_CLI_PROFILE";
const allowedEnvironment: Record<string, string[]> = {
  cursorAgent: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"], geminiAgent: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};
const accessFile: Record<string, { key: keyof GuestCliCredentials["files"]; name: string }> = {
  grokAgent: { key: "grok", name: "auth.json" }, geminiAgent: { key: "gemini", name: "oauth_creds.json" }, antigravityAgent: { key: "antigravity", name: "acp_token.json" },
};

function runtimeFor(kind: string, command: string, defaultCli: string, path?: string): GuestDriverRuntime {
  if (kind === "customAcp") return { kind: "installed", binary: command };
  if (kind === "geminiAgent") {
    const pkg = engineCliPackage(command, path, "@google/gemini-cli");
    if (pkg) return { kind: "package", ...pkg, binary: "gemini" };
    if (command === "gemini") return { kind: "installed", binary: command };
    throw new Error("The selected Gemini executable could not be matched to its installed package.");
  }
  if (basename(command) !== defaultCli && !(kind === "antigravityAgent" && basename(command) === "agy_acp_server.par")) throw new Error("The selected custom engine executable needs its own computer installation.");
  if (kind === "grokAgent") return { kind: "grok" };
  if (kind === "cursorAgent") return { kind: "cursor" };
  return { kind: "antigravity" };
}

export async function guestCliProfile(driverKind: string, input: DriverCreateInput<unknown>, turn: SendTurnInput): Promise<GuestProviderProfile | null> {
  const descriptor = descriptors.get(driverKind);
  if (!descriptor) return null;
  const config = descriptor.driver.decodeConfig(input.config) as { cli: string; fullAuto: boolean };
  const runtime = runtimeFor(driverKind, config.cli, descriptor.defaultCli, input.environment.PATH ?? process.env.PATH);
  const credentials = await guestCliCredentials(driverKind, input.instanceId, input.environment, Date.now(), driverKind === "grokAgent" ? config.cli : undefined);
  const sessionPath = await guestCliSessions(driverKind, input.instanceId, input.environment, turn);
  const access = accessFile[driverKind];
  const privateProfile: PrivateProfile = { sessionPath, ...(access && credentials.files[access.key] ? { file: credentials.files[access.key] } : {}) };
  const environment = { ...credentials.environment, [INTERNAL_PROFILE]: JSON.stringify(privateProfile) };
  return {
    input: { instanceId: input.instanceId, displayName: input.displayName, enabled: input.enabled, config: { cli: guestCliBinary(runtime), fullAuto: config.fullAuto }, environment },
    runtime, roots: [{ id: "providerSessions", path: sessionPath, writable: true }],
    ...(driverKind === "antigravityAgent" ? { env: { LATERDOG_HOME: "/dev/shm/laterdog-acp-" + randomUUID() } } : {}),
  };
}

export function guestCliDriver(driverKind: string): AnyProviderDriver | null {
  const descriptor = descriptors.get(driverKind);
  if (!descriptor) return null;
  const driver = descriptor.driver;
  return {
    ...driver,
    async create(input) {
      const profile = JSON.parse(input.environment[INTERNAL_PROFILE] ?? "null") as PrivateProfile | null;
      if (!profile || !isAbsolute(profile.sessionPath) || basename(dirname(profile.sessionPath)) !== "guest-cli-sessions" || !/^[a-f0-9]{64}$/.test(basename(profile.sessionPath))) throw new Error("The engine session folder is invalid.");
      if ((await statfs("/dev/shm")).type !== 0x01021994) throw new Error("The computer has no private memory filesystem for the engine account.");
      const home = await mkdtemp("/dev/shm/laterdog-cli-");
      const antigravity = driverKind === "antigravityAgent";
      const privateData = antigravity ? process.env.LATERDOG_HOME : undefined;
      if (antigravity && (!privateData || !/^\/dev\/shm\/laterdog-acp-[\da-f-]{36}$/.test(privateData))) { await rm(home, { recursive: true, force: true }); throw new Error("The Antigravity profile is outside the temporary account folder."); }
      const cleanup = () => {
        rmSync(home, { recursive: true, force: true });
        if (privateData) rmSync(privateData, { recursive: true, force: true });
      };
      process.once("exit", cleanup);
      const dispose = () => { process.off("exit", cleanup); cleanup(); };
      try {
        const directory = privateData ? join(antigravityProfileDirectory(input.instanceId, privateData), descriptor.profile) : join(home, descriptor.profile);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await symlink(profile.sessionPath, join(directory, descriptor.sessions), "dir");
        const access = accessFile[driverKind];
        if (profile.file && access) await writeFile(join(directory, access.name), profile.file, { mode: 0o600, flag: "wx" });
        const nativeHome = driverKind === "customAcp" ? profile.sessionPath : home;
        const environment: Record<string, string> = { HOME: nativeHome, USERPROFILE: nativeHome };
        for (const key of allowedEnvironment[driverKind] ?? []) if (input.environment[key]) environment[key] = input.environment[key]!;
        if (driverKind === "grokAgent") environment.GROK_HOME = directory;
        if (driverKind === "cursorAgent") environment.CURSOR_CONFIG_DIR = directory;
        const native = await driver.create({ ...input, environment });
        return { ...native, get models() { return native.models; }, async dispose() { try { await native.dispose(); } finally { dispose(); } } };
      } catch (error) { dispose(); throw error; }
    },
  };
}
