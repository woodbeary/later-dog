import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
  WorkerEntrypoint: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
}));

const { capabilityKey, signCapability } = await import("../../../../shared/signed-capability.ts");
const { CAPABILITY_CLAIMS_HEADER, routeAtEdge } = await import("../src/edge-routes.ts");
const { coordinate, dogTurns, Dog, CoordinatorApi } = await import("../src/coordinator.ts");
type Claims = import("../../../../shared/signed-capability.ts").SignedCapabilityClaims;
type Turns = import("../src/coordinator.ts").DogTurns;

const HOME = "h0123456789abcdef01234567";
const NOW = 1_800_000_000_000;
const base: Claims = { home: HOME, dog: "bot-7", chat: "thread-9", generation: "g-1", kind: "agents", issuedAt: NOW, expiresAt: NOW + 60_000 };

function memoryStorage() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async get<T>(key: string) { return rows.get(key) as T | undefined; },
    async put<T>(key: string, value: T) { rows.set(key, structuredClone(value)); },
  };
}

function dogsInMemory() {
  const dogs = new Map<string, Turns>();
  return (home: string, dog: string) => {
    const name = `${home}/${dog}`;
    if (!dogs.has(name)) dogs.set(name, dogTurns(memoryStorage()));
    return dogs.get(name)!;
  };
}

function call(dogFor: ReturnType<typeof dogsInMemory>, path: string, claims: Claims | null, body?: unknown) {
  const headers = new Headers();
  if (claims) headers.set(CAPABILITY_CLAIMS_HEADER, JSON.stringify(claims));
  const request = new Request(`https://coordinator.internal/api/internal/coordinator/${path}`, {
    method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return coordinate(request, dogFor);
}

const turn = (generation: string, issuedAt: number): Claims => ({ ...base, kind: "turns", generation, issuedAt });

describe("coordinator", () => {
  it("accepts a tool call only for the chat's current turn", async () => {
    const dogs = dogsInMemory();
    expect((await call(dogs, "ping", base)).status).toBe(409);
    expect((await call(dogs, "turns", turn("g-1", NOW), { action: "open" })).status).toBe(200);
    const ok = await call(dogs, "ping", base);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, home: HOME, dog: "bot-7", chat: "thread-9", generation: "g-1", kind: "agents" });
    expect((await call(dogs, "ping", { ...base, chat: "thread-other" })).status).toBe(409);
    expect((await call(dogs, "ping", { ...base, dog: "bot-other" })).status).toBe(409);
  });

  it("refuses a stale generation once a newer turn opens or the turn closes", async () => {
    const dogs = dogsInMemory();
    await call(dogs, "turns", turn("g-1", NOW), { action: "open" });
    expect((await call(dogs, "turns", turn("g-2", NOW + 5), { action: "open" })).status).toBe(200);
    expect(await (await call(dogs, "ping", base)).json()).toEqual({ error: "stale_generation" });
    expect((await call(dogs, "ping", { ...base, generation: "g-2" })).status).toBe(200);
    expect((await call(dogs, "turns", turn("g-1", NOW), { action: "open" })).status).toBe(409);
    expect((await call(dogs, "turns", turn("g-1", NOW), { action: "close" })).status).toBe(409);
    expect((await call(dogs, "turns", turn("g-2", NOW + 5), { action: "close" })).status).toBe(200);
    expect((await call(dogs, "ping", { ...base, generation: "g-2" })).status).toBe(409);
  });

  it("keeps turn control to the container's own kind and refuses calls without verified claims", async () => {
    const dogs = dogsInMemory();
    expect((await call(dogs, "turns", base, { action: "open" })).status).toBe(403);
    expect((await call(dogs, "ping", turn("g-1", NOW))).status).toBe(403);
    expect((await call(dogs, "turns", turn("g-1", NOW), { action: "drop" })).status).toBe(400);
    expect((await call(dogs, "ping", null)).status).toBe(401);
    expect((await call(dogs, "ping", { ...base, kind: "root" } as never)).status).toBe(401);
    expect((await call(dogs, "elsewhere", base)).status).toBe(404);
  });

  it("serves the edge end to end: a signed token for a live turn passes, forged and stale ones do not", async () => {
    const dogs = dogsInMemory();
    const key = await capabilityKey("bootstrap");
    const deps = {
      routes: [{ home: "*", prefix: "/api/internal/coordinator/", kinds: ["agents", "turns"] as const }],
      home: HOME,
      key: async () => key,
      coordinator: { fetch: async (input: RequestInfo | URL, init?: RequestInit) => coordinate(new Request(input, init), dogs) },
      now: () => NOW,
    };
    const send = async (path: string, token: string, body?: unknown) => (await routeAtEdge(new Request(`https://${HOME}-home.later.dog/api/internal/coordinator/${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}),
    }), deps))!;
    expect((await send("turns", await signCapability(key, turn("g-1", NOW)), { action: "open" })).status).toBe(200);
    expect((await send("ping", await signCapability(key, base))).status).toBe(200);
    expect((await send("ping", await signCapability(await capabilityKey("other"), base))).status).toBe(401);
    expect((await send("ping", await signCapability(key, { ...base, generation: "g-0" }))).status).toBe(409);
  });

  it("wires the durable dog and the entrypoint to the same rules", async () => {
    const storage = memoryStorage();
    const dog = new Dog({ storage } as never, {} as never);
    expect(await dog.openTurn("thread-9", "g-1", NOW)).toBe(true);
    expect(await dog.currentTurn("thread-9")).toBe("g-1");
    const namespace = { idFromName: (name: string) => name, get: vi.fn(() => dog) };
    const api = new CoordinatorApi({} as never, { DOGS: namespace } as never);
    const response = await api.fetch(new Request("https://coordinator.internal/api/internal/coordinator/ping", {
      headers: { [CAPABILITY_CLAIMS_HEADER]: JSON.stringify(base) },
    }));
    expect(response.status).toBe(200);
    expect(namespace.get).toHaveBeenCalledWith(`${HOME}/bot-7`);
  });
});
