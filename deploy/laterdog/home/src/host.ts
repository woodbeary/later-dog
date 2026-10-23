import { Container, type OutboundHandlerContext } from "@cloudflare/containers";
import { parseActivity, signedActivityRequest, sleepDecision, type HomeActivity } from "./activity.ts";
import { grantedAsHome, includedKeyDue } from "./included.ts";
import { hex, randomToken, sha256 } from "./encoding.ts";
import { bootstrapSecret, type HomeIdentity } from "./identity.ts";
import { parsePairingGrant, signedPairingRequest, type PairingGrant } from "./pairing.ts";
import { handleOwnerEmail, type OwnerMail } from "./email.ts";
import { Handover, type HandoverPeer, type HomeStanding } from "./handover.ts";
import { homeNamespace, otherSize, type HomeSize } from "./size.ts";
import { authorizedState, EMAIL_HOST, forgetHomeState, handleState, STATE_HOST, stateOwner } from "./state.ts";
import { devCodeOn, handleDevCode } from "./dev-code.ts";
import { isBackground, startFailure, wakeResponse, type HomeWake } from "./waking.ts";
import {
  hookAccepted,
  remember,
  remembered,
  seenLongAgo,
  sessionCheck,
  sessionCheckOutcome,
  wakeCredential,
  wakeGuard,
  wakerKey,
  type WakeCredential,
  type Wakers,
} from "./wake-guard.ts";

export const HOME_PORT = 8080;
const RECORD_KEY = "home";
const SLOW_SETUP_MS = 3 * 60_000;
export const BOOT_PORT_TIMEOUT_MS = 3 * 60_000;
export const PAIR_WAKE_WAIT_MS = 15_000;
const BUSY_MEMORY_MS = 10_000;
const STARTED_KEY = "started-included-key";
const STANDING_KEY = "standing";
const REMOVED_KEY = "removed";
const REMOVED = "This home was removed.";
const WAKERS_KEY = "wakers";
const PAIRING_OPEN_KEY = "pairing-open-until";
const REFUSED_KEPT = 256;
const CHECKS_AT_ONCE = 4;
export const PERSON_SLEEP_AFTER = "30m";
export const ROUTINE_SLEEP_AFTER = "15m";
export const MAINTAIN_EVERY_S = 6 * 60 * 60;

export type HomeState = "setting_up" | "ready" | "failed";
export type SetupStep = "reserving" | "storage" | "starting" | "checking";

export interface HomeSummary {
  state: HomeState;
  origin: string;
  setup?: { step: SetupStep; slow?: true };
}

export interface HomeRecord extends HomeIdentity {
  createdAt: number;
  stateToken: string;
  emailToken?: string;
  includedKey?: string;
  includedAt?: number;
  includedHome?: true;
  readyAt?: number;
}

export type PairOutcome =
  | ({ ok: true; origin: string } & PairingGrant)
  | { ok: false; summary: HomeSummary | null; status?: number };

type MachineState = "stopped" | "starting" | "serving";

export class CloudHomeHost extends Container<Env> {
  defaultPort = HOME_PORT;
  sleepAfter = PERSON_SLEEP_AFTER;
  enableInternet = true;
  readonly size: HomeSize = "standard";
  private record: HomeRecord | null = null;
  private booting: Promise<void> | null = null;
  private lastStart: { wake: HomeWake; at: number } | null = null;
  private storedStanding: HomeStanding | null = null;
  private signalled = false;
  private serverUp = false;
  private removed = false;
  private wakers: Wakers = {};
  private pairingOpenUntil = 0;
  private readonly checking = new Set<string>();
  private readonly refused = new Set<string>();
  private readonly handover = new Handover({
    standing: () => this.storedStanding ?? (this.size === "standard" ? "holding" : "released"),
    stand: async (standing) => {
      this.storedStanding = standing;
      await this.ctx.storage.put(STANDING_KEY, standing);
    },
    running: () => this.ctx.container?.running === true,
    quiet: () => this.quiet(),
    sibling: () => this.sibling(),
  });

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    this.serverUp = false;
    console.error(`laterdog home ${this.record?.machineId ?? "unknown"}: stopped (${reason}, exit ${exitCode})`);
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.record = (await ctx.storage.get<HomeRecord>(RECORD_KEY)) ?? null;
      this.storedStanding = (await ctx.storage.get<HomeStanding>(STANDING_KEY)) ?? null;
      this.removed = (await ctx.storage.get<boolean>(REMOVED_KEY)) === true;
      this.wakers = (await ctx.storage.get<Wakers>(WAKERS_KEY)) ?? {};
      this.pairingOpenUntil = (await ctx.storage.get<number>(PAIRING_OPEN_KEY)) ?? 0;
      if (this.record) this.envVars = await this.environment(this.record);
    });
  }

  private stateHome(machineId: string): string {
    return this.env.HOMES.idFromName(machineId).toString();
  }

  private sibling(): HandoverPeer {
    const record = this.record;
    if (!record) throw new Error("This home has no owner yet.");
    const namespace = homeNamespace(this.env, otherSize(this.size));
    return namespace.get(namespace.idFromName(record.machineId));
  }

  async release(): Promise<boolean> {
    return this.handover.release();
  }

  async standing(): Promise<HomeStanding> {
    return this.handover.holds() ? "holding" : "released";
  }

  private async quiet(): Promise<void> {
    this.deleteSchedules("maintain");
    this.deleteSchedules("wakeForRoutine");
    if (!this.ctx.container?.running || this.signalled) return;
    this.signalled = true;
    await this.stop();
  }

  override startAndWaitForPorts(...args: Parameters<Container<Env>["startAndWaitForPorts"]>): Promise<void> {
    if (this.removed) return Promise.reject(new Error(REMOVED));
    return this.handover.launch(() => super.startAndWaitForPorts(...args));
  }

  private async environment(record: HomeRecord): Promise<Record<string, string>> {
    return {
      LATERDOG_CLOUD_ROLE: "home",
      LATERDOG_CLOUD_MACHINE_ID: record.machineId,
      LATERDOG_CLOUD_ADMIN_URL: this.env.ADMIN_ORIGIN,
      LATERDOG_CLOUD_BOOTSTRAP_SECRET: await bootstrapSecret(this.env.HOME_SECRET, record.machineId),
      LATERDOG_PUBLIC_URL: record.origin,
      LATERDOG_STATE_URL: `http://${STATE_HOST}`,
      LATERDOG_STATE_TOKEN: record.stateToken,
      ...(record.emailToken ? { LATERDOG_CLOUD_EMAIL_URL: `http://${EMAIL_HOST}/send`, LATERDOG_CLOUD_EMAIL_TOKEN: record.emailToken } : {}),
      ...(record.includedKey ? { LATERDOG_INCLUDED_KEY: record.includedKey, LATERDOG_INCLUDED_API: this.env.INCLUDED_API } : {}),
      ...(devCodeOn(this.env.DEV_CODE) ? { LATERDOG_DEV_CODE: "1" } : {}),
    };
  }

  async bury(): Promise<void> {
    this.removed = true;
    await this.ctx.storage.put(REMOVED_KEY, true);
  }

  async reopen(): Promise<void> {
    this.removed = false;
    await this.ctx.storage.delete(REMOVED_KEY);
  }

  async adopt(identity: HomeIdentity): Promise<void> {
    if (this.removed) return;
    if (this.record) {
      if (this.record.machineId !== identity.machineId || this.record.accountId !== identity.accountId) throw new Error("This home belongs to another account.");
      return;
    }
    const record: HomeRecord = { ...identity, createdAt: Date.now(), stateToken: randomToken(32), emailToken: randomToken(32) };
    await this.setOutboundByHost(STATE_HOST, "state", { token: record.stateToken, home: this.stateHome(identity.machineId) });
    await this.setOutboundByHost(EMAIL_HOST, "email", { token: record.emailToken, accountId: record.accountId });
    await this.ctx.storage.put(RECORD_KEY, record);
    this.record = record;
    this.envVars = await this.environment(record);
    await this.grantIncluded(record);
    await this.armMaintenance();
  }

  async maintain(): Promise<void> {
    const known = this.record;
    if (!known) return;
    if (!this.handover.holds()) {
      this.deleteSchedules("maintain");
      return;
    }
    await this.armMaintenance();
    const record = await this.grantIncluded(known);
    if (!this.ctx.container?.running) return;
    if ((await this.ctx.storage.get<string>(STARTED_KEY)) === (record.includedKey ?? "")) return;
    const activity = await this.activity(record).catch(() => null);
    if (activity && !activity.busy) await this.stop();
  }

  private async armMaintenance(): Promise<void> {
    this.deleteSchedules("maintain");
    await this.schedule(MAINTAIN_EVERY_S, "maintain");
  }

  private async grantIncluded(record: HomeRecord): Promise<HomeRecord> {
    if (!includedKeyDue(record, Date.now())) return record;
    const key = record.includedKey ?? `ldt_${randomToken(32)}`;
    let asHome: boolean;
    try {
      const response = await this.env.COMPUTERS.fetch(new Request("https://computers.internal/v1/homes/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: hex(await sha256(key)) }),
      }));
      if (!response.ok) throw new Error(`grant answered ${response.status}`);
      asHome = await grantedAsHome(response);
    } catch (error) {
      console.error(`laterdog home ${record.machineId}: included services not granted yet: ${error instanceof Error ? error.message : String(error)}`);
      return record;
    }
    const next: HomeRecord = { ...record, includedKey: key, includedAt: Date.now(), ...(asHome ? { includedHome: true as const } : {}) };
    await this.ctx.storage.put(RECORD_KEY, next);
    this.record = next;
    this.envVars = await this.environment(next);
    return next;
  }

  async summary(): Promise<HomeSummary | null> {
    const known = this.record;
    if (!known) return null;
    const record = known.readyAt ? known : await this.grantIncluded(known);
    if (record.readyAt) return { state: "ready", origin: record.origin };
    const slow = Date.now() - record.createdAt > SLOW_SETUP_MS ? { slow: true as const } : {};
    const { status } = await this.getState();
    if (status === "running" || status === "healthy") {
      if (await this.serves(record)) {
        await this.markReady(record);
        return { state: "ready", origin: record.origin };
      }
      return { state: "setting_up", origin: record.origin, setup: { step: "checking", ...slow } };
    }
    this.boot(record, true);
    return { state: "setting_up", origin: record.origin, setup: { step: this.booting ? "starting" : "reserving", ...slow } };
  }

  async pair(input: { label: string; ttlSeconds: number }): Promise<PairOutcome> {
    const record = this.record;
    const summary = await this.summary();
    if (!record || summary?.state !== "ready") return { ok: false, summary };
    if (!(await this.awake(record, PAIR_WAKE_WAIT_MS))) {
      return { ok: false, summary: { state: "setting_up", origin: record.origin, setup: { step: "starting" } }, status: 503 };
    }
    const secret = await bootstrapSecret(this.env.HOME_SECRET, record.machineId);
    const response = await this.containerFetch(await signedPairingRequest(record.origin, secret, input), HOME_PORT);
    const grant = response.ok ? parsePairingGrant(await response.json().catch(() => null), Date.now()) : null;
    if (!grant) return { ok: false, summary, status: response.status };
    await this.openPairing(grant.expiresAt);
    return { ok: true, origin: record.origin, ...grant };
  }

  async remove(): Promise<{ removed: number }> {
    const home = this.record ? this.stateHome(this.record.machineId) : this.size === "standard" ? this.ctx.id.toString() : null;
    await this.bury();
    await this.silence();
    const removed = home ? await forgetHomeState(this.env.STATE, home) : 0;
    await this.erase();
    return { removed };
  }

  async forget(): Promise<void> {
    await this.bury();
    await this.silence();
    await this.erase();
  }

  private async silence(): Promise<void> {
    await this.handover.release();
    await this.destroy().catch(() => undefined);
  }

  private async erase(): Promise<void> {
    await this.ctx.storage.deleteAll();
    this.record = null;
    this.storedStanding = null;
    this.wakers = {};
    this.pairingOpenUntil = 0;
    await this.bury();
  }

  override async onActivityExpired(): Promise<void> {
    const record = this.record;
    if (!record || !this.handover.holds()) return super.onActivityExpired();
    const decision = sleepDecision(await this.activity(record).catch(() => null), Date.now());
    if (decision.stay) {
      this.renewActivityTimeout();
      return;
    }
    this.deleteSchedules("wakeForRoutine");
    if (decision.wakeAt !== null) await this.schedule(new Date(decision.wakeAt), "wakeForRoutine");
    await super.onActivityExpired();
  }

  async wakeForRoutine(): Promise<void> {
    if (!this.record || this.removed || !this.handover.holds()) return;
    this.sleepAfter = ROUTINE_SLEEP_AFTER;
    this.boot(this.record, false);
  }

  private async activity(record: HomeRecord): Promise<HomeActivity | null> {
    if (!this.ctx.container?.running) return null;
    const secret = await bootstrapSecret(this.env.HOME_SECRET, record.machineId);
    const response = await this.containerFetch(await signedActivityRequest(record.origin, secret), HOME_PORT);
    return response.ok ? parseActivity(await response.json().catch(() => null)) : null;
  }

  override async fetch(request: Request): Promise<Response> {
    const record = this.record;
    if (!record || this.removed) return new Response("Not found", { status: 404 });
    const background = isBackground(request);
    const credential = background ? null : wakeCredential(request);
    const key = credential ? await wakerKey(credential) : null;
    const state = await this.machineState();
    const running = state === "serving";
    const wakes = !background && (await this.mayWake(key, !running));
    if (wakes) this.sleepAfter = PERSON_SLEEP_AFTER;
    if (running) {
      const response = wakes ? await super.fetch(request) : await this.quietly(request);
      if (credential && key) this.learn(record, credential, key, response);
      return response;
    }
    if (wakes && state === "stopped") this.boot(record, true);
    const busy = this.lastStart?.wake === "busy" && Date.now() - this.lastStart.at < BUSY_MEMORY_MS;
    return wakeResponse(request, busy ? "busy" : wakes || this.booting || state === "starting" ? "waking" : "asleep");
  }

  async knowsWaker(key: string): Promise<boolean> {
    return remembered(this.wakers, key, Date.now());
  }

  private async mayWake(key: string | null, askSibling: boolean): Promise<boolean> {
    const now = Date.now();
    if (now < this.pairingOpenUntil) return true;
    if (!key) return false;
    if (wakeGuard(this.env.HOME_WAKE_GUARD) === "learning") return true;
    if (remembered(this.wakers, key, now)) return true;
    if (!askSibling || !this.mayHaveMoved() || !(await this.siblingKnows(key))) return false;
    await this.remember(key);
    return true;
  }

  private mayHaveMoved(): boolean {
    return this.size === "large" || this.storedStanding !== null;
  }

  private async siblingKnows(key: string): Promise<boolean> {
    const record = this.record;
    if (!record) return false;
    const namespace = homeNamespace(this.env, otherSize(this.size));
    return namespace.get(namespace.idFromName(record.machineId)).knowsWaker(key).catch(() => false);
  }

  private learn(record: HomeRecord, credential: WakeCredential, key: string, response: Response): void {
    const now = Date.now();
    if (remembered(this.wakers, key, now)) {
      if (seenLongAgo(this.wakers, key, now)) this.ctx.waitUntil(this.remember(key));
      return;
    }
    if (credential.kind === "hook") {
      if (hookAccepted(response)) this.ctx.waitUntil(this.remember(key));
      return;
    }
    if (this.checking.has(key) || this.refused.has(key) || this.checking.size >= CHECKS_AT_ONCE) return;
    this.checking.add(key);
    this.ctx.waitUntil(
      this.quietly(sessionCheck(record.origin, credential))
        .then(sessionCheckOutcome)
        .then(async (outcome) => {
          if (outcome === "owner") await this.remember(key);
          if (outcome === "refused") this.refuse(key);
        })
        .catch(() => undefined)
        .finally(() => this.checking.delete(key)),
    );
  }

  private async remember(key: string): Promise<void> {
    this.wakers = remember(this.wakers, key, Date.now());
    await this.ctx.storage.put(WAKERS_KEY, this.wakers);
  }

  private refuse(key: string): void {
    if (this.refused.size >= REFUSED_KEPT) this.refused.clear();
    this.refused.add(key);
  }

  private async openPairing(until: number): Promise<void> {
    if (until <= this.pairingOpenUntil) return;
    this.pairingOpenUntil = until;
    await this.ctx.storage.put(PAIRING_OPEN_KEY, until);
  }

  private quietly(request: Request): Promise<Response> {
    const port = this.ctx.container?.getTcpPort(HOME_PORT);
    if (!port) return Promise.resolve(wakeResponse(request, "waking"));
    return port.fetch(request.url.replace("https:", "http:"), request);
  }

  private async machineState(): Promise<MachineState> {
    const { status } = await this.getState();
    const record = this.record;
    if (this.ctx.container?.running !== true || status !== "healthy" || !record) {
      this.serverUp = false;
      return "stopped";
    }
    return (await this.serves(record)) ? "serving" : "starting";
  }

  private async running(): Promise<boolean> {
    return (await this.machineState()) === "serving";
  }

  private async serves(record: HomeRecord): Promise<boolean> {
    if (!this.serverUp) this.serverUp = await this.healthy(record);
    return this.serverUp;
  }

  private async awake(record: HomeRecord, waitMs: number): Promise<boolean> {
    const state = await this.machineState();
    if (state === "serving") return true;
    if (state === "stopped") this.boot(record, true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([this.booting, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    if (timer !== null) clearTimeout(timer);
    return this.running();
  }

  private boot(known: HomeRecord, claim: boolean): void {
    if (this.booting || this.removed) return;
    let record = known;
    this.booting = this.handover.start(claim, {
      prepare: async () => {
        record = await this.grantIncluded(known);
        await this.armMaintenance();
      },
      start: async () => {
        this.signalled = false;
        this.serverUp = false;
        await this.startAndWaitForPorts(HOME_PORT, { portReadyTimeoutMS: BOOT_PORT_TIMEOUT_MS });
      },
      stop: () => this.quiet(),
    })
      .then(async (started) => {
        if (!started) return;
        this.lastStart = null;
        await this.ctx.storage.put(STARTED_KEY, record.includedKey ?? "");
        if (await this.serves(record)) await this.markReady(record);
      })
      .catch((error: unknown) => {
        this.lastStart = { wake: startFailure(error), at: Date.now() };
        console.error(`laterdog home ${record.machineId}: start failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.booting = null;
      });
    this.ctx.waitUntil(this.booting);
  }

  private async healthy(record: HomeRecord): Promise<boolean> {
    try {
      const response = await this.containerFetch(new Request(`${record.origin}/api/health`), HOME_PORT);
      if (!response.ok) return false;
      const body = (await response.json().catch(() => null)) as { app?: unknown } | null;
      return body?.app === "laterdog";
    } catch {
      return false;
    }
  }

  private async markReady(record: HomeRecord): Promise<void> {
    const current = this.record ?? record;
    if (current.readyAt) return;
    const ready = { ...current, readyAt: Date.now() };
    await this.ctx.storage.put(RECORD_KEY, ready);
    this.record = ready;
  }
}

CloudHomeHost.outboundHandlers = {
  state: async (request: Request, env: Env, context: OutboundHandlerContext<{ token: string; home?: string }>) => {
    if (!(await authorizedState(request, context.params?.token))) return new Response("Unauthorized", { status: 401 });
    const devCode = devCodeOn(env.DEV_CODE) ? await handleDevCode(request, env.STATE) : null;
    return devCode ?? handleState(request, env.STATE, stateOwner(context));
  },
  email: async (request: Request, env: Env, context: OutboundHandlerContext<{ token: string; accountId: string }>) =>
    handleOwnerEmail(request, context.params, env.ACCOUNTS as unknown as OwnerMail),
};

export class CloudHomeHostLarge extends CloudHomeHost {
  override readonly size: HomeSize = "large";
}

CloudHomeHostLarge.outboundHandlers = CloudHomeHost.outboundHandlers;
