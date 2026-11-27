import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { validCapabilityClaims, type SignedCapabilityClaims } from "../../../../shared/signed-capability.ts";
import { INDEX_ROUTE } from "../../../../shared/search-index-protocol.ts";
import { CAPABILITY_CLAIMS_HEADER } from "./edge-routes.ts";
import { serveIndex, type IndexPort, type IndexShardPorts } from "./index-routes.ts";
import { DogIndex, PersonIndex } from "./person-index.ts";
import { dogRoutines, type DogRoutinesPort } from "./dog-routines.ts";
import { dogInbox, type DogInboxPort } from "./dog-inbox.ts";
import { serveInbox, serveRoutines, type DogObjectPort } from "./dog-routes.ts";
import { INBOX_ROUTE, ROUTINES_ROUTE, type InboxLetter, type ObjectRoutine, type OccurrenceState } from "../../../../shared/dog-object-protocol.ts";
import { serveHistory } from "./chat-history.ts";

export { serveHistory };
import { ChatQueue, dogSlots, validQueueRow, validSlot, QUEUE_ROW_STATUSES, type ChatHistoryPort, type ChatQueuePort, type DogSlot, type DogSlotsPort, type QueueRowStatus } from "./chat-queue.ts";

export { ChatQueue, DogIndex, PersonIndex };

export const COORDINATOR_PREFIX = "/api/internal/coordinator/";

export interface CoordinatorEnv {
  DOGS: DurableObjectNamespace<Dog>;
  PERSON_INDEX: DurableObjectNamespace<PersonIndex>;
  DOG_INDEX: DurableObjectNamespace<DogIndex>;
  CHATS: DurableObjectNamespace<ChatQueue>;
}

interface TurnRecord {
  generation: string;
  issuedAt: number;
  open: boolean;
}

export interface DogTurns {
  openTurn(chat: string, generation: string, issuedAt: number): Promise<boolean>;
  closeTurn(chat: string, generation: string): Promise<boolean>;
  currentTurn(chat: string): Promise<string | null>;
}

interface TurnStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export function dogTurns(storage: TurnStorage): DogTurns {
  const key = (chat: string) => `turn:${chat}`;
  return {
    async openTurn(chat, generation, issuedAt) {
      const held = await storage.get<TurnRecord>(key(chat));
      if (held && (held.issuedAt > issuedAt || (held.issuedAt === issuedAt && held.generation !== generation))) return false;
      await storage.put<TurnRecord>(key(chat), { generation, issuedAt, open: true });
      return true;
    },
    async closeTurn(chat, generation) {
      const held = await storage.get<TurnRecord>(key(chat));
      if (!held || held.generation !== generation) return false;
      await storage.put<TurnRecord>(key(chat), { ...held, open: false });
      return true;
    },
    async currentTurn(chat) {
      const held = await storage.get<TurnRecord>(key(chat));
      return held?.open ? held.generation : null;
    },
  };
}

export class Dog extends DurableObject<CoordinatorEnv> implements DogTurns, DogSlotsPort, DogObjectPort {
  private readonly turns = dogTurns(this.ctx.storage);
  private readonly held = dogSlots(this.ctx.storage);
  private routinesPart: DogRoutinesPort | null = null;
  private inboxPart: DogInboxPort | null = null;
  private get routines(): DogRoutinesPort {
    return this.routinesPart ??= dogRoutines(this.ctx.storage.sql, {
      set: (at) => this.ctx.storage.setAlarm(at),
      clear: () => this.ctx.storage.deleteAlarm(),
    });
  }
  private get inbox(): DogInboxPort {
    return this.inboxPart ??= dogInbox(this.ctx.storage.sql);
  }
  override async alarm() {
    await this.routines.fireRoutines();
  }
  putRoutines(timeZone: string, routines: ObjectRoutine[]) {
    return this.routines.putRoutines(timeZone, routines);
  }
  claimRoutines() {
    return this.routines.claimRoutines();
  }
  settleRoutine(id: string, state: Exclude<OccurrenceState, "due">, runId: string) {
    return this.routines.settleRoutine(id, state, runId);
  }
  exportRoutines() {
    return this.routines.exportRoutines();
  }
  fireRoutines() {
    return this.routines.fireRoutines();
  }
  nextAlarmAt() {
    return this.routines.nextAlarmAt();
  }
  inboxPut(letter: InboxLetter) {
    return this.inbox.inboxPut(letter);
  }
  inboxPull(after: number, limit: number) {
    return this.inbox.inboxPull(after, limit);
  }
  inboxAck(clientIds: string[]) {
    return this.inbox.inboxAck(clientIds);
  }
  inboxStatus(clientIds: string[]) {
    return this.inbox.inboxStatus(clientIds);
  }
  slots() {
    return this.held.slots();
  }
  setSlots(slots: DogSlot[]) {
    return this.held.setSlots(slots);
  }
  chats() {
    return this.held.chats();
  }
  noteChat(chat: string, queued: boolean) {
    return this.held.noteChat(chat, queued);
  }
  openTurn(chat: string, generation: string, issuedAt: number) {
    return this.turns.openTurn(chat, generation, issuedAt);
  }
  closeTurn(chat: string, generation: string) {
    return this.turns.closeTurn(chat, generation);
  }
  currentTurn(chat: string) {
    return this.turns.currentTurn(chat);
  }
}

function answer(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function presentedClaims(request: Request): SignedCapabilityClaims | null {
  try {
    const claims: unknown = JSON.parse(request.headers.get(CAPABILITY_CLAIMS_HEADER) ?? "");
    return validCapabilityClaims(claims) ? claims : null;
  } catch {
    return null;
  }
}

export interface QueuePorts {
  dog(home: string, dog: string): DogSlotsPort;
  chat(home: string, chat: string): ChatQueuePort & ChatHistoryPort;
}

export async function serveQueue(body: Record<string, unknown>, claims: SignedCapabilityClaims, ports: QueuePorts): Promise<Response> {
  const dog = ports.dog(claims.home, claims.dog);
  switch (body.op) {
    case "put": {
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.every(validQueueRow)) return answer(400, { error: "bad_rows" });
      const stored = await ports.chat(claims.home, claims.chat).put(rows);
      await dog.noteChat(claims.chat, true);
      return answer(200, { ok: true, stored });
    }
    case "settle": {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
      const status = body.status === null ? null : (QUEUE_ROW_STATUSES as readonly unknown[]).includes(body.status) ? body.status as QueueRowStatus : undefined;
      if (status === undefined) return answer(400, { error: "bad_status" });
      return answer(200, { ok: true, settled: await ports.chat(claims.home, claims.chat).settle(ids, status) });
    }
    case "slots": {
      const slots = Array.isArray(body.slots) ? body.slots : [];
      const at = typeof body.at === "number" && Number.isSafeInteger(body.at) ? body.at : null;
      if (!slots.every(validSlot) || at === null) return answer(400, { error: "bad_slots" });
      const released = await dog.setSlots(slots);
      let cleared = 0;
      for (const chat of released) cleared += await ports.chat(claims.home, chat).release(at);
      return answer(200, { ok: true, released, cleared });
    }
    case "restore": {
      const chats: Record<string, unknown> = {};
      for (const chat of await dog.chats()) {
        const rows = await ports.chat(claims.home, chat).rows();
        if (rows.length) chats[chat] = rows;
        else await dog.noteChat(chat, false);
      }
      return answer(200, { ok: true, slots: await dog.slots(), chats });
    }
    default:
      return answer(400, { error: "unknown_op" });
  }
}

export async function coordinate(request: Request, dogFor: (home: string, dog: string) => DogTurns, indexFor?: (home: string) => IndexShardPorts, queues?: QueuePorts, dogObjects?: (home: string, dog: string) => DogObjectPort): Promise<Response> {
  const claims = presentedClaims(request);
  if (!claims) return answer(401, { error: "capability_required" });
  const path = new URL(request.url).pathname;
  if (path.startsWith(INDEX_ROUTE)) return indexFor ? serveIndex(request, claims, indexFor(claims.home)) : answer(404, { error: "not_found" });
  if ((path === `${COORDINATOR_PREFIX}queue` || path === `${COORDINATOR_PREFIX}history`) && request.method === "POST") {
    if (claims.kind !== "turns") return answer(403, { error: "capability_wrong-kind" });
    if (!queues) return answer(404, { error: "not_found" });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return answer(400, { error: "bad_body" });
    return path.endsWith("/queue") ? serveQueue(body, claims, queues) : serveHistory(body, claims, queues);
  }
  if ((path === ROUTINES_ROUTE || path === INBOX_ROUTE) && request.method === "POST") {
    if (claims.kind !== "turns") return answer(403, { error: "capability_wrong-kind" });
    if (!dogObjects) return answer(404, { error: "not_found" });
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return answer(400, { error: "bad_body" });
    return path === ROUTINES_ROUTE
      ? serveRoutines(body, claims, dogObjects(claims.home, claims.dog))
      : serveInbox(body, claims, (dog) => dogObjects(claims.home, dog));
  }
  const dog = dogFor(claims.home, claims.dog);
  if (path === `${COORDINATOR_PREFIX}turns` && request.method === "POST") {
    if (claims.kind !== "turns") return answer(403, { error: "capability_wrong-kind" });
    const { action } = (await request.json().catch(() => ({}))) as { action?: unknown };
    if (action === "open") {
      return (await dog.openTurn(claims.chat, claims.generation, claims.issuedAt))
        ? answer(200, { ok: true, generation: claims.generation })
        : answer(409, { error: "stale_generation" });
    }
    if (action === "close") {
      return (await dog.closeTurn(claims.chat, claims.generation)) ? answer(200, { ok: true }) : answer(409, { error: "stale_generation" });
    }
    return answer(400, { error: "unknown_action" });
  }
  if (path === `${COORDINATOR_PREFIX}ping`) {
    if (claims.kind === "turns") return answer(403, { error: "capability_wrong-kind" });
    if ((await dog.currentTurn(claims.chat)) !== claims.generation) return answer(409, { error: "stale_generation" });
    return answer(200, { ok: true, home: claims.home, dog: claims.dog, chat: claims.chat, generation: claims.generation, kind: claims.kind });
  }
  return answer(404, { error: "not_found" });
}

export class CoordinatorApi extends WorkerEntrypoint<CoordinatorEnv> {
  override fetch(request: Request): Promise<Response> {
    return coordinate(
      request,
      (home, dog) => this.env.DOGS.get(this.env.DOGS.idFromName(`${home}/${dog}`)),
      (home) => ({
        person: () => this.env.PERSON_INDEX.get(this.env.PERSON_INDEX.idFromName(home)) as unknown as IndexPort,
        dog: (dog) => this.env.DOG_INDEX.get(this.env.DOG_INDEX.idFromName(`${home}/${dog}`)) as unknown as IndexPort,
      }),
      {
        dog: (home, dog) => this.env.DOGS.get(this.env.DOGS.idFromName(`${home}/${dog}`)),
        chat: (home, chat) => this.env.CHATS.get(this.env.CHATS.idFromName(`${home}/${chat}`)),
      },
      (home, dog) => this.env.DOGS.get(this.env.DOGS.idFromName(`${home}/${dog}`)) as unknown as DogObjectPort,
    );
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<CoordinatorEnv>;
