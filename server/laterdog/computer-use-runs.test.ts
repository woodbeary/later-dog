import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagesReply } from "./computer-use-anthropic.ts";
import { FakeDesktop, finished, fixedPageCheck, ScriptedMessages, toolUse, reply, type ScriptedReply } from "./computer-use-fakes.ts";
import { ComputerUseRuns, computerUseRunsFromEnvironment } from "./computer-use-runs.ts";
import { ComputerUseStore } from "./computer-use-store.ts";
import { CODEX_CLOUD_CAPABILITIES, type ExecutionAdapter } from "./codex-cloud.ts";
import { DOG_HEADER, dogToken } from "./dog-access.ts";
import { GitHubPublisher } from "./github.ts";
import { createSupervisorServer } from "./http.ts";
import { WorkspaceStore } from "./store.ts";
import { Supervisor } from "./supervisor.ts";

const TOKEN = "fixture-admin-token-".repeat(3);
const START = { task: "Send the interpreter request for Tuesday", computerId: "cmp_fixture12345", done: { pageCheck: null } };
const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of resources.splice(0)) await close(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(engine: ((db: DatabaseSync) => ComputerUseRuns) | "none") {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-computer-use-"));
  const store = new WorkspaceStore(join(dir, "workspace.sqlite"));
  const adapter = { capabilities: CODEX_CLOUD_CAPABILITIES, submit: vi.fn(), inspect: vi.fn(), collect: vi.fn(), list: vi.fn(async () => ({ tasks: [] })),
    doctor: vi.fn(async () => ({ version: "fixture", authenticated: true, cloudCommands: "fixture" })),
    login: vi.fn(async () => ({ started: true, instructions: "fixture", startedAt: new Date().toISOString() })) } satisfies ExecutionAdapter;
  const publisher = new GitHubPublisher(join(dir, "checkouts"), async () => { throw new Error("fixture: no command may run"); });
  const supervisor = new Supervisor(store, { dataDir: dir, profiles: [{ id: "default", label: "Fixture" }], concurrency: 1, publishingHost: "local", adapter: () => adapter, publisher });
  const runs = engine === "none" ? undefined : engine(store.db);
  const server: Server = createSupervisorServer(supervisor, TOKEN, runs);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  resources.push(async () => {
    await runs?.drain();
    supervisor.stop(); await supervisor.drain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address");
  const send = async (method: string, path: string, body: unknown, headers: Record<string, string>) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/v1${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  return {
    runs: runs!,
    admin: (method: string, path: string, body?: unknown) => send(method, path, body, { authorization: `Bearer ${TOKEN}` }),
    dog: (method: string, path: string, body?: unknown) => send(method, path, body, { authorization: `Bearer ${dogToken(TOKEN, "bot-1")}`, [DOG_HEADER]: "bot-1" }),
  };
}

const engineWith = (replies: ScriptedReply[]) => (db: DatabaseSync) => new ComputerUseRuns(new ComputerUseStore(db), {
  messages: new ScriptedMessages(replies), desktop: () => new FakeDesktop(), pageCheck: fixedPageCheck({ passed: false, detail: "fixture" }),
  sleep: async () => {},
});

describe("computer-use runs on the supervisor", () => {
  it("starts a run for the person, logs it, and lets only the person say it is done", async () => {
    const f = await fixture(engineWith([reply([toolUse("toolu_1", "left_click", { coordinate: [640, 400] })]), finished("Sent the request.")]));
    const started = await f.admin("POST", "/computer-runs", START);
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({ state: "running", model: "claude-opus-5-5", done: { pageCheck: null } });
    const id = started.body.run.id as string;
    await f.runs.finished(id);
    const view = await f.admin("GET", `/computer-runs/${id}`);
    expect(view.body.run).toMatchObject({ state: "awaiting_done", doneSource: null });
    expect(view.body.steps).toHaveLength(2);
    expect(view.body.steps[0]).toMatchObject({ step: 1, actions: [{ name: "left_click", coordinate: [640, 400] }], screenshotSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await f.admin("POST", `/computer-runs/${id}/done`)).body.run).toMatchObject({ state: "done", doneSource: "person" });
    const again = await f.admin("POST", `/computer-runs/${id}/done`);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("This run already ended (done).");
    expect((await f.admin("GET", "/computer-runs")).body.runs).toHaveLength(1);
  });

  it("refuses every computer-use route to a dog, so no agent can mark its own run done", async () => {
    const f = await fixture(engineWith([finished("Done.")]));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    await f.runs.finished(id);
    for (const [method, path] of [["POST", "/computer-runs"], ["GET", "/computer-runs"], ["GET", `/computer-runs/${id}`], ["POST", `/computer-runs/${id}/done`], ["POST", `/computer-runs/${id}/take-over`]] as const) {
      const refused = await f.dog(method, path, method === "POST" ? START : undefined);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(refused.body.error).toBe("Only the person starts a computer-use run, takes over its screen, or says whether it is done, in the later.dog app; a dog cannot.");
    }
    expect((await f.admin("GET", `/computer-runs/${id}`)).body.run.state).toBe("awaiting_done");
  });

  it("logs the person taking over with a cause, hands back, and records not done", async () => {
    const first = deferred<MessagesReply>();
    const f = await fixture(engineWith([() => first.promise, finished("Done.")]));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    const taken = await f.admin("POST", `/computer-runs/${id}/take-over`, { cause: "captcha", note: "The portal showed a CAPTCHA" });
    expect(taken.body.run.state).toBe("handed_over");
    expect((await f.admin("POST", `/computer-runs/${id}/take-over`, {})).status).toBe(409);
    expect((await f.admin("POST", `/computer-runs/${id}/hand-back`)).body.run.state).toBe("running");
    first.resolve(reply([toolUse("toolu_1", "screenshot")]));
    await f.runs.finished(id);
    expect((await f.admin("POST", `/computer-runs/${id}/not-done`)).body.run).toMatchObject({ state: "failed", failure: "not_done" });
    expect((await f.admin("GET", `/computer-runs/${id}`)).body.handoffs).toEqual([
      expect.objectContaining({ number: 1, cause: "captcha", askedBy: "person", note: "The portal showed a CAPTCHA", returnedAt: expect.any(String) }),
    ]);
  });

  it("stops a run on request", async () => {
    const first = deferred<MessagesReply>();
    const f = await fixture(engineWith([() => first.promise]));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    expect((await f.admin("POST", `/computer-runs/${id}/stop`)).body.run).toMatchObject({ state: "failed", failure: "stopped" });
    first.resolve(finished("Done."));
    expect((await f.runs.finished(id)).failure).toBe("stopped");
  });

  it("checks what it is given", async () => {
    const f = await fixture(engineWith([]));
    expect((await f.admin("POST", "/computer-runs", { ...START, done: undefined })).status).toBe(400);
    expect((await f.admin("POST", "/computer-runs", { ...START, computerId: "not a computer" })).status).toBe(400);
    expect((await f.admin("POST", "/computer-runs/not-a-uuid/done")).status).toBe(400);
    expect((await f.admin("GET", "/computer-runs/6f9619ff-8b86-4011-b42d-00cf4fc964ff")).status).toBe(404);
  });

  it("says plainly when computer use is not set up", async () => {
    const none = await fixture("none");
    expect(await none.admin("POST", "/computer-runs", START)).toEqual({ status: 409, body: { error: "Computer-use runs are not set up on this supervisor." } });
    const noKey = await fixture((db) => computerUseRunsFromEnvironment(db, {}));
    expect(await noKey.admin("POST", "/computer-runs", START)).toEqual({ status: 409, body: { error: "Claude computer use needs ANTHROPIC_API_KEY in the supervisor's environment." } });
    const badKey = await fixture((db) => computerUseRunsFromEnvironment(db, { ANTHROPIC_API_KEY: "sk-ant-api03-" + "f".repeat(40), LATERDOG_COMPUTERS_KEY: "nope" }));
    expect((await badKey.admin("POST", "/computer-runs", START)).body.error).toBe("LATERDOG_COMPUTERS_KEY does not hold a later.dog computers key (they start with ldc_)");
  });
});
