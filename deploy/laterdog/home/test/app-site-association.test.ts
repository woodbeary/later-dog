import { describe, expect, it, vi } from "vitest";
import { appSiteAssociation } from "../../../../shared/apple-app.ts";

vi.mock("cloudflare:workers", async () => await import("./fake-containers.ts"));
vi.mock("@cloudflare/containers", async () => await import("./fake-containers.ts"));

const { default: worker } = await import("../src/index.ts");

const MACHINE = `h${"0123456789abcdef01234567"}`;
const SUFFIX = "-home.later.dog";
const ASSOCIATION = "/.well-known/apple-app-site-association";

function untouchedHomes() {
  const touched: string[] = [];
  const refuse = (name: string) => () => {
    touched.push(name);
    throw new Error(`${name} must not be touched`);
  };
  const namespace = { get: refuse("get"), idFromName: refuse("idFromName") };
  const env = { HOME_HOST_SUFFIX: SUFFIX, HOME_SECRET: "secret", LARGE_HOME_ACCOUNTS: "", HOMES: namespace, HOMES_LARGE: namespace };
  return { env, touched };
}

const visit = (host: string, path: string, init?: RequestInit) => new Request(`https://${host}${path}`, init);

describe("the home Worker's app-site association", () => {
  it("answers Apple from the Worker itself, so asking never wakes a home or needs a sign-in", async () => {
    const { env, touched } = untouchedHomes();
    const response = await worker.fetch(visit(`${MACHINE}${SUFFIX}`, ASSOCIATION), env as never);
    expect(response.status).toBe(200);
    expect(response.redirected).toBe(false);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual(appSiteAssociation("home"));
    expect(touched).toEqual([]);
  });

  it("answers a HEAD the same way", async () => {
    const { env, touched } = untouchedHomes();
    const head = await worker.fetch(visit(`${MACHINE}${SUFFIX}`, ASSOCIATION, { method: "HEAD" }), env as never);
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/json");
    expect(touched).toEqual([]);
  });

  it("still sends every other path to the home, and refuses an address that is not a home's", async () => {
    const { env, touched } = untouchedHomes();
    await expect(worker.fetch(visit(`${MACHINE}${SUFFIX}`, "/api/health"), env as never)).rejects.toThrow("must not be touched");
    expect(touched.length).toBeGreaterThan(0);
    const stranger = await worker.fetch(visit("example.later.dog", ASSOCIATION), env as never);
    expect(stranger.status).toBe(404);
  });
});
