import { describe, expect, it, vi } from "vitest";
import { capabilityKey, signCapability, type SignedCapabilityClaims } from "../../../../shared/signed-capability.ts";
import { capabilitySecret, signCapabilitySync } from "../../../../server/laterdog/signed-capability-node.ts";
import {
  CAPABILITY_CLAIMS_HEADER,
  edgeCapabilityKey,
  edgeDeps,
  movedRoute,
  parseEdgeRoutes,
  routeAtEdge,
  type EdgeDeps,
  type EdgeRoutes,
} from "../src/edge-routes.ts";
import { bootstrapSecret } from "../src/identity.ts";

const HOME = "h0123456789abcdef01234567";
const NOW = 1_800_000_000_000;
const ROUTES: EdgeRoutes = [{ home: "*", prefix: "/api/internal/coordinator/", kinds: ["agents", "hooks", "turns"] }];
const claims: SignedCapabilityClaims = {
  home: HOME, dog: "bot-7", chat: "thread-9", generation: "g-1", kind: "agents", issuedAt: NOW - 1_000, expiresAt: NOW + 60_000,
};

function homeRequest(path: string, authorization?: string): Request {
  const headers = new Headers({ cookie: "laterdog_session=abc" });
  if (authorization) headers.set("authorization", authorization);
  return new Request(`https://${HOME}-home.later.dog${path}`, { method: "POST", headers, body: "{}" });
}

async function setup(routes: EdgeRoutes = ROUTES, coordinatorAnswer?: (request: Request) => Promise<Response>) {
  const key = await capabilityKey("bootstrap");
  const seen: Request[] = [];
  const coordinator = {
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      return coordinatorAnswer ? coordinatorAnswer(request) : Response.json({ from: "coordinator" });
    }),
  };
  const deps: EdgeDeps = { routes, home: HOME, key: async () => key, coordinator, now: () => NOW };
  return { key, deps, seen, coordinator };
}

async function homeWorker(request: Request, deps: EdgeDeps, container: (request: Request) => Promise<Response>): Promise<Response> {
  return (await routeAtEdge(request, deps)) ?? container(request);
}

describe("edge route table", () => {
  it("reads rows and stays off for an empty, unreadable or invalid table", () => {
    expect(parseEdgeRoutes(undefined)).toEqual([]);
    expect(parseEdgeRoutes("")).toEqual([]);
    expect(parseEdgeRoutes("{not json")).toEqual([]);
    expect(parseEdgeRoutes(JSON.stringify([{ home: "*", prefix: "/api/bots/", kinds: ["agents"] }]))).toEqual([]);
    expect(parseEdgeRoutes(JSON.stringify([{ home: "*", prefix: "/api/internal/x", kinds: ["root"] }]))).toEqual([]);
    expect(parseEdgeRoutes(JSON.stringify([{ home: "*", prefix: "/api/internal/x", kinds: [] }]))).toEqual([]);
    expect(parseEdgeRoutes(JSON.stringify(ROUTES))).toEqual(ROUTES);
  });

  it("moves only listed internal paths, preferring the longest prefix and this home's row", () => {
    const routes: EdgeRoutes = [
      { home: "*", prefix: "/api/internal/search", kinds: ["agents"] },
      { home: "*", prefix: "/api/internal/search/memory", kinds: ["hooks"] },
      { home: HOME, prefix: "/api/internal/search", kinds: ["connectors"] },
    ];
    expect(movedRoute(routes, HOME, "/api/internal/search")?.kinds).toEqual(["connectors"]);
    expect(movedRoute(routes, HOME, "/api/internal/search/memory/x")?.kinds).toEqual(["hooks"]);
    expect(movedRoute(routes, "h999999999999999999999999", "/api/internal/search")?.kinds).toEqual(["agents"]);
    expect(movedRoute(routes, HOME, "/api/internal/searches")).toBeNull();
    expect(movedRoute(routes, HOME, "/api/bots")).toBeNull();
  });

  it("leaves every request on the existing path while the flag is off", async () => {
    const { deps, coordinator } = await setup([]);
    expect(await routeAtEdge(homeRequest("/api/internal/coordinator/ping"), deps)).toBeNull();
    expect(await routeAtEdge(homeRequest("/api/internal/coordinator/ping"), { ...deps, routes: ROUTES, coordinator: undefined })).toBeNull();
    expect(await routeAtEdge(homeRequest("/api/internal/coordinator/ping"), edgeDeps({ HOME_SECRET: "s" }, HOME))).toBeNull();
    expect(coordinator.fetch).not.toHaveBeenCalled();
  });

  it("leaves unlisted paths on the existing path while the flag is on", async () => {
    const { key, deps, coordinator } = await setup();
    const token = await signCapability(key, claims);
    expect(await routeAtEdge(homeRequest("/api/internal/agents/list", `Bearer ${token}`), deps)).toBeNull();
    expect(await routeAtEdge(homeRequest("/api/bots?messages=0"), deps)).toBeNull();
    expect(coordinator.fetch).not.toHaveBeenCalled();
  });

  it("sends a moved path to the coordinator with verified claims and without the caller's credentials", async () => {
    const { key, deps, seen } = await setup();
    const response = await routeAtEdge(homeRequest("/api/internal/coordinator/ping", `Bearer ${await signCapability(key, claims)}`), deps);
    expect(await response?.json()).toEqual({ from: "coordinator" });
    expect(seen).toHaveLength(1);
    expect(JSON.parse(seen[0].headers.get(CAPABILITY_CLAIMS_HEADER) ?? "")).toEqual(claims);
    expect(seen[0].headers.get("authorization")).toBeNull();
    expect(seen[0].headers.get("cookie")).toBeNull();
    expect(await seen[0].text()).toBe("{}");
  });

  it("refuses missing, forged, expired, other-home and other-kind tokens at the edge", async () => {
    const { key, deps, coordinator } = await setup();
    const forged = await signCapability(await capabilityKey("someone-else"), claims);
    const cases: Array<[string | undefined, number, string]> = [
      [undefined, 401, "signed_capability_required"],
      ["Bearer 0123abcd", 401, "signed_capability_required"],
      [`Bearer ${forged}`, 401, "capability_forged"],
      [`Bearer ${await signCapability(key, { ...claims, expiresAt: NOW })}`, 401, "capability_expired"],
      [`Bearer ${await signCapability(key, { ...claims, home: "h999999999999999999999999" })}`, 401, "capability_wrong-home"],
      [`Bearer ${await signCapability(key, { ...claims, kind: "computer" })}`, 403, "capability_wrong-kind"],
    ];
    for (const [authorization, status, error] of cases) {
      const response = await routeAtEdge(homeRequest("/api/internal/coordinator/ping", authorization), deps);
      expect(response?.status).toBe(status);
      expect(await response?.json()).toEqual({ error });
    }
    expect(coordinator.fetch).not.toHaveBeenCalled();
  });

  it("answers a moved path while the home is down, and passes the home's own answer through for the rest", async () => {
    const { key, deps } = await setup();
    const token = await signCapability(key, claims);
    const container = vi.fn(async () => new Response("waking", { status: 503, headers: { "retry-after": "5" } }));
    const moved = await homeWorker(homeRequest("/api/internal/coordinator/ping", `Bearer ${token}`), deps, container);
    expect(moved.status).toBe(200);
    expect(container).not.toHaveBeenCalled();
    const unmoved = await homeWorker(homeRequest("/api/internal/agents/list", `Bearer ${token}`), deps, container);
    expect(unmoved.status).toBe(503);
    expect(unmoved.headers.get("retry-after")).toBe("5");
    expect(await unmoved.text()).toBe("waking");
  });

  it("says the coordinator is unavailable instead of falling back when it cannot be reached", async () => {
    const { key, deps } = await setup(ROUTES, async () => { throw new Error("binding down"); });
    const response = await routeAtEdge(homeRequest("/api/internal/coordinator/ping", `Bearer ${await signCapability(key, claims)}`), deps);
    expect(response?.status).toBe(503);
    expect(response?.headers.get("retry-after")).toBe("1");
    expect(await response?.json()).toEqual({ error: "coordinator_unavailable" });
  });

  it("derives the home's key from the secret the container already holds", async () => {
    const homeSecret = "home-secret";
    const containerSecret = await bootstrapSecret(homeSecret, HOME);
    const token = signCapabilitySync(capabilitySecret(containerSecret), claims);
    const deps = edgeDeps({ HOME_SECRET: homeSecret, EDGE_ROUTES: JSON.stringify(ROUTES), COORDINATOR: { fetch: async () => Response.json({ ok: true }) } }, HOME);
    const response = await routeAtEdge(homeRequest("/api/internal/coordinator/ping", `Bearer ${token}`), { ...deps, now: () => NOW });
    expect(response?.status).toBe(200);
    expect(await edgeCapabilityKey(homeSecret, HOME)).toBe(await edgeCapabilityKey(homeSecret, HOME));
  });
});
