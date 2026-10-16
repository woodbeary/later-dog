import { afterEach, describe, expect, it, vi } from "vitest";
import { appSiteAssociation } from "../../../../shared/apple-app";
import { ComputersApi } from "../src/index";
import { route } from "../src/routes";
import { ORIGIN, body, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const ASSOCIATION = "/.well-known/apple-app-site-association";

describe("the app-site association on cloud.later.dog", () => {
  it("is routed for every method so the answer decides what is allowed", () => {
    expect(route("GET", ASSOCIATION)).toEqual({ kind: "app_site_association" });
    expect(route("HEAD", ASSOCIATION)).toEqual({ kind: "app_site_association" });
    expect(route("GET", `${ASSOCIATION}/`)).toEqual({ kind: "not_found", api: false });
  });

  it("answers with no key, no redirect and no sign-in, and claims no pages", async () => {
    const w = await world();
    const response = await w.fetch(new Request(`${ORIGIN}${ASSOCIATION}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await body(response)).toEqual(appSiteAssociation("service"));
    const head = await w.fetch(new Request(`${ORIGIN}${ASSOCIATION}`, { method: "HEAD" }));
    expect(head.status).toBe(200);
    const post = await w.fetch(new Request(`${ORIGIN}${ASSOCIATION}`, { method: "POST" }));
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("is not an endpoint of the service binding the Cloud homes call", async () => {
    const w = await world();
    const api = new ComputersApi({} as ExecutionContext, w.env as unknown as Env);
    expect((await api.fetch(new Request(`${ORIGIN}${ASSOCIATION}`))).status).toBe(404);
  });
});
