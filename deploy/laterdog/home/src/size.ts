import { homeIdentity, validAccountId, type HomeIdentity } from "./identity.ts";

export type HomeSize = "standard" | "large";
export type HomeLane = HomeSize | "candidate";

export interface SizingEnv {
  HOME_SECRET: string;
  HOME_HOST_SUFFIX: string;
  LARGE_HOME_ACCOUNTS?: string;
  CANDIDATE_HOME_ACCOUNTS?: string;
}

export interface HomeNamespaces<Namespace> {
  HOMES: Namespace;
  HOMES_LARGE: Namespace;
  HOMES_CANDIDATE?: Namespace;
}

const largeHomesByConfig = new Map<string, Promise<ReadonlyMap<string, HomeIdentity>>>();

export function largeHomeAccounts(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((part) => part.trim()).filter(validAccountId))];
}

function listedHomes(env: SizingEnv, value: string | undefined): Promise<ReadonlyMap<string, HomeIdentity>> {
  const accounts = largeHomeAccounts(value);
  const config = [env.HOME_SECRET, env.HOME_HOST_SUFFIX, ...accounts].join("\n");
  const known = largeHomesByConfig.get(config);
  if (known) return known;
  const computed = Promise.all(accounts.map((accountId) => homeIdentity(env.HOME_SECRET, accountId, env.HOME_HOST_SUFFIX)))
    .then((identities) => new Map(identities.map((identity) => [identity.machineId, identity])));
  largeHomesByConfig.set(config, computed);
  computed.catch(() => largeHomesByConfig.delete(config));
  return computed;
}

export function largeHomes(env: SizingEnv): Promise<ReadonlyMap<string, HomeIdentity>> {
  return listedHomes(env, env.LARGE_HOME_ACCOUNTS);
}

export function candidateHomes(env: SizingEnv): Promise<ReadonlyMap<string, HomeIdentity>> {
  return listedHomes(env, env.CANDIDATE_HOME_ACCOUNTS);
}

export async function homeLane(env: SizingEnv, machineId: string): Promise<HomeLane> {
  return (await candidateHomes(env)).has(machineId) ? "candidate" : homeSize(env, machineId);
}

export async function homeSize(env: SizingEnv, machineId: string): Promise<HomeSize> {
  return (await largeHomes(env)).has(machineId) ? "large" : "standard";
}

export function otherSize(size: HomeSize): HomeSize {
  return size === "large" ? "standard" : "large";
}

export function homeNamespace<Namespace>(env: HomeNamespaces<Namespace>, lane: HomeLane): Namespace {
  if (lane === "candidate") {
    if (!env.HOMES_CANDIDATE) throw new Error("The candidate home is not configured.");
    return env.HOMES_CANDIDATE;
  }
  return lane === "large" ? env.HOMES_LARGE : env.HOMES;
}

export function homeLanes(env: HomeNamespaces<unknown>): HomeLane[] {
  return env.HOMES_CANDIDATE ? ["standard", "large", "candidate"] : ["standard", "large"];
}
