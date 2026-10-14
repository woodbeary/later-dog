import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { requiredScope } from "../request-auth.ts";
import { createJobTraceRoutes } from "./job-trace.ts";
import { createLaterDogRoutes } from "./laterdog.ts";
import { dispatchRoutes } from "./table.ts";

const JOB = "5f2d8c0e-1111-4222-8333-444455556666";
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(upstream: typeof fetch) {
  vi.stubEnv("LATERDOG_SUPERVISOR_URL", "https://supervisor.fixture.test");
  vi.stubEnv("LATERDOG_TOKEN", "t".repeat(40));
  const routes = [createJobTraceRoutes(upstream), createLaterDogRoutes()];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("downloading a cloud job's trace through the desktop", () => {
  it("asks the supervisor with the desktop's token and hands the person the file", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const upstream = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response('{"type":"result"}\n', { status: 200, headers: { "content-disposition": `attachment; filename="laterdog-job-${JOB}-trace.jsonl"` } });
    }) as unknown as typeof fetch;
    const base = await serve(upstream);
    const answer = await fetch(`${base}/api/laterdog/jobs/${JOB}/trace`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-disposition")).toBe(`attachment; filename="laterdog-job-${JOB}-trace.jsonl"`);
    expect(answer.headers.get("content-type")).toMatch(/x-ndjson/);
    expect(await answer.text()).toBe('{"type":"result"}\n');
    expect(calls).toEqual([{ url: `https://supervisor.fixture.test/v1/jobs/${JOB}/trace`, auth: `Bearer ${"t".repeat(40)}` }]);
  });

  it("passes the supervisor's reason through when there is nothing to download", async () => {
    const upstream = (async () => Response.json({ error: "This job's trace expired 2026-01-01." }, { status: 410 })) as unknown as typeof fetch;
    const answer = await fetch(`${await serve(upstream)}/api/laterdog/jobs/${JOB}/trace`);
    expect(answer.status).toBe(410);
    expect(await answer.json()).toEqual({ error: "This job's trace expired 2026-01-01." });
  });

  it("streams the trace through and cuts the download off when the supervisor's stream breaks, never ending it as if whole", async () => {
    const upstream = (async () => {
      let sent = false;
      return new Response(new ReadableStream({
        pull(controller) {
          if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('{"n":1}\n')); return; }
          controller.error(new Error("supervisor went away"));
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const base = await serve(upstream);
    await expect((async () => (await fetch(`${base}/api/laterdog/jobs/${JOB}/trace`)).text())()).rejects.toThrow();
  });

  it("only answers its own path, and only to a GET", async () => {
    const base = await serve((async () => new Response("never")) as unknown as typeof fetch);
    expect((await fetch(`${base}/api/laterdog/jobs/${JOB}/trace`, { method: "POST", body: "{}" })).status).toBe(405);
    expect((await fetch(`${base}/api/laterdog/jobs/not-a-job/trace`)).status).toBe(404);
    expect((await fetch(`${base}/api/laterdog/jobs/${JOB}/trace/extra`)).status).toBe(404);
  });

  it("is a person-only route: phones and other clients do not get it", () => {
    expect(requiredScope("GET", `/api/laterdog/jobs/${JOB}/trace`)).toBe("admin");
  });

  it("reports an unreachable supervisor as unavailable", async () => {
    const upstream = (async () => { throw new Error("refused"); }) as unknown as typeof fetch;
    expect((await fetch(`${await serve(upstream)}/api/laterdog/jobs/${JOB}/trace`)).status).toBe(503);
  });
});
