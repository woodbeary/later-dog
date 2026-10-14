import { Container, type OutboundHandlerContext } from "@cloudflare/containers";
import { parseActivity, signedActivityRequest, sleepDecision, type HomeActivity } from "./activity.ts";
import { includedKeyDue } from "./included.ts";
import { hex, randomToken, sha256 } from "./encoding.ts";
import { bootstrapSecret, type HomeIdentity } from "./identity.ts";
import { parsePairingGrant, signedPairingRequest, type PairingGrant } from "./pairing.ts";
import { handleOwnerEmail, type OwnerMail } from "./email.ts";
import { authorizedState, EMAIL_HOST, forgetHomeState, handleState, STATE_HOST } from "./state.ts";
import { isBackground, startFailure, wakeResponse, type HomeWake } from "./waking.ts";

export const HOME_PORT = 8080;
const RECORD_KEY = "home";
const SLOW_SETUP_MS = 3 * 60_000;
export const BOOT_PORT_TIMEOUT_MS = 3 * 60_000;
export const PAIR_WAKE_WAIT_MS = 15_000;
const BUSY_MEMORY_MS = 10_000;
const STARTED_KEY = "started-included-key";
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
  private record: HomeRecord | null = null;
  private booting: Promise<void> | null = null;
  private lastStart: { wake: HomeWake; at: number } | null = null;

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.record = (await ctx.storage.get<HomeRecord>(RECORD_KEY)) ?? null;
      if (this.record) this.envVars = await this.environment(this.record);
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

  async adopt(identity: HomeIdentity): Promise<void> {
    if (this.record) {
      if (this.record.machineId !== identity.machineId || this.record.accountId !== identity.accountId) throw new Error("This home belongs to another account.");
      return;
    }
    const record: HomeRecord = { ...identity, createdAt: Date.now(), stateToken: randomToken(32), emailToken: randomToken(32) };
    await this.setOutboundByHost(STATE_HOST, "state", { token: record.stateToken });
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
    this.boot(record);
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
    this.deleteSchedules("maintain");
    this.deleteSchedules("wakeForRoutine");
    await this.destroy().catch(() => undefined);
    const removed = await forgetHomeState(this.env.STATE, this.ctx.id.toString());
    await this.ctx.storage.deleteAll();
    this.record = null;
    return { removed };
  }

  override async onActivityExpired(): Promise<void> {
    const record = this.record;
    if (!record) return super.onActivityExpired();
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
    if (!this.record) return;
    this.sleepAfter = ROUTINE_SLEEP_AFTER;
    this.boot(this.record);
  }

  private async activity(record: HomeRecord): Promise<HomeActivity | null> {
    if (!this.ctx.container?.running) return null;
    const secret = await bootstrapSecret(this.env.HOME_SECRET, record.machineId);
    const response = await this.containerFetch(await signedActivityRequest(record.origin, secret), HOME_PORT);
    return response.ok ? parseActivity(await response.json().catch(() => null)) : null;
  }

  override async fetch(request: Request): Promise<Response> {
    const record = this.record;
    if (!record) return new Response("Not found", { status: 404 });
    const background = isBackground(request);
    if (!background) this.sleepAfter = PERSON_SLEEP_AFTER;
    if (await this.running()) return background ? this.quietly(request) : super.fetch(request);
    if (!background) this.boot(record);
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
    this.boot(record);
    let timer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([this.booting, new Promise<void>((resolve) => { timer = setTimeout(resolve, waitMs); })]);
    if (timer !== null) clearTimeout(timer);
    return this.running();
  }

  private boot(known: HomeRecord): void {
    if (this.booting) return;
    let record = known;
    this.booting = this.grantIncluded(known)
      .then(async (granted) => {
        record = granted;
        await this.armMaintenance();
        return this.startAndWaitForPorts(HOME_PORT, { portReadyTimeoutMS: BOOT_PORT_TIMEOUT_MS });
      })
      .then(async () => {
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
  state: async (request: Request, env: Env, context: OutboundHandlerContext<{ token: string }>) => {
    if (!(await authorizedState(request, context.params?.token))) return new Response("Unauthorized", { status: 401 });
    return handleState(request, env.STATE, context.containerId);
  },
  email: async (request: Request, env: Env, context: OutboundHandlerContext<{ token: string; accountId: string }>) =>
    handleOwnerEmail(request, context.params, env.ACCOUNTS as unknown as OwnerMail),
};
