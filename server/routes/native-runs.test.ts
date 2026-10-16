import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeRun } from "../../shared/native-runs.ts";
import { ensureNativeRuns, NativeRunStore } from "../laterdog/native-run-store.ts";
import { requiredScope } from "../request-auth.ts";
import { createNativeRunRoutes } from "./native-runs.ts";
import { PASS } from "./table.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  ensureNativeRuns(database);
  const store = new NativeRunStore({ read: fn => fn(database), write: fn => fn(database) });
  const run: NativeRun = { id: "run", threadId: "visible", turnId: "turn", provider: "codex", providerInstanceId: "owner", revision: 1, startedAt: 1000, state: "running", observation: "live", actors: [{ id: "codex:child:turn", kind: "subagent", label: "Research", state: "running", startedAt: 1000, nativeThreadId: "native-child", nativeTurnId: "native-turn", generation: "1", canStop: true }], activityCount: 0, failureCount: 0, limitations: [] };
  store.apply(run.id, "start", 1000, {}, () => ({ run }));
  const stop = vi.fn(async () => {});
  const route = createNativeRunRoutes({ store, visibleThreads: () => threadId => threadId === "visible", stop });
  const request = async (path: string, method = "GET", scopes: Array<"client" | "admin"> = ["client"]) => {
    let response: { status: number; body: unknown } | undefined;
    const url = new URL(path, "http://localhost");
    const handled = await route({ req: {} as IncomingMessage, res: {} as ServerResponse, url, path: url.pathname, method, auth: { kind: "loopback", scopes }, json: (_res, status, body) => { response = { status, body }; }, readBody: async () => ({}) });
    return { response, passed: handled === PASS };
  };
  return { store, run, stop, request };
}

describe("native work access", () => {
  it("assigns client scope only to explicit native activity endpoints", () => {
    for (const [method, path] of [["GET", "/api/helpers"], ["GET", "/api/threads/visible/runs"], ["GET", "/api/threads/visible/runs/run"], ["POST", "/api/threads/visible/runs/run/actors/codex%3Achild%3Aturn/stop"]]) {
      expect(requiredScope(method, path)).toBe("client");
    }
    expect(requiredScope("DELETE", "/api/threads/visible/runs/run")).toBe("admin");
  });

  it("never exposes a run across conversation visibility or identity boundaries", async () => {
    const { request } = fixture();
    expect((await request("/api/threads/hidden/runs")).response?.status).toBe(404);
    expect((await request("/api/threads/hidden/runs/run")).response?.status).toBe(404);
    expect((await request("/api/threads/visible/runs/missing")).response?.status).toBe(404);
    expect((await request("/api/threads/visible/runs")).response).toMatchObject({ status: 200, body: { runs: [{ id: "run" }] } });
    expect((await request("/api/threads/visible/runs/run")).response).toMatchObject({ status: 200, body: { run: { threadId: "visible" }, activities: [] } });
  });

  it("validates pagination and does not use another conversation's cursor", async () => {
    const { request, store, run } = fixture();
    store.apply("hidden", "start", 2000, {}, () => ({ run: { ...run, id: "hidden", threadId: "hidden" } }));
    expect((await request("/api/threads/visible/runs?limit=-1")).response?.status).toBe(400);
    expect((await request("/api/threads/visible/runs?limit=201")).response?.status).toBe(400);
    expect((await request("/api/threads/visible/runs?cursor=hidden")).response).toMatchObject({ status: 200, body: { runs: [] } });
    expect((await request("/api/threads/visible/runs/run?cursor=bad")).response?.status).toBe(404);
  });

  it("uses only stored actor identity and awaits native confirmation of Stop", async () => {
    const { request, stop, run, store } = fixture();
    const path = "/api/threads/visible/runs/run/actors/codex%3Achild%3Aturn/stop";
    expect((await request(path, "POST")).response).toEqual({ status: 202, body: { status: "requested" } });
    expect(stop).toHaveBeenCalledExactlyOnceWith(run, run.actors[0]);
    expect(store.get("run")?.actors[0].state).toBe("running");
    expect((await request(path, "POST", [])).response?.status).toBe(403);
    expect((await request(path.replace("visible", "hidden"), "POST")).response?.status).toBe(404);
    expect((await request(path.replace("codex%3Achild%3Aturn", "other"), "POST")).response?.status).toBe(404);
    expect((await request(path.replace("codex%3Achild%3Aturn", "%ZZ"), "POST")).response?.status).toBe(400);
    store.apply("run", "end", 2000, {}, current => ({ run: { ...current!, observation: "complete" } }));
    expect((await request(path, "POST")).response?.status).toBe(409);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports unsupported native control without pretending the helper stopped", async () => {
    const { request, stop, store } = fixture();
    stop.mockRejectedValueOnce(new Error("Native connection ended"));
    expect((await request("/api/threads/visible/runs/run/actors/codex%3Achild%3Aturn/stop", "POST")).response).toEqual({ status: 409, body: { error: "Native connection ended" } });
    expect(store.get("run")?.actors[0].state).toBe("running");
  });
});
