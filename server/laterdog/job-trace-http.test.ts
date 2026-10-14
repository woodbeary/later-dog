import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Server } from "node:http";
import { repositorySchema } from "../../shared/laterdog.ts";
import { WorkspaceStore } from "./store.ts";
import { Supervisor } from "./supervisor.ts";
import { createSupervisorServer } from "./http.ts";
import { dogToken } from "./dog-access.ts";
import { LocalTraceStore } from "./job-trace.ts";
import { callTool, MCP_TOOLS } from "./mcp.ts";

const resources: { server: Server; supervisor: Supervisor; store: WorkspaceStore; dir: string }[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const r of resources.splice(0)) { r.supervisor.stop(); await r.supervisor.drain(); await new Promise<void>((resolve) => r.server.close(() => resolve())); r.store.close(); rmSync(r.dir, { recursive: true, force: true }); }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-trace-http-")); const store = new WorkspaceStore(join(dir, "workspace.sqlite"));
  const local = new LocalTraceStore(join(dir, "traces"));
  const supervisor = new Supervisor(store, { dataDir: dir, profiles: [{ id: "cloud", label: "later.dog Cloud", backend: "laterdog-cloud", maxComputerSize: "large" }], concurrency: 4, publishingHost: "local", traces: { primary: local, local } });
  const token = "fixture-supervisor-token-".repeat(3);
  const server = createSupervisorServer(supervisor, token); resources.push({ server, supervisor, store, dir });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
  const origin = `http://127.0.0.1:${address.port}`;
  const get = (path: string, auth = token, extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${address.port}/v1${path}`, { headers: { authorization: `Bearer ${auth}`, ...extra } });
  store.saveRepository(repositorySchema.parse({ slug: "fixture/repo", environmentId: "none", environments: { "laterdog-cloud": "none" } }));
  const job = supervisor.create({ requestKey: randomUUID(), repository: "fixture/repo", title: "Traced", brief: "x", profileId: "cloud", botId: "dog-1" });
  const stored = await local.put(job.id, gzipSync(Buffer.from('{"type":"result"}\n')), { retentionDays: 30, truncated: false });
  store.touch(job.id, { trace: stored });
  return { token, store, job, get, origin, supervisor };
}

it("serves a kept trace to the person as a download, and not to a dog", async () => {
  const f = await fixture();
  const answer = await f.get(`/jobs/${f.job.id}/trace`);
  expect(answer.status).toBe(200);
  expect(answer.headers.get("content-type")).toMatch(/application\/x-ndjson/);
  expect(answer.headers.get("content-disposition")).toBe(`attachment; filename="laterdog-job-${f.job.id}-trace.jsonl"`);
  expect(answer.headers.get("x-laterdog-trace-truncated")).toBe("0");
  expect(await answer.text()).toBe('{"type":"result"}\n');
  expect((await f.get(`/jobs/${f.job.id}/trace`, "wrong")).status).toBe(401);
  const dog = dogToken(f.token, "dog-1");
  expect((await f.get(`/jobs/${f.job.id}/trace`, dog, { "x-laterdog-bot": "dog-1" })).status).toBe(403);
});

it("says plainly when there is no trace or it has expired", async () => {
  const f = await fixture();
  const other = f.store.create({ requestKey: randomUUID(), repository: "fixture/repo", title: "No trace", brief: "x", writeScopes: ["*"], dependencies: [], profileId: "cloud", kind: "implementation", standingInstructions: "" }, "laterdog-cloud");
  const none = await f.get(`/jobs/${other.id}/trace`);
  expect(none.status).toBe(404);
  expect((await none.json() as { error: string }).error).toMatch(/No trace/);
  f.store.touch(f.job.id, { trace: { ...f.store.job(f.job.id).trace!, expiresAt: "2026-01-01T00:00:00.000Z" } });
  const gone = await f.get(`/jobs/${f.job.id}/trace`);
  expect(gone.status).toBe(410);
  expect((await gone.json() as { error: string }).error).toMatch(/expired 2026-01-01/);
});

it("sends a delegation that names an account to the cloud profile signed in to it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-trace-http-")); const store = new WorkspaceStore(join(dir, "workspace.sqlite"));
  const supervisor = new Supervisor(store, { dataDir: dir, publishingHost: "local", concurrency: 4,
    profiles: [{ id: "one", label: "One", backend: "laterdog-cloud", account: "claude" }, { id: "two", label: "Two", backend: "laterdog-cloud", account: "claude-2" }] });
  const token = "fixture-supervisor-token-".repeat(3);
  const server = createSupervisorServer(supervisor, token); resources.push({ server, supervisor, store, dir });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No fixture address");
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/v1${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/repositories", { slug: "fixture/repo", environmentId: "none", environments: { "laterdog-cloud": "auto" } })).status).toBe(200);
  const made = await post("/jobs", { requestKey: randomUUID(), repository: "fixture/repo", title: "Second account", brief: "x", account: "claude-2", model: "claude-opus-5-5", effort: "high" });
  expect(made.status).toBe(202);
  expect(await made.json()).toMatchObject({ profileId: "two", account: "claude-2", model: "claude-opus-5-5", effort: "high" });
  const defaulted = await post("/jobs", { requestKey: randomUUID(), repository: "fixture/repo", title: "No account", brief: "x" });
  expect(await defaulted.json()).toMatchObject({ profileId: "one" });
});

it("gives a delegation its dog's own model, effort and account unless the tool asks for others", async () => {
  const f = await fixture();
  vi.stubEnv("LATERDOG_MODEL", "claude-opus-5-5");
  vi.stubEnv("LATERDOG_EFFORT", "high");
  vi.stubEnv("LATERDOG_ACCOUNT", "claude");
  const brief = { requestKey: randomUUID(), repository: "fixture/repo", title: "Defaults", brief: "x", writeScopes: ["src"], profileId: "cloud" };
  const inherited = await callTool("delegate_cloud_job", brief, f.origin, f.token) as { id: string };
  expect(f.store.job(inherited.id)).toMatchObject({ model: "claude-opus-5-5", effort: "high", account: "claude" });
  const chosen = await callTool("delegate_cloud_job", { ...brief, requestKey: randomUUID(), model: "claude-haiku-5-5", effort: "low", computerSize: "large" }, f.origin, f.token) as { id: string };
  expect(f.store.job(chosen.id)).toMatchObject({ model: "claude-haiku-5-5", effort: "low", account: "claude", computerSize: "large" });
  expect(MCP_TOOLS.find((tool) => tool.name === "delegate_cloud_job")?.description).toMatch(/computerSize.*defaults to small/);
  const schema = JSON.stringify(MCP_TOOLS.find((tool) => tool.name === "delegate_cloud_job")?.inputSchema);
  for (const field of ["model", "effort", "account", "computerSize"]) expect(schema).toContain(`"${field}"`);
});
