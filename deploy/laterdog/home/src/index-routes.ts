import type { SignedCapabilityClaims } from "../../../../shared/signed-capability.ts";
import {
  INDEX_BUDGET_MS,
  INDEX_FEED_MAX_SHARDS,
  INDEX_ROUTE,
  type IndexFeedBatch,
  type IndexOperation,
  type IndexShards,
} from "../../../../shared/search-index-protocol.ts";
import { INDEX_REQUEST_ERROR, type SearchIndex } from "./person-index-store.ts";

export type IndexPort = { [Operation in keyof SearchIndex]: (...args: Parameters<SearchIndex[Operation]>) => Promise<ReturnType<SearchIndex[Operation]>> | ReturnType<SearchIndex[Operation]> };

export interface IndexShardPorts {
  person(): IndexPort;
  dog(id: string): IndexPort;
}

const OPERATIONS = new Set<string>(Object.keys(INDEX_BUDGET_MS));
const BUDGET_SPENT = Symbol("budget");
const DOG_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function answer(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

class IndexRequestError extends Error {}

export async function withinBudget<T>(work: Promise<T>, ms: number): Promise<T | typeof BUDGET_SPENT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const spent = new Promise<typeof BUDGET_SPENT>((resolve) => { timer = setTimeout(() => resolve(BUDGET_SPENT), ms); });
  try {
    return await Promise.race([work, spent]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function shardsOf(item: IndexShards): { person: boolean; dogs: string[] } {
  const dogs = item.dogs === undefined ? [] : item.dogs;
  if (!Array.isArray(dogs) || dogs.length > INDEX_FEED_MAX_SHARDS || !dogs.every((dog) => typeof dog === "string" && DOG_ID.test(dog))) {
    throw new IndexRequestError("dogs must be a short list of dog ids");
  }
  return { person: item.person !== false, dogs };
}

export function splitFeed(batch: IndexFeedBatch): Array<{ dog: string | null; batch: IndexFeedBatch }> {
  const out = new Map<string | null, Required<IndexFeedBatch>>();
  const into = (dog: string | null) => {
    let held = out.get(dog);
    if (!held) out.set(dog, held = { messages: [], removeMessages: [], removeChats: [], memory: [], removeMemory: [] });
    return held;
  };
  const route = (key: keyof IndexFeedBatch, items: unknown, ownDog = false) => {
    if (items === undefined) return;
    if (!Array.isArray(items)) throw new IndexRequestError(`${key} must be a list`);
    for (const raw of items as unknown[]) {
      if (!raw || typeof raw !== "object") throw new IndexRequestError(`${key} holds something that is not an item`);
      const { dogs: _dogs, person: _person, ...item } = raw as IndexShards & Record<string, unknown>;
      const shards = shardsOf(raw as IndexShards);
      const targets = new Set<string | null>(shards.dogs);
      if (ownDog && typeof item.dog === "string" && DOG_ID.test(item.dog)) targets.add(item.dog);
      if (shards.person) targets.add(null);
      for (const target of targets) (into(target)[key] as unknown[]).push(item);
    }
  };
  route("messages", batch.messages);
  route("removeMessages", batch.removeMessages);
  route("removeChats", batch.removeChats);
  route("memory", batch.memory, true);
  route("removeMemory", batch.removeMemory, true);
  return [...out].map(([dog, held]) => ({
    dog,
    batch: Object.fromEntries(Object.entries(held).filter(([, items]) => items.length)) as IndexFeedBatch,
  }));
}

function shardFor(ports: IndexShardPorts, body: Record<string, unknown>, operation: IndexOperation): IndexPort {
  const dog = body.dog;
  if (dog === undefined || operation === "search") return ports.person();
  if (typeof dog !== "string" || !DOG_ID.test(dog)) throw new IndexRequestError("dog is not a valid id");
  return ports.dog(dog);
}

async function run(operation: IndexOperation, body: Record<string, unknown>, ports: IndexShardPorts): Promise<unknown> {
  if (operation === "feed") {
    const parts = splitFeed(body as IndexFeedBatch);
    const applied = await Promise.all(parts.map(({ dog, batch }) => (dog === null ? ports.person() : ports.dog(dog)).feed(batch)));
    return { applied: applied.reduce((sum, part) => sum + part.applied, 0), shards: parts.length };
  }
  const { dog: _dog, ...request } = body;
  const port = shardFor(ports, body, operation);
  if (operation === "stats") return port.stats();
  return (port[operation] as (input: unknown) => unknown)(request);
}

export async function serveIndex(request: Request, claims: SignedCapabilityClaims, ports: IndexShardPorts, budgets: Record<IndexOperation, number> = INDEX_BUDGET_MS): Promise<Response> {
  const operation = new URL(request.url).pathname.slice(INDEX_ROUTE.length);
  if (!OPERATIONS.has(operation)) return answer(404, { error: "not_found" });
  if (claims.kind !== "index") return answer(403, { error: "capability_wrong-kind" });
  if (request.method !== "POST") return answer(405, { error: "post_only" });
  const body = await request.json().catch(() => null);
  if (operation !== "stats" && (!body || typeof body !== "object")) return answer(400, { error: "a JSON body is required" });
  const op = operation as IndexOperation;
  const started = Date.now();
  const work = Promise.resolve().then(() => run(op, (body ?? {}) as Record<string, unknown>, ports));
  work.catch(() => {});
  try {
    const result = await withinBudget(work, budgets[op]);
    if (result === BUDGET_SPENT) return answer(503, { error: "index_unavailable", reason: "budget", budgetMs: budgets[op] });
    return answer(200, { ok: true, result, ms: Date.now() - started });
  } catch (error) {
    if (error instanceof IndexRequestError) return answer(400, { error: error.message });
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(INDEX_REQUEST_ERROR)) return answer(400, { error: message.slice(message.indexOf(INDEX_REQUEST_ERROR) + INDEX_REQUEST_ERROR.length) });
    return answer(503, { error: "index_unavailable", reason: "failed" });
  }
}
