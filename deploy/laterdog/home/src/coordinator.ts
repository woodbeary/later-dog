import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { validCapabilityClaims, type SignedCapabilityClaims } from "../../../../shared/signed-capability.ts";
import { INDEX_ROUTE } from "../../../../shared/search-index-protocol.ts";
import { CAPABILITY_CLAIMS_HEADER } from "./edge-routes.ts";
import { serveIndex, type IndexPort } from "./index-routes.ts";
import { PersonIndex } from "./person-index.ts";

export { PersonIndex };

export const COORDINATOR_PREFIX = "/api/internal/coordinator/";

export interface CoordinatorEnv {
  DOGS: DurableObjectNamespace<Dog>;
  PERSON_INDEX: DurableObjectNamespace<PersonIndex>;
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

export class Dog extends DurableObject<CoordinatorEnv> implements DogTurns {
  private readonly turns = dogTurns(this.ctx.storage);
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

export async function coordinate(request: Request, dogFor: (home: string, dog: string) => DogTurns, indexFor?: (home: string) => IndexPort): Promise<Response> {
  const claims = presentedClaims(request);
  if (!claims) return answer(401, { error: "capability_required" });
  const path = new URL(request.url).pathname;
  if (path.startsWith(INDEX_ROUTE)) return indexFor ? serveIndex(request, claims, indexFor(claims.home)) : answer(404, { error: "not_found" });
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
      (home) => this.env.PERSON_INDEX.get(this.env.PERSON_INDEX.idFromName(home)) as unknown as IndexPort,
    );
  }
}

export default {
  fetch(): Response {
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<CoordinatorEnv>;
