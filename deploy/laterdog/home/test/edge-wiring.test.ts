import { describe, expect, it, vi } from "vitest";
import { signCapabilitySync, capabilitySecret } from "../../../../server/laterdog/signed-capability-node.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { default: worker } = await import("../src/index.ts");
const { bootstrapSecret } = await import("../src/identity.ts");

const HOME = "h0123456789abcdef01234567";
const SECRET = "home-secret";
const ROUTES = JSON.stringify([{ home: "*", prefix: "/api/internal/coordinator/", kinds: ["agents"] }]);

function cloud(extra: Record<string, unknown>) {
  const homes: string[] = [];
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => {
      homes.push(name);
      return { fetch: async () => new Response("from the home") };
    },
  };
  const env = { HOME_SECRET: SECRET, HOME_HOST_SUFFIX: "-home.later.dog", LARGE_HOME_ACCOUNTS: "", HOMES: namespace, HOMES_LARGE: namespace, ...extra };
  return { env, homes };
}

async function signedCall(env: object) {
  const now = Date.now();
  const token = signCapabilitySync(capabilitySecret(await bootstrapSecret(SECRET, HOME)), {
    home: HOME, dog: "bot-1", chat: "thread-1", generation: "g-1", kind: "agents", issuedAt: now, expiresAt: now + 60_000,
  });
  return worker.fetch(new Request(`https://${HOME}-home.later.dog/api/internal/coordinator/ping`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  }), env as never);
}

describe("home Worker edge wiring", () => {
  it("sends everything to the home while no route row or coordinator binding exists", async () => {
    for (const extra of [{}, { EDGE_ROUTES: ROUTES }, { COORDINATOR: { fetch: async () => new Response("coordinator") } }]) {
      const { env, homes } = cloud(extra);
      expect(await (await signedCall(env)).text()).toBe("from the home");
      expect(homes).toEqual([HOME]);
    }
  });

  it("answers a listed path from the coordinator without touching the home", async () => {
    const { env, homes } = cloud({ EDGE_ROUTES: ROUTES, COORDINATOR: { fetch: async () => new Response("coordinator") } });
    expect(await (await signedCall(env)).text()).toBe("coordinator");
    expect(homes).toEqual([]);
    const other = await worker.fetch(new Request(`https://${HOME}-home.later.dog/api/health`), env as never);
    expect(await other.text()).toBe("from the home");
  });
});
