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
import { alwaysOn, KEEP_UP_EVERY_S, personSleepAfter, RESTART_AFTER_STOP_S } from "./always-on.ts";
import {
  DESK_KEPT_MS, DESK_SAVE_EVERY_MS, deliveryOutcome, deskAnswerWithQueue, deskKey, deskKind, deskPrefix, deskSend, forgetScope, queuedReceipt, queuedSend,
  refusedSend, saveAnswer, savable, savedAnswer, withQueued, type DeskBucket, type DeskKind, type QueuedSend,
} from "./desk.ts";
import { isBackground, startFailure, wakeResponse, type HomeWake } from "./waking.ts";
import { answerable, answerOnDesk, deskConversation, deskReplyHeaders, parseBrain, sentText, signedBrainRequest, type DeskBrain, type DeskDog } from "./desk-answer.ts";
import {
  DESK_PING_EVERY_TICKS, DESK_STREAM_TICK_MS, deskEvents, deskFrame, deskHello, deskPing, deskReplyId, deskReplyLine, deskRuntime, deskStreamResponse,
  deskUserLine, type DeskStream,
} from "./desk-stream.ts";
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
const OUTBOX_KEY = "desk-outbox";
const DESK_DEVICES_KEY = "desk-devices";
const DESK_DEVICES_KEPT = 50;
const DESK_RETRY_S = 5;
const DESK_GIVE_UP_MS = 60 * 60 * 1000;
const BRAIN_KEY = "desk-brain";
const BRAIN_REFRESH_MS = 5 * 60 * 1000;
const PAIRING_OPEN_KEY = "pairing-open-until";
const STATE_ROUTE_DEV_CODE_KEY = "state-route-dev-code";
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
  private outbox: QueuedSend[] = [];
  private deskDevices: Record<string, number> = {};
  private delivering: Promise<void> | null = null;
  private brain: DeskBrain | null = null;
  private brainLearnedAt = 0;
  private readonly answering = new Set<string>();
  private readonly deskChains = new Map<string, Promise<void>>();
  private readonly streams = new Set<DeskStream>();
  private readonly streamName = `desk-${randomToken(6)}`;
  private streamSeq = 0;
  private streamTicks = 0;
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private readonly lastSaved = new Map<string, { digest: string; at: number }>();
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
    const record = this.record;
    if (record && !this.removed && this.handover.holds() && alwaysOn(this.env.ALWAYS_ON_ACCOUNTS, record.accountId)) {
      this.ctx.waitUntil(this.schedule(RESTART_AFTER_STOP_S, "keepUp"));
    }
  }

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.record = (await ctx.storage.get<HomeRecord>(RECORD_KEY)) ?? null;
      this.storedStanding = (await ctx.storage.get<HomeStanding>(STANDING_KEY)) ?? null;
      this.removed = (await ctx.storage.get<boolean>(REMOVED_KEY)) === true;
      this.wakers = (await ctx.storage.get<Wakers>(WAKERS_KEY)) ?? {};
      this.outbox = (await ctx.storage.get<QueuedSend[]>(OUTBOX_KEY)) ?? [];
      this.deskDevices = (await ctx.storage.get<Record<string, number>>(DESK_DEVICES_KEY)) ?? {};
      this.brain = (await ctx.storage.get<DeskBrain>(BRAIN_KEY)) ?? null;
      this.pairingOpenUntil = (await ctx.storage.get<number>(PAIRING_OPEN_KEY)) ?? 0;
      if (this.record) this.envVars = await this.environment(this.record);
      if (this.record) await this.routeState(this.record);
    });
  }

  private async routeState(record: HomeRecord, { always = false } = {}): Promise<void> {
    const devCode = devCodeOn(this.env.DEV_CODE, record.accountId);
    if (!always && (await this.ctx.storage.get<boolean>(STATE_ROUTE_DEV_CODE_KEY)) === devCode) return;
    await this.setOutboundByHost(STATE_HOST, "state", { token: record.stateToken, home: this.stateHome(record.machineId), ...(devCode ? { devCode: true } : {}) });
    await this.ctx.storage.put(STATE_ROUTE_DEV_CODE_KEY, devCode);
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
      ...(devCodeOn(this.env.DEV_CODE, record.accountId) ? { LATERDOG_DEV_CODE: "1" } : {}),
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
    await this.routeState(record, { always: true });
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

  async keepUp(): Promise<void> {
    const record = this.record;
    if (!record || this.removed || !alwaysOn(this.env.ALWAYS_ON_ACCOUNTS, record.accountId)) {
      this.deleteSchedules("keepUp");
      return;
    }
    if (!this.handover.holds()) return;
    await this.armKeepUp();
    if (!this.ctx.container?.running) this.boot(record, false);
  }

  private async armKeepUp(): Promise<void> {
    this.deleteSchedules("keepUp");
    await this.schedule(KEEP_UP_EVERY_S, "keepUp");
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
    this.brain = null;
    this.storedStanding = null;
    this.wakers = {};
    this.pairingOpenUntil = 0;
    await this.bury();
  }

  override async onActivityExpired(): Promise<void> {
    const record = this.record;
    if (!record || !this.handover.holds()) return super.onActivityExpired();
    if (alwaysOn(this.env.ALWAYS_ON_ACCOUNTS, record.accountId)) {
      this.renewActivityTimeout();
      await this.armKeepUp();
      return;
    }
    const decision = sleepDecision(await this.activity(record).catch(() => null), Date.now());
    if (decision.stay) {
      this.renewActivityTimeout();
      return;
    }
    this.deleteSchedules("wakeForRoutine");
    if (decision.wakeAt !== null) await this.schedule(new Date(decision.wakeAt), "wakeForRoutine");
    await this.learnBrain(record);
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
    if (wakes) this.sleepAfter = personSleepAfter(this.env.HOME_SLEEP_AFTER);
    if (wakes && alwaysOn(this.env.ALWAYS_ON_ACCOUNTS, record.accountId)) await this.armKeepUp();
    if (running) {
      if (this.streams.size && !this.answering.size) this.closeDeskStreams();
      if (this.outbox.length) await this.deliverDesk(record);
      const kind = deskKind(request);
      const response = wakes ? await super.fetch(request) : await this.quietly(request);
      if (credential && key) this.learn(record, credential, key, response);
      if (key && credential?.kind === "session" && (response.status === 401 || response.status === 403)) {
        this.ctx.waitUntil(this.forgetDevice(record, key));
      }
      return kind ? this.keepAnswer(record, kind, key, request, response) : response;
    }
    if (wakes && state === "stopped") this.boot(record, true);
    if (deskEvents(request) && key && remembered(this.wakers, key, Date.now())) return this.openDeskStream();
    const saved = await this.answerAsleep(record, request, key);
    if (saved) return saved;
    const busy = this.lastStart?.wake === "busy" && Date.now() - this.lastStart.at < BUSY_MEMORY_MS;
    return wakeResponse(request, busy ? "busy" : wakes || this.booting || state === "starting" ? "waking" : "asleep");
  }

  private desk(): DeskBucket {
    return this.env.STATE as unknown as DeskBucket;
  }

  private deskScope(kind: Exclude<DeskKind, null>, key: string | null): string | null {
    if (kind === "shell") return "ui";
    return key && this.knownDevice(key) ? key : null;
  }

  private knownDevice(key: string): boolean {
    const seen = this.deskDevices[key];
    return seen !== undefined && Date.now() - seen < DESK_KEPT_MS;
  }

  private async noteDevice(key: string): Promise<void> {
    const now = Date.now();
    if (now - (this.deskDevices[key] ?? 0) < 60 * 60 * 1000) return;
    const kept = Object.entries({ ...this.deskDevices, [key]: now }).sort((a, b) => b[1] - a[1]).slice(0, DESK_DEVICES_KEPT);
    this.deskDevices = Object.fromEntries(kept);
    await this.ctx.storage.put(DESK_DEVICES_KEY, this.deskDevices);
  }

  private async forgetDevice(record: HomeRecord, key: string): Promise<void> {
    if (key in this.deskDevices) {
      const { [key]: _, ...rest } = this.deskDevices;
      this.deskDevices = rest;
      await this.ctx.storage.put(DESK_DEVICES_KEY, this.deskDevices);
    }
    await forgetScope(this.desk(), deskPrefix(this.stateHome(record.machineId), key)).catch(() => 0);
  }

  private keepAnswer(record: HomeRecord, kind: Exclude<DeskKind, null>, key: string | null, request: Request, response: Response): Response {
    if (!savable(kind, response)) return response;
    if (kind === "read" && key) this.ctx.waitUntil(this.noteDevice(key));
    if (kind === "read" && Date.now() - this.brainLearnedAt > BRAIN_REFRESH_MS) {
      this.brainLearnedAt = Date.now();
      this.ctx.waitUntil(this.learnBrain(record));
    }
    const scope = kind === "shell" ? "ui" : key;
    if (!scope) return response;
    const copy = response.clone();
    this.ctx.waitUntil((async () => {
      const where = await deskKey(this.stateHome(record.machineId), scope, request.url);
      const now = Date.now();
      const last = this.lastSaved.get(where);
      if (last && now - last.at < DESK_SAVE_EVERY_MS) return;
      const bytes = new Uint8Array(await copy.arrayBuffer());
      const digest = hex(await sha256(bytes));
      if (last?.digest === digest) {
        this.lastSaved.set(where, { digest, at: now });
        return;
      }
      const stored = await saveAnswer(this.desk(), where, new Response(bytes, { headers: copy.headers }), kind, now);
      if (stored) this.lastSaved.set(where, { digest: stored, at: now });
    })().catch(() => undefined));
    return response;
  }

  private async answerAsleep(record: HomeRecord, request: Request, key: string | null): Promise<Response | null> {
    if (deskSend(request)) {
      if (!key || !this.knownDevice(key)) return null;
      const queued = await queuedSend(request.clone(), Date.now());
      if (queued === "refused") return refusedSend();
      if (queued && this.outbox.some((earlier) => earlier.id === queued.id)) return queuedReceipt(queued);
      const next = queued ? withQueued(this.outbox, queued) : null;
      if (!queued || !next) return null;
      const dog = record.includedKey && remembered(this.wakers, key, Date.now()) ? answerable(queued, this.brain, Date.now()) : null;
      if (dog) this.answering.add(queued.id);
      this.outbox = next;
      await this.ctx.storage.put(OUTBOX_KEY, this.outbox);
      await this.armDesk();
      if (dog && record.includedKey) this.ctx.waitUntil(this.answerInTurn(record, record.includedKey, dog, queued));
      return queuedReceipt(queued);
    }
    const kind = deskKind(request);
    const scope = kind ? this.deskScope(kind, key) : null;
    if (!kind || !scope) return null;
    const saved = await savedAnswer(this.desk(), await deskKey(this.stateHome(record.machineId), scope, request.url), Date.now());
    if (!saved || !this.outbox.length || new URL(request.url).pathname !== "/api/bots") return saved;
    return deskAnswerWithQueue(saved, this.outbox, this.answering);
  }

  private async learnBrain(record: HomeRecord): Promise<void> {
    if (!this.ctx.container?.running) return;
    try {
      const secret = await bootstrapSecret(this.env.HOME_SECRET, record.machineId);
      const response = await this.containerFetch(await signedBrainRequest(record.origin, secret), HOME_PORT);
      const brain = response.ok ? parseBrain(await response.json().catch(() => null)) : null;
      if (!brain) return;
      this.brain = brain;
      this.brainLearnedAt = Date.now();
      await this.ctx.storage.put(BRAIN_KEY, brain);
    } catch (error) {
      console.error(`laterdog home ${record.machineId}: could not read the dogs' desk notes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private answerInTurn(record: HomeRecord, key: string, dog: DeskDog, queued: QueuedSend): Promise<void> {
    const before = this.deskChains.get(dog.botId) ?? Promise.resolve();
    const turn = before.then(() => this.answerFromDesk(record, key, dog, queued)).catch(() => undefined);
    this.deskChains.set(dog.botId, turn);
    return turn.finally(() => {
      if (this.deskChains.get(dog.botId) === turn) this.deskChains.delete(dog.botId);
    });
  }

  private deskLeaf(dog: DeskDog, queued: QueuedSend): string | null {
    const earlier = this.outbox.slice(0, this.outbox.findIndex((entry) => entry.id === queued.id)).filter((entry) => entry.path === queued.path && entry.reply);
    const last = earlier.at(-1);
    const words = last ? sentText(last) : null;
    return words ? deskReplyId(words.sendId) : dog.leafId;
  }

  private async answerFromDesk(record: HomeRecord, key: string, dog: DeskDog, queued: QueuedSend): Promise<void> {
    const words = sentText(queued);
    if (!words) {
      this.answering.delete(queued.id);
      return;
    }
    const earlier = this.outbox
      .slice(0, this.outbox.findIndex((entry) => entry.id === queued.id))
      .filter((entry) => entry.path === queued.path && entry.reply)
      .flatMap((entry) => {
        const said = sentText(entry);
        return said && entry.reply ? [{ text: said.text, reply: entry.reply.text }] : [];
      });
    try {
      this.broadcast({ kind: "message", threadId: dog.threadId, message: deskUserLine({ sendId: words.sendId, text: words.text, at: queued.at, parentId: this.deskLeaf(dog, queued) }) });
      this.broadcast(deskRuntime("turn.started", dog.threadId, words.sendId));
      const outcome = await answerOnDesk({
        api: this.env.INCLUDED_API,
        key,
        dog,
        messages: deskConversation(dog, earlier, words.text),
        onText: (delta) => this.broadcast(deskRuntime("content.delta", dog.threadId, words.sendId, { streamKind: "assistant_text", delta })),
      });
      if (outcome.kind === "reply") {
        this.outbox = this.outbox.map((entry) => (entry.id === queued.id ? { ...entry, reply: { text: outcome.text, model: dog.model } } : entry));
        await this.ctx.storage.put(OUTBOX_KEY, this.outbox);
        this.broadcast({ kind: "message", threadId: dog.threadId, message: deskReplyLine({ sendId: words.sendId, text: outcome.text, at: Date.now() }) });
      } else {
        console.error(`laterdog home ${record.machineId}: left a message for the home to answer (${outcome.reason})`);
      }
    } finally {
      this.answering.delete(queued.id);
      this.broadcast(deskRuntime("turn.completed", dog.threadId, words.sendId));
    }
    if ((await this.machineState()) === "serving") await this.deliverDesk(record);
  }

  private openDeskStream(): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const stream: DeskStream = { writer: writable.getWriter() };
    this.streams.add(stream);
    this.write(stream, deskHello(this.streamName, this.streamSeq));
    this.streamTimer ??= setInterval(() => this.ctx.waitUntil(this.tendDeskStreams()), DESK_STREAM_TICK_MS);
    return deskStreamResponse(readable);
  }

  private write(stream: DeskStream, bytes: Uint8Array): void {
    stream.writer.write(bytes).catch(() => this.dropDeskStream(stream));
  }

  private broadcast(payload: Record<string, unknown>): void {
    if (!this.streams.size) return;
    const seq = ++this.streamSeq;
    for (const stream of this.streams) this.write(stream, deskFrame(this.streamName, seq, payload));
  }

  private dropDeskStream(stream: DeskStream): void {
    this.streams.delete(stream);
    stream.writer.close().catch(() => undefined);
    if (!this.streams.size && this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
  }

  private closeDeskStreams(): void {
    for (const stream of this.streams) this.dropDeskStream(stream);
  }

  private async tendDeskStreams(): Promise<void> {
    this.streamTicks += 1;
    if (this.streamTicks % DESK_PING_EVERY_TICKS === 0) for (const stream of this.streams) this.write(stream, deskPing());
    if (this.answering.size || !this.streams.size) return;
    if ((await this.machineState()) === "serving") this.closeDeskStreams();
  }

  private async armDesk(): Promise<void> {
    this.deleteSchedules("deliverQueued");
    await this.schedule(DESK_RETRY_S, "deliverQueued");
  }

  async deliverQueued(): Promise<void> {
    const record = this.record;
    if (!record || this.removed || !this.outbox.length) return;
    const now = Date.now();
    const kept = this.outbox.filter((queued) => now - queued.at < DESK_GIVE_UP_MS);
    if (kept.length !== this.outbox.length) {
      console.error(`laterdog home ${record.machineId}: dropped ${this.outbox.length - kept.length} message(s) the home never took within an hour`);
      this.outbox = kept;
      await this.ctx.storage.put(OUTBOX_KEY, this.outbox);
    }
    if (!this.outbox.length) return;
    const state = await this.machineState();
    if (state === "serving") await this.deliverDesk(record);
    else if (state === "stopped") this.boot(record, true);
    if (this.outbox.length) await this.armDesk();
  }

  private deliverDesk(record: HomeRecord): Promise<void> {
    this.delivering ??= (async () => {
      while (this.outbox.length) {
        const queued = this.outbox[0]!;
        if (this.answering.has(queued.id)) break;
        const status = await this.containerFetch(await this.deliveryRequest(record, queued), HOME_PORT)
          .then((response) => response.status, () => null);
        const outcome = deliveryOutcome(status);
        if (outcome === "retry") break;
        if (outcome === "refused") console.error(`laterdog home ${record.machineId}: the home refused a message sent while it slept (${status})`);
        this.outbox = this.outbox.slice(1);
        await this.ctx.storage.put(OUTBOX_KEY, this.outbox);
      }
    })().finally(() => {
      this.delivering = null;
    });
    return this.delivering;
  }

  private async deliveryRequest(record: HomeRecord, queued: QueuedSend): Promise<Request> {
    const words = queued.reply ? sentText(queued) : null;
    if (!queued.reply || !words) return new Request(`${record.origin}${queued.path}`, { method: "POST", headers: queued.headers, body: queued.body });
    const secret = await bootstrapSecret(this.env.HOME_SECRET, record.machineId);
    const body = { ...(JSON.parse(queued.body) as Record<string, unknown>), deskReply: queued.reply };
    return new Request(`${record.origin}${queued.path}`, {
      method: "POST",
      headers: { ...queued.headers, ...(await deskReplyHeaders(secret, queued.path, words.sendId, queued.reply.text)) },
      body: JSON.stringify(body),
    });
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
  state: async (request: Request, env: Env, context: OutboundHandlerContext<{ token: string; home?: string; devCode?: boolean }>) => {
    if (!(await authorizedState(request, context.params?.token))) return new Response("Unauthorized", { status: 401 });
    const devCode = context.params?.devCode === true || devCodeOn(env.DEV_CODE) ? await handleDevCode(request, env.STATE) : null;
    return devCode ?? handleState(request, env.STATE, stateOwner(context));
  },
  email: async (request: Request, env: Env, context: OutboundHandlerContext<{ token: string; accountId: string }>) =>
    handleOwnerEmail(request, context.params, env.ACCOUNTS as unknown as OwnerMail),
};

export class CloudHomeHostLarge extends CloudHomeHost {
  override readonly size: HomeSize = "large";
}

CloudHomeHostLarge.outboundHandlers = CloudHomeHost.outboundHandlers;
