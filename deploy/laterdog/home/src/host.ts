import { Container, type OutboundHandlerContext } from "@cloudflare/containers";
import { parseActivity, signedActivityRequest, sleepDecision, type HomeActivity } from "./activity.ts";
import { includedKeyDue } from "./included.ts";
import { hex, randomToken, sha256 } from "./encoding.ts";
import { bootstrapSecret, type HomeIdentity } from "./identity.ts";
import { parsePairingGrant, signedPairingRequest, type PairingGrant } from "./pairing.ts";
import { handleOwnerEmail, type OwnerMail } from "./email.ts";
import { Handover, type HandoverPeer, type HomeStanding } from "./handover.ts";
import { homeLane, homeLanes, homeNamespace, type HomeLane, type HomeSize } from "./size.ts";
import { checkpointSelection, verifyHomeCheckpoint } from "./checkpoint.ts";
import { authorizedState, EMAIL_HOST, forgetHomeState, handleState, STATE_HOST, stateOwner } from "./state.ts";
import { isBackground, startFailure, wakeResponse, type HomeWake } from "./waking.ts";

export const HOME_PORT = 8080;
const RECORD_KEY = "home";
const SLOW_SETUP_MS = 3 * 60_000;
export const BOOT_PORT_TIMEOUT_MS = 3 * 60_000;
export const PAIR_WAKE_WAIT_MS = 15_000;
const BUSY_MEMORY_MS = 10_000;
const STARTED_KEY = "started-included-key";
const STANDING_KEY = "standing";
const REMOVED_KEY = "removed";
const CHECKPOINT_KEY = "release-checkpoint";
const CANDIDATE_USED_KEY = "candidate-used";
const REMOVED = "This home was removed.";
export const PERSON_SLEEP_AFTER = "2h";
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
  readyAt?: number;
}

export type PairOutcome =
  | ({ ok: true; origin: string } & PairingGrant)
  | { ok: false; summary: HomeSummary | null; status?: number };

export class CloudHomeHost extends Container<Env> {
  defaultPort = HOME_PORT;
  sleepAfter = PERSON_SLEEP_AFTER;
  enableInternet = true;
  readonly size: HomeSize = "standard";
  readonly lane: HomeLane = "standard";
  private record: HomeRecord | null = null;
  private booting: Promise<void> | null = null;
  private lastStart: { wake: HomeWake; at: number } | null = null;
  private storedStanding: HomeStanding | null = null;
  private signalled = false;
  private removed = false;
  private acceptedCheckpoint: string | null = null;
  private candidateUsed = false;
  private releaseEpoch = 0;
  private readonly handover = new Handover({
    standing: () => this.storedStanding ?? (this.lane === "standard" ? "holding" : "released"),
    stand: async (standing) => {
      this.storedStanding = standing;
      await this.ctx.storage.put(STANDING_KEY, standing);
    },
    running: () => this.ctx.container?.running === true,
    quiet: () => this.quiet(),
    siblings: () => this.siblings(),
  });

  override onStop({ exitCode, reason }: { exitCode: number; reason: string }): void {
    console.error(`laterdog home ${this.record?.machineId ?? "unknown"}: stopped (${reason}, exit ${exitCode})`);
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.record = (await ctx.storage.get<HomeRecord>(RECORD_KEY)) ?? null;
      this.storedStanding = (await ctx.storage.get<HomeStanding>(STANDING_KEY)) ?? null;
      this.removed = (await ctx.storage.get<boolean>(REMOVED_KEY)) === true;
      this.acceptedCheckpoint = (await ctx.storage.get<string>(CHECKPOINT_KEY)) ?? null;
      this.candidateUsed = (await ctx.storage.get<boolean>(CANDIDATE_USED_KEY)) === true;
      if (this.record) this.envVars = await this.environment(this.record);
    });
  }

  private stateHome(machineId: string): string {
    return this.env.HOMES.idFromName(machineId).toString();
  }

  private siblings(): HandoverPeer[] {
    const record = this.record;
    if (!record) throw new Error("This home has no owner yet.");
    return homeLanes(this.env).filter((lane) => lane !== this.lane).map((lane) => {
      const namespace = homeNamespace(this.env, lane);
      const owner = namespace.get(namespace.idFromName(record.machineId));
      return {
        ready: async () => {
          if (this.env.HOMES_CANDIDATE && await owner.releaseProtocol() !== 1) throw new Error("The home release controller needs to finish updating before changing lanes.");
        },
        release: () => owner.release(),
      };
    });
  }

  async releaseProtocol(): Promise<1> {
    return 1;
  }

  async release(): Promise<boolean> {
    this.releaseEpoch += 1;
    this.acceptedCheckpoint = null;
    await this.ctx.storage.delete(CHECKPOINT_KEY);
    return this.handover.release();
  }

  async markCandidateUsed(): Promise<void> {
    await this.ctx.storage.put(CANDIDATE_USED_KEY, true);
    this.candidateUsed = true;
  }

  private async prepareRelease(record: HomeRecord): Promise<void> {
    const epoch = this.releaseEpoch;
    if (await homeLane(this.env, record.machineId) !== this.lane) throw new Error("This home is assigned to another release lane.");
    if (this.lane !== "candidate" && !this.candidateUsed) return;
    const selected = checkpointSelection(this.env, record.accountId, this.lane);
    if (this.acceptedCheckpoint === selected.key) return;
    const verified = await verifyHomeCheckpoint(this.env, record, this.stateHome(record.machineId), this.lane);
    if (epoch !== this.releaseEpoch || !this.handover.holds()) throw new Error("This home is handing over to another release lane.");
    await this.ctx.storage.put(CHECKPOINT_KEY, verified);
    if (epoch !== this.releaseEpoch || !this.handover.holds()) {
      await this.ctx.storage.delete(CHECKPOINT_KEY);
      throw new Error("This home is handing over to another release lane.");
    }
    this.acceptedCheckpoint = verified;
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
    return this.handover.launch(async () => {
      if (this.record) await this.prepareRelease(this.record);
      if (this.lane === "candidate") {
        const record = this.record;
        if (!record) throw new Error("This home has no owner yet.");
        await Promise.all(homeLanes(this.env).map((lane) => {
          const namespace = homeNamespace(this.env, lane);
          return lane === this.lane ? this.markCandidateUsed() : namespace.get(namespace.idFromName(record.machineId)).markCandidateUsed();
        }));
      }
      await super.startAndWaitForPorts(...args);
    });
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
    const key = `ldt_${randomToken(32)}`;
    try {
      const response = await this.env.COMPUTERS.fetch(new Request("https://computers.internal/v1/homes/grant", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claim: hex(await sha256(key)) }),
      }));
      if (!response.ok) throw new Error(`grant answered ${response.status}`);
    } catch (error) {
      console.error(`laterdog home ${record.machineId}: included services not granted yet: ${error instanceof Error ? error.message : String(error)}`);
      return record;
    }
    const next = { ...record, includedKey: key, includedAt: Date.now() };
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
      if (await this.healthy(record)) {
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
    this.acceptedCheckpoint = null;
    this.candidateUsed = false;
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
    if (!background) this.sleepAfter = PERSON_SLEEP_AFTER;
    if (await this.running()) return background ? this.quietly(request) : super.fetch(request);
    if (!background) this.boot(record, true);
    const busy = this.lastStart?.wake === "busy" && Date.now() - this.lastStart.at < BUSY_MEMORY_MS;
    return wakeResponse(request, busy ? "busy" : background && !this.booting ? "asleep" : "waking");
  }

  private quietly(request: Request): Promise<Response> {
    const port = this.ctx.container?.getTcpPort(HOME_PORT);
    if (!port) return Promise.resolve(wakeResponse(request, "waking"));
    return port.fetch(request.url.replace("https:", "http:"), request);
  }

  private async running(): Promise<boolean> {
    const { status } = await this.getState();
    return this.ctx.container?.running === true && status === "healthy";
  }

  private async awake(record: HomeRecord, waitMs: number): Promise<boolean> {
    if (await this.running()) return true;
    this.boot(record, true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([this.booting, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    if (timer !== null) clearTimeout(timer);
    return this.running();
  }

  private boot(known: HomeRecord, claim: boolean): void {
    if (this.booting || this.removed) return;
    let record = known;
    this.booting = Promise.resolve().then(async () => {
      if (await homeLane(this.env, record.machineId) !== this.lane) return false;
      if (this.lane === "candidate" && !this.acceptedCheckpoint) {
        await verifyHomeCheckpoint(this.env, record, this.stateHome(record.machineId), this.lane);
      }
      return this.handover.start(claim, {
        prepare: async () => {
          await this.prepareRelease(record);
          record = await this.grantIncluded(known);
          await this.armMaintenance();
        },
        start: async () => {
          this.signalled = false;
          await this.startAndWaitForPorts(HOME_PORT, { portReadyTimeoutMS: BOOT_PORT_TIMEOUT_MS });
        },
        stop: () => this.quiet(),
      });
    })
      .then(async (started) => {
        if (!started) return;
        this.lastStart = null;
        await this.ctx.storage.put(STARTED_KEY, record.includedKey ?? "");
        if (await this.healthy(record)) await this.markReady(record);
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
    return handleState(request, env.STATE, stateOwner(context));
  },
  email: async (request: Request, env: Env, context: OutboundHandlerContext<{ token: string; accountId: string }>) =>
    handleOwnerEmail(request, context.params, env.ACCOUNTS as unknown as OwnerMail),
};

export class CloudHomeHostLarge extends CloudHomeHost {
  override readonly size: HomeSize = "large";
  override readonly lane: HomeLane = "large";
}

CloudHomeHostLarge.outboundHandlers = CloudHomeHost.outboundHandlers;

export class CloudHomeHostCandidate extends CloudHomeHost {
  override readonly lane: HomeLane = "candidate";
}

CloudHomeHostCandidate.outboundHandlers = CloudHomeHost.outboundHandlers;
