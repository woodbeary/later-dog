import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import { ComputersApi } from "../src/index";
import { ORIGIN, OWNER_KEY, type World, apiRequest, body, trialKey, world } from "./fakes";

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
  vi.unstubAllGlobals();
});

function binding(w: World): ComputersApi {
  return new ComputersApi({} as ExecutionContext, w.env as unknown as Env);
}

function unkeyed(method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body === undefined) return new Request(`${ORIGIN}${path}`, { method, headers });
  return new Request(`${ORIGIN}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(options.body) });
}

describe("the ComputersApi service-binding entrypoint", () => {
  it("serves the API without a key, sharing the owner's computers with the public route", async () => {
    const w = await world();
    const api = binding(w);
    expect(await body(await api.fetch(unkeyed("GET", "/v1/computers")))).toEqual({ computers: [] });

    const created = await api.fetch(unkeyed("POST", "/v1/computers", { body: { name: "Worker", size: "xlarge" } }));
    expect(created.status).toBe(201);
    const { computer } = await body(created);
    expect(computer).toMatchObject({ name: "Worker", size: "xlarge", state: "starting" });
    await w.advance(MINUTE);

    const ran = await api.fetch(unkeyed("POST", `/v1/computers/${computer.id}/exec`, { body: { command: "true", env: { TOKEN: "t" } } }));
    expect(ran.status).toBe(200);
    expect(await body(ran)).toEqual({ exitCode: 0, stdout: "", stderr: "", timedOut: false });

    const publicList = await w.fetch(apiRequest("GET", "/v1/computers", OWNER_KEY));
    expect((await body(publicList)).computers).toMatchObject([{ id: computer.id, state: "running" }]);
  });

  it("ignores any Authorization header, so a wrong or trial key changes nothing", async () => {
    const w = await world();
    const api = binding(w);
    for (const authorization of ["Bearer ldc_wrong", `Bearer ${trialKey("a")}`, "nonsense"]) {
      const response = await api.fetch(unkeyed("GET", "/v1/computers", { headers: { authorization } }));
      expect(response.status, authorization).toBe(200);
    }
  });

  it("works when the public key secret is not set", async () => {
    const w = await world({ COMPUTERS_KEY_SHA256: "" });
    expect((await binding(w).fetch(unkeyed("GET", "/v1/computers"))).status).toBe(200);
    expect((await w.fetch(apiRequest("GET", "/v1/computers", OWNER_KEY))).status).toBe(503);
  });

  it("refuses requests with an Origin header", async () => {
    const w = await world();
    const api = binding(w);
    for (const request of [
      unkeyed("GET", "/v1/computers", { headers: { origin: ORIGIN } }),
      unkeyed("POST", "/v1/computers", { headers: { origin: "https://evil.example" }, body: {} }),
      unkeyed("GET", "/v1/trials", { headers: { origin: ORIGIN } }),
    ]) {
      const response = await api.fetch(request);
      expect(response.status).toBe(403);
      expect((await body(response)).error.code).toBe("browser_origin");
    }
    expect((await body(await api.fetch(unkeyed("GET", "/v1/computers")))).computers).toEqual([]);
  });

  it("serves only the API: no desktop links, trial page or redirects", async () => {
    const w = await world();
    const api = binding(w);
    for (const path of ["/desktop/cmp_abcdefghij23/1800007200.AAAA/", "/trial?claim=00", "/"]) {
      const response = await api.fetch(unkeyed("GET", path));
      expect(response.status, path).toBe(404);
      expect((await body(response)).error.code, path).toBe("not_found");
    }
    expect((await api.fetch(unkeyed("GET", "/v1/trial"))).status).toBe(404);
  });

  it("signs desktop links for the request URL's origin", async () => {
    const w = await world();
    const api = binding(w);
    const { computer } = await body(await api.fetch(unkeyed("POST", "/v1/computers", { body: {} })));
    await w.advance(MINUTE);
    const link = await body(await api.fetch(unkeyed("POST", `/v1/computers/${computer.id}/desktop`)));
    expect(link.url.startsWith(`${ORIGIN}/desktop/${computer.id}/`)).toBe(true);
  });
});

describe("the public route", () => {
  it("still requires the key", async () => {
    const w = await world();
    const missing = await w.fetch(unkeyed("GET", "/v1/computers"));
    expect(missing.status).toBe(401);
    expect((await body(missing)).error.code).toBe("unauthorized");
    const wrong = await w.fetch(apiRequest("GET", "/v1/computers", "ldc_wrong"));
    expect(wrong.status).toBe(401);
    const exec = await w.fetch(unkeyed("POST", "/v1/computers/cmp_abcdefghij23/exec", { body: { command: "true" } }));
    expect(exec.status).toBe(401);
    expect((await w.fetch(apiRequest("GET", "/v1/computers", OWNER_KEY))).status).toBe(200);
  });
});
