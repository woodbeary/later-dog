import { createHash } from "node:crypto";

import * as boat from "./boat.ts";
import type { BoatIdentityInspection, ManagedBoatInventory, ManagedBoatInventoryInstance, ManagedBoatMutationClaim, ManagedBoatOwner } from "./boat.ts";
import { DATA_DIR, type AppConfig } from "./config.ts";
import { loadEnvironmentId } from "./environment.ts";
import type { ServiceCredential } from "./included-services.ts";
import {
  COMPUTER_ID, ComputersApiError, ComputersClient, computersConnection, computersKey, computersSelected, ownComputersChosen, trialInUse, type Computer,
} from "./laterdog/cloud-computers.ts";

export { MAX_REMOTE_COMMAND_LENGTH, boatNameMatchesBot, boatTurnLifecycleAction, isolatedRemoteCommand, verifyBoatDeletionCredential, verifyToken } from "./boat.ts";
export type { BoatIdentityInspection, BoatTurnLifecycleAction, ManagedBoatInventory, ManagedBoatInventoryInstance, ManagedBoatMutationClaim, ManagedBoatOwner } from "./boat.ts";

const BOAT_STATE: Record<string, string> = { running: "running", sleeping: "archived", starting: "starting", stopping: "archiving", error: "error" };
const asBoatState = (state: string) => BOAT_STATE[state] ?? "unknown";
const STATE_WORDS: Record<string, string> = { archived: "asleep", archiving: "going to sleep", starting: "starting", error: "in an error state" };
interface OwnComputer { id: string; name: string; state: string }
const own = (computer: Computer): OwnComputer => ({ id: computer.id, name: computer.name, state: asBoatState(computer.state) });
const issuedHere = (id: string | undefined): id is string => typeof id === "string" && COMPUTER_ID.test(id);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PROVISION_BUDGET_MS = 90_000;
const JOIN_BUDGET_MS = 90_000;
const EXEC_BUDGET_MS = 60_000;
export const WAKE_POLL_MS = 400;
const MAX_CREATE_HOPS = 10;
const TRIAL_STOPS = new Set(["trial_used_up", "trial_ended", "trials_off"]);
const QUIESCE_BROWSER = [
  'for name in chrome google-chrome chromium chromium-browser; do pid=$(pgrep -o -x "$name" 2>/dev/null || true); [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true; done',
  'for i in 1 2 3 4 5 6 7 8; do if ! pgrep -x chrome >/dev/null 2>&1 && ! pgrep -x google-chrome >/dev/null 2>&1 && ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then break; fi; sleep 0.25; done',
].join("; ");

let ownerSource: (() => ManagedBoatOwner[]) | null = null;

export function useBoatOwners(source: () => ManagedBoatOwner[]): void {
  ownerSource = source;
}

let installation: { environmentId: string; prefix: string } | null = null;
function scope() {
  if (installation) return installation;
  const environmentId = loadEnvironmentId(DATA_DIR);
  installation = { environmentId, prefix: `dog-${sha256(environmentId).slice(0, 12)}-` };
  return installation;
}
const OWN_NAME = /^dog-[a-f0-9]{12}-[a-z0-9]{1,8}-[a-f0-9]{6}$/;
function ownName(botId: string): string {
  return `${scope().prefix}${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "") || "bot"}-${sha256(botId).slice(0, 6)}`;
}
const createKey = (botId: string, replacing = "") => `ldc-create-${sha256(`${scope().environmentId}\0${botId}\0${replacing}`).slice(0, 40)}`;

function ownClient(): ComputersClient {
  const connection = computersConnection();
  if (!connection) throw Object.assign(new Error("later.dog's own cloud computers are not set up on this installation"), { status: 409 });
  return new ComputersClient(connection);
}

function refusal(error: unknown, prefix = ""): unknown {
  if (!(error instanceof ComputersApiError)) return error;
  return Object.assign(new Error(`${prefix}${error.message}`, { cause: error }), { boatStatus: error.httpStatus || 503, ...(error.code ? { boatCode: error.code } : {}) });
}
function unavailable(error: unknown): unknown {
  if (!(error instanceof ComputersApiError)) return error;
  return Object.assign(new Error(error.message, { cause: error }), { status: error.httpStatus === 401 || error.httpStatus === 403 ? 409 : 503 });
}

const computerIds = new Map<string, string>();
const cacheKey = (client: ComputersClient, botId: string) => `${client.api}\0${botId}`;
const forget = (id: string) => { for (const [key, cached] of computerIds) if (cached === id) computerIds.delete(key); };

async function findOwn(client: ComputersClient, botId: string): Promise<OwnComputer | null> {
  const name = ownName(botId); const key = cacheKey(client, botId);
  const cached = computerIds.get(key);
  if (cached) {
    const direct = await client.get(cached).catch(() => undefined);
    if (direct?.name === name) return own(direct);
    computerIds.delete(key);
  }
  let computers: Computer[];
  try { computers = await client.list(); } catch (error) { throw unavailable(error); }
  const named = computers.filter((computer) => computer.name === name);
  if (named.length > 1) throw Object.assign(new Error("Two cloud computers carry this dog's name — delete the extra one in Settings"), { status: 503 });
  if (!named[0]) return null;
  computerIds.set(key, named[0].id);
  return own(named[0]);
}

async function waitRunning(client: ComputersClient, id: string, budgetMs: number): Promise<OwnComputer | null> {
  const deadline = Date.now() + budgetMs;
  const untilDeadline = () => AbortSignal.timeout(Math.max(1, deadline - Date.now()));
  let woke = false; let failure: unknown = null;
  try {
    while (Date.now() < deadline) {
      let current: Computer | null | undefined;
      try { current = await client.get(id, { signal: untilDeadline() }); }
      catch (error) {
        if (!(error instanceof ComputersApiError)) throw error;
        if (error.httpStatus > 0 && error.httpStatus < 500) throw refusal(error);
        failure = refusal(error);
      }
      if (current === null) return null;
      if (current) {
        const state = asBoatState(current.state);
        if (state === "running") return own(current);
        if (state === "error" && woke) return null;
        if (state === "archived" || state === "error") {
          try {
            const woken = await client.wake(id, { signal: untilDeadline() });
            woke = true; failure = null;
            if (asBoatState(woken.state) === "running") return own(woken);
          } catch (error) {
            if (!(error instanceof ComputersApiError)) throw error;
            if (TRIAL_STOPS.has(error.code ?? "")) throw refusal(error);
            if (error.httpStatus !== 409) {
              if (error.httpStatus > 0 && error.httpStatus < 500) throw refusal(error);
              failure = refusal(error);
            }
          }
        }
      }
      await pause(Math.min(WAKE_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  } catch (error) {
    if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
  }
  if (failure) throw failure;
  return null;
}

async function createOwn(client: ComputersClient, botId: string, name: string): Promise<OwnComputer> {
  let replacing = "";
  let releasedForTrial = false;
  for (let hop = 0; hop < MAX_CREATE_HOPS; hop += 1) {
    let created: Computer;
    try { created = await client.create({ name }, createKey(botId, replacing)); }
    catch (error) {
      if (error instanceof ComputersApiError && error.code === "trial_one_computer" && !releasedForTrial && trialInUse() && !ownComputersChosen()) {
        releasedForTrial = true;
        if (await releaseOrphanedTrialComputers(client) > 0) { hop -= 1; continue; }
      }
      if (error instanceof ComputersApiError && error.httpStatus === 409) {
        await pause(1_000);
        const found = await findOwn(client, botId);
        if (found) return found;
      }
      throw refusal(error);
    }
    let live: Computer | null;
    try {
      live = await client.get(created.id);
      if (live && live.name !== name) live = await client.rename(live.id, name);
    } catch (error) { throw refusal(error); }
    if (live) {
      computerIds.set(cacheKey(client, botId), live.id);
      return own(live);
    }
    replacing = created.id;
  }
  throw new Error("this dog's earlier cloud computers were deleted too recently to create another — retry later");
}

async function desktopUrl(client: ComputersClient, id: string, asleep?: string): Promise<string> {
  try { return (await client.desktop(id)).url; }
  catch (error) {
    if (asleep && error instanceof ComputersApiError && error.httpStatus === 409) throw Object.assign(new Error(asleep), { status: 409 });
    throw refusal(error, "the cloud computer's desktop link could not be created: ");
  }
}

async function runOwn(client: ComputersClient, id: string, command: string, { timeoutMs = 120_000, signal }: { timeoutMs?: number; signal?: AbortSignal } = {}) {
  try {
    const out = await client.exec(id, { command, timeoutMs }, { signal });
    return { ok: out.exitCode === 0, exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr };
  } catch (error) {
    if (error instanceof ComputersApiError && error.httpStatus > 0) return { ok: false, exitCode: null, stdout: "", stderr: error.message };
    throw error;
  }
}

async function stopOwn(client: ComputersClient, computer: OwnComputer): Promise<void> {
  if (computer.state === "archived" || computer.state === "archiving") return;
  if (computer.state === "running") await runOwn(client, computer.id, QUIESCE_BROWSER, { timeoutMs: 5_000 }).catch(() => null);
  try { await client.sleep(computer.id); }
  catch (error) {
    if (!(error instanceof ComputersApiError)) throw error;
    const status = error.httpStatus === 401 || error.httpStatus === 403 ? 409 : error.httpStatus || 503;
    throw Object.assign(new Error(`putting the cloud computer to sleep failed: ${error.message}`, { cause: error }), { status });
  }
}

async function listOwn(owners: ManagedBoatOwner[], client?: ComputersClient): Promise<ManagedBoatInventory> {
  let computers: Computer[];
  try { client ??= ownClient(); computers = await client.list(); }
  catch (error) {
    const rejected = error instanceof ComputersApiError && (error.httpStatus === 401 || error.httpStatus === 403);
    return { configured: true, available: false, problem: error instanceof Error ? error.message : String(error), credentialRejected: rejected, instances: [] };
  }
  const prefix = scope().prefix;
  const ownerByName = new Map(owners.map((owner) => [ownName(owner.botId), owner] as const));
  const seen = new Set<string>(); const instances: ManagedBoatInventoryInstance[] = [];
  for (const computer of computers) {
    if (!OWN_NAME.test(computer.name) || !computer.name.startsWith(prefix)) continue;
    if (seen.has(computer.id)) return { configured: true, available: false, problem: "later.dog's computers service listed one cloud computer twice — refresh and try again", instances: [] };
    seen.add(computer.id);
    const owner = ownerByName.get(computer.name) ?? null;
    instances.push({ boxId: computer.id, name: computer.name, state: asBoatState(computer.state), ownerBotId: owner?.botId ?? null,
      ownerName: owner?.name ?? null, orphaned: owner === null, inUse: owner?.inUse ?? false });
  }
  instances.sort((a, b) => a.orphaned !== b.orphaned ? (a.orphaned ? 1 : -1) : (a.ownerName ?? a.name).localeCompare(b.ownerName ?? b.name));
  return { configured: true, available: true, problem: null, changeable: true, instances };
}

async function releaseOrphanedTrialComputers(client: ComputersClient, owners: ManagedBoatOwner[] = ownerSource?.() ?? []): Promise<number> {
  if (!ownerSource && owners.length === 0) return 0;
  const inventory = await listOwn(owners, client);
  if (!inventory.available) return 0;
  let freed = 0;
  for (const instance of inventory.instances) {
    if (!instance.orphaned || instance.inUse) continue;
    try { await client.remove(instance.boxId); forget(instance.boxId); freed += 1; }
    catch (error) { if (!(error instanceof ComputersApiError)) throw error; }
  }
  return freed;
}

export async function releaseDeletedDogsComputers(_cfg: AppConfig, owners?: ManagedBoatOwner[]): Promise<number> {
  if (!trialInUse() || ownComputersChosen()) return 0;
  let client: ComputersClient;
  try { client = ownClient(); } catch { return 0; }
  return releaseOrphanedTrialComputers(client, owners ?? ownerSource?.() ?? []);
}

async function revalidateOwn(client: ComputersClient, owners: ManagedBoatOwner[], id: string): Promise<ManagedBoatInventoryInstance> {
  const inventory = await listOwn(owners, client);
  if (!inventory.available) throw Object.assign(new Error(inventory.problem ?? "Cloud computer inventory is unavailable"), { status: 503 });
  const instance = inventory.instances.find((candidate) => candidate.boxId === id);
  if (!instance) throw Object.assign(new Error("that later.dog-managed cloud computer no longer exists"), { status: 404 });
  if (instance.inUse) throw Object.assign(new Error("this cloud computer is in use — stop its dog's work first"), { status: 409 });
  return instance;
}

export function boatConfigured(cfg: AppConfig): boolean { return computersSelected() || boat.boatConfigured(cfg); }

export function otherComputersConfigured(cfg: AppConfig): boolean { return ownComputersChosen() || boat.boatConfigured(cfg); }

export function boatAccount(cfg: AppConfig): ServiceCredential | null {
  if (!computersSelected()) return boat.boatAccount(cfg);
  try {
    const connection = computersConnection();
    return connection ? { token: computersKey(connection), api: connection.api, included: false } : null;
  } catch { return null; }
}

export function describeBoatAccount(cfg: AppConfig): { configured: boolean; included?: true; provider?: "laterdog"; trial?: true } {
  if (ownComputersChosen()) return { configured: true, provider: "laterdog" };
  if (trialInUse()) return { configured: true, provider: "laterdog", trial: true };
  return boat.describeBoatAccount(cfg);
}

export async function findBoat(cfg: AppConfig, botId: string) {
  return computersSelected() ? findOwn(ownClient(), botId) : boat.findBoat(cfg, botId);
}

export async function readyBoat(cfg: AppConfig, botId: string, budgetMs = 60_000) {
  if (!computersSelected()) return boat.readyBoat(cfg, botId, budgetMs);
  const client = ownClient();
  const computer = await findOwn(client, botId);
  if (!computer) return null;
  return computer.state === "running" ? computer : waitRunning(client, computer.id, budgetMs);
}

export async function boatStatus(cfg: AppConfig, botId: string) {
  if (!computersSelected()) return boat.boatStatus(cfg, botId);
  const computer = await findOwn(ownClient(), botId);
  return { configured: true, box: computer ? { boxId: computer.id, state: computer.state, desktopAvailable: null } : null };
}

export async function provisionBoat(cfg: AppConfig, botId: string, botName: string) {
  if (!computersSelected()) return boat.provisionBoat(cfg, botId, botName);
  const client = ownClient();
  const machineName = ownName(botId);
  const found = await findOwn(client, botId);
  const computer = found ?? await createOwn(client, botId, machineName);
  const ready = await waitRunning(client, computer.id, PROVISION_BUDGET_MS);
  if (!ready) throw new Error("the cloud computer did not become ready within 90s — retry in a minute");
  return { boxId: ready.id, machineName, reused: found !== null, state: ready.state, joinUrl: await desktopUrl(client, ready.id) };
}

export async function joinBoat(cfg: AppConfig, botId: string) {
  if (!computersSelected()) return boat.joinBoat(cfg, botId);
  const client = ownClient();
  const computer = await findOwn(client, botId);
  if (!computer) throw Object.assign(new Error("no computer yet — provision it first"), { status: 409 });
  const ready = await waitRunning(client, computer.id, JOIN_BUDGET_MS);
  if (!ready) throw new Error("the cloud computer did not wake in time — try again");
  return { joinUrl: await desktopUrl(client, ready.id), state: ready.state };
}

const NOT_READY = "the cloud computer is sleeping or starting — interrupt the dog before waking it";
export async function joinReadyBoat(cfg: AppConfig, botId: string) {
  if (!computersSelected()) return boat.joinReadyBoat(cfg, botId);
  const client = ownClient();
  const computer = await findOwn(client, botId);
  if (!computer) throw Object.assign(new Error("no computer yet — provision it first"), { status: 409 });
  if (computer.state !== "running") throw Object.assign(new Error(NOT_READY), { status: 409 });
  return { joinUrl: await desktopUrl(client, computer.id, NOT_READY), state: computer.state };
}

export async function sleepBoat(cfg: AppConfig, botId: string) {
  if (!computersSelected()) return boat.sleepBoat(cfg, botId);
  const client = ownClient();
  const computer = await findOwn(client, botId);
  if (!computer) throw new Error("no computer for this dog");
  await stopOwn(client, computer);
  return { ok: true };
}

const CHANGE_ONLY_OWN = "Reset and Update work on later.dog cloud computers only";
function changeRefusal(error: unknown): unknown {
  if (!(error instanceof ComputersApiError)) return error;
  const status = error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 401 && error.httpStatus !== 403 ? error.httpStatus : 502;
  return Object.assign(new Error(error.message, { cause: error }), { status, ...(error.code ? { code: error.code } : {}) });
}

async function ownComputerToChange(): Promise<ComputersClient> {
  if (!computersSelected()) throw Object.assign(new Error(CHANGE_ONLY_OWN), { status: 409 });
  return ownClient();
}

export async function resetBoat(_cfg: AppConfig, botId: string): Promise<{ state: string }> {
  const client = await ownComputerToChange();
  const computer = await findOwn(client, botId);
  if (!computer) throw Object.assign(new Error("this dog has no cloud computer yet"), { status: 409 });
  try { return { state: asBoatState((await client.reset(computer.id)).state) }; }
  catch (error) { throw changeRefusal(error); }
}

export async function updateBoat(_cfg: AppConfig, botId: string): Promise<{ state: string }> {
  const client = await ownComputerToChange();
  const computer = await findOwn(client, botId);
  if (!computer) throw Object.assign(new Error("this dog has no cloud computer yet"), { status: 409 });
  const ready = await waitRunning(client, computer.id, PROVISION_BUDGET_MS);
  if (!ready) throw new Error("the cloud computer did not wake in time to update — try again in a minute");
  try { return { state: asBoatState((await client.update(ready.id)).state) }; }
  catch (error) { throw changeRefusal(error); }
}

export async function execOnBoat(cfg: AppConfig, botId: string, command: string) {
  if (!computersSelected()) return boat.execOnBoat(cfg, botId, command);
  if (command.length > boat.MAX_REMOTE_COMMAND_LENGTH) throw new RangeError(`command is too long (maximum ${boat.MAX_REMOTE_COMMAND_LENGTH} characters)`);
  const client = ownClient();
  const computer = await findOwn(client, botId);
  if (!computer) throw new Error("no computer for this dog yet");
  const ready = await waitRunning(client, computer.id, EXEC_BUDGET_MS);
  if (!ready) throw new Error("the cloud computer did not wake");
  const out = await runOwn(client, ready.id, boat.isolatedRemoteCommand(command));
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

export async function runCommand(cfg: AppConfig, boxId: string, command: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}):
  Promise<{ ok: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  return issuedHere(boxId) ? runOwn(ownClient(), boxId, command, options) : boat.runCommand(cfg, boxId, command, options);
}

export async function screenshotBoat(cfg: AppConfig, botId: string, knownBoatId?: string, options?: { signal?: AbortSignal; nativeSize?: boolean }):
  Promise<{ png: string; format: string }> {
  if (!(knownBoatId ? issuedHere(knownBoatId) : computersSelected())) return boat.screenshotBoat(cfg, botId, knownBoatId, options);
  const client = ownClient();
  let id = knownBoatId;
  if (!id) {
    const computer = await findOwn(client, botId);
    if (!computer) throw new Error("no computer for this dog yet");
    if (computer.state !== "running") throw new Error(`the cloud computer is ${STATE_WORDS[computer.state] ?? "not ready"}`);
    id = computer.id;
  }
  return { png: (await client.screenshot(id, { signal: options?.signal })).toString("base64"), format: "jpeg" };
}

export async function listManagedBoats(cfg: AppConfig, owners: ManagedBoatOwner[], options: { adoptLegacy?: boolean } = {}): Promise<ManagedBoatInventory> {
  return computersSelected() ? listOwn(owners) : boat.listManagedBoats(cfg, owners, options);
}

export async function sleepManagedBoat(cfg: AppConfig, owners: ManagedBoatOwner[], boxId: string, claim?: ManagedBoatMutationClaim): Promise<{ ok: boolean }> {
  if (!issuedHere(boxId)) return boat.sleepManagedBoat(cfg, owners, boxId, claim);
  const client = ownClient();
  const instance = await revalidateOwn(client, owners, boxId);
  if (!["running", "archived", "archiving"].includes(instance.state)) {
    throw Object.assign(new Error(`this cloud computer cannot sleep while it is ${instance.state}`), { status: 409 });
  }
  const release = claim?.(instance);
  try {
    await stopOwn(client, { id: instance.boxId, name: instance.name, state: instance.state });
    return { ok: true };
  } finally { release?.(); }
}

export async function deleteManagedBoat(cfg: AppConfig, owners: ManagedBoatOwner[], boxId: string, confirmName: string, claim?: ManagedBoatMutationClaim,
  options: { pollDelaysMs?: readonly number[] } = {}): Promise<{ ok: boolean; pending?: true }> {
  if (!issuedHere(boxId)) return boat.deleteManagedBoat(cfg, owners, boxId, confirmName, claim, options);
  const client = ownClient();
  const instance = await revalidateOwn(client, owners, boxId);
  if (confirmName !== instance.name) throw Object.assign(new Error("cloud computer confirmation no longer matches — refresh and try again"), { status: 409 });
  const release = claim?.(instance);
  try {
    try { await client.remove(instance.boxId); }
    catch (error) {
      if (!(error instanceof ComputersApiError)) throw error;
      if (error.httpStatus === 0) {
        throw Object.assign(new Error("Could not confirm whether later.dog's computers service deleted this computer — retry Delete"), { status: 503, cause: error });
      }
      throw Object.assign(new Error(`deleting the cloud computer failed: ${error.message}`, { cause: error }), { status: error.httpStatus === 401 || error.httpStatus === 403 ? 409 : error.httpStatus });
    }
    forget(instance.boxId);
    return { ok: true };
  } finally { release?.(); }
}

export async function inspectBoatIdentity(cfg: AppConfig, boxId: string): Promise<BoatIdentityInspection> {
  if (!issuedHere(boxId)) return boat.inspectBoatIdentity(cfg, boxId);
  let computer: Computer | null;
  try { computer = await ownClient().get(boxId); }
  catch (error) { return { available: false, identity: null, problem: error instanceof Error ? error.message : String(error) }; }
  return { available: true, identity: computer ? { boxId: computer.id, name: computer.name, state: asBoatState(computer.state) } : null, problem: null };
}
