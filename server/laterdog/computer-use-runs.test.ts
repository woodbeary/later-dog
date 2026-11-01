import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessagesReply } from "./computer-use-anthropic.ts";
import { FakeDesktop, finished, FIXTURE_VIEWER, fixedPageCheck, ScriptedMessages, ScriptedScreenChecks, toolUse, reply, type ScriptedReply } from "./computer-use-fakes.ts";
import { ComputerUseRuns, computerUseRunsFromEnvironment, screenChecksSwitch, takeoverNotification } from "./computer-use-runs.ts";
import type { PhonePush } from "./phone-push.ts";
import { ComputerUseStore } from "./computer-use-store.ts";
import { CODEX_CLOUD_CAPABILITIES, type ExecutionAdapter } from "./codex-cloud.ts";
import { DOG_HEADER, dogToken } from "./dog-access.ts";
import { GitHubPublisher } from "./github.ts";
import { createSupervisorServer } from "./http.ts";
import { WorkspaceStore } from "./store.ts";
import { Supervisor } from "./supervisor.ts";

const TOKEN = "fixture-admin-token-".repeat(3);
const DEAD_ENDS = { LATERDOG_COMPUTERS_URL: "http://127.0.0.1:9/v1", LATERDOG_ANTHROPIC_URL: "http://127.0.0.1:9/v1/messages" };
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

function fakePhone() {
  const sent: Parameters<PhonePush["send"]>[0][] = [];
  const tokens: string[] = [];
  const phone: PhonePush = {
    register: (token) => { tokens.push(token); return true; }, unregister: () => {}, tokens: () => tokens,
    send: async (notification) => { sent.push(notification); },
  };
  return { phone, sent, tokens };
}

const engineWith = (replies: ScriptedReply[], phone?: PhonePush) => (db: DatabaseSync) => new ComputerUseRuns(new ComputerUseStore(db), {
  messages: new ScriptedMessages(replies), desktop: () => new FakeDesktop(), pageCheck: fixedPageCheck({ passed: false, detail: "fixture" }),
  sleep: async () => {},
}, phone ? { phone } : {});

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
    expect(taken.body.handoff).toMatchObject({ number: 1, viewerUrl: FIXTURE_VIEWER.url, viewerExpiresAt: FIXTURE_VIEWER.expiresAt });
    expect((await f.admin("GET", `/computer-runs/${id}`)).body.handoffs[0]).toMatchObject({ viewerUrl: FIXTURE_VIEWER.url });
    expect((await f.admin("POST", `/computer-runs/${id}/take-over`, {})).status).toBe(409);
    expect((await f.admin("POST", `/computer-runs/${id}/hand-back`)).body.run.state).toBe("running");
    first.resolve(reply([toolUse("toolu_1", "screenshot")]));
    await f.runs.finished(id);
    expect((await f.admin("POST", `/computer-runs/${id}/not-done`)).body.run).toMatchObject({ state: "failed", failure: "not_done" });
    expect((await f.admin("GET", `/computer-runs/${id}`)).body.handoffs).toEqual([
      expect.objectContaining({ number: 1, cause: "captcha", askedBy: "person", note: "The portal showed a CAPTCHA", returnedAt: expect.any(String), viewerUrl: null }),
    ]);
  });

  it("pushes every take-over to the person's phone without the viewer link, and takes phone tokens on its own route", async () => {
    const first = deferred<MessagesReply>();
    const phone = fakePhone();
    const f = await fixture(engineWith([() => first.promise, finished("Done.")], phone.phone));
    const token = "ExponentPushToken[fixture-token-123]";
    expect(await f.admin("POST", "/computer-runs/phone-push", { token })).toEqual({ status: 200, body: { ok: true } });
    expect(phone.tokens).toEqual([token]);
    expect((await f.dog("POST", "/computer-runs/phone-push", { token })).status).toBe(403);
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    await f.admin("POST", `/computer-runs/${id}/take-over`, { cause: "sign-in", note: "Sign in to the portal" });
    expect(phone.sent).toEqual([{ kind: "takeover", botId: "", botName: "later.dog", threadId: "", computerRunId: id,
      title: "Computer use needs your hands", body: "You took the screen: Sign in to the portal. Open later.dog to see the screen." }]);
    expect(JSON.stringify(phone.sent)).not.toContain(FIXTURE_VIEWER.url);
    await f.admin("POST", `/computer-runs/${id}/hand-back`);
    first.resolve(finished("Done."));
    await f.runs.finished(id);
  });

  it("words a take-over Claude asked for by its cause", () => {
    const handoff = { number: 1, at: "2026-11-01T10:00:00.000Z", cause: "captcha" as const, askedBy: "model" as const, note: "Solve the CAPTCHA",
      returnedAt: null, viewerUrl: FIXTURE_VIEWER.url, viewerExpiresAt: FIXTURE_VIEWER.expiresAt, probability: null };
    expect(takeoverNotification({ runId: "run-1", task: "x", handoff }).body).toBe("It needs a CAPTCHA: Solve the CAPTCHA. Open later.dog to see the screen.");
  });

  it("takes the person's approval with the hand-back, and refuses anything else in its body", async () => {
    const first = deferred<MessagesReply>();
    const f = await fixture(engineWith([() => first.promise, finished("Done.")]));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    await f.admin("POST", `/computer-runs/${id}/take-over`, {});
    expect((await f.admin("POST", `/computer-runs/${id}/hand-back`, { approve: "yes" })).status).toBe(400);
    expect((await f.admin("POST", `/computer-runs/${id}/hand-back`, { approve: true, extra: 1 })).status).toBe(400);
    expect((await f.admin("POST", `/computer-runs/${id}/hand-back`, { approve: true })).body.run.state).toBe("running");
    first.resolve(finished("Done."));
    await f.runs.finished(id);
  });

  it("runs a guarded click only after the person approves it on the hand-back route", async () => {
    const desktop = new FakeDesktop();
    const f = await fixture((db) => new ComputerUseRuns(new ComputerUseStore(db), {
      messages: new ScriptedMessages([reply([toolUse("toolu_1", "left_click", { coordinate: [900, 700] })]), finished("Sent.")]),
      desktop: () => desktop, pageCheck: fixedPageCheck({ passed: false, detail: "fixture" }), sleep: async () => {},
      screenChecks: new ScriptedScreenChecks({ irreversible: () => 0.9, confirmed: () => 0.9 }),
    }));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    let view = await f.admin("GET", `/computer-runs/${id}`);
    for (let tries = 0; view.body.run.state !== "handed_over" && tries < 200; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      view = await f.admin("GET", `/computer-runs/${id}`);
    }
    expect(view.body.handoffs[0]).toMatchObject({ cause: "confirm", askedBy: "guard", viewerUrl: FIXTURE_VIEWER.url });
    expect(desktop.acted).toEqual([]);
    await f.admin("POST", `/computer-runs/${id}/hand-back`, { approve: true });
    expect((await f.runs.finished(id)).state).toBe("awaiting_done");
    expect(desktop.acted).toEqual([{ kind: "click", button: "left", count: 1, at: [900, 700], modifiers: [] }]);
  });

  it("takes the person's Secure Form values on its own route, never echoes them, and pushes the request to the phone", async () => {
    const phone = fakePhone();
    const form = { title: "Sign in to the clinic portal", site: "portal.clinic.example", fields: [{ id: "email", label: "Email", type: "email" }, { id: "password", label: "Password", type: "password" }] };
    const f = await fixture(engineWith([reply([{ type: "tool_use", id: "toolu_1", name: "request_secure_form", input: form }]), finished("Signed in.")], phone.phone));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    let view = await f.admin("GET", `/computer-runs/${id}`);
    for (let tries = 0; !view.body.form && tries < 200; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      view = await f.admin("GET", `/computer-runs/${id}`);
    }
    const formId = view.body.form.formId as string;
    expect(view.body.form).toMatchObject({ title: form.title, host: form.site, status: "open" });
    expect(phone.sent.at(-1)).toMatchObject({ computerRunId: id, title: "Computer use needs your details", body: "Sign in to the clinic portal (portal.clinic.example). Open later.dog to fill in the Secure Form." });
    expect((await f.dog("POST", `/computer-runs/${id}/secure-form`, { formId, values: { email: "a@b.example", password: "x" } })).status).toBe(403);
    expect((await f.admin("POST", `/computer-runs/${id}/secure-form`, { formId: "form_0000000000000000", values: {} })).status).toBe(404);
    expect((await f.admin("POST", `/computer-runs/${id}/secure-form`, { formId, values: { email: "jacob@example.com" } }))).toEqual({ status: 400, body: { error: "Fill in every field." } });
    const sent = await f.admin("POST", `/computer-runs/${id}/secure-form`, { formId, values: { email: "jacob@example.com", password: "fixture-secret-123" } });
    expect(sent.status).toBe(200);
    expect(sent.body.form).toMatchObject({ formId, status: "filled" });
    expect(JSON.stringify(sent.body)).not.toContain("fixture-secret-123");
    expect((await f.runs.finished(id)).state).toBe("awaiting_done");
    const after = await f.admin("GET", `/computer-runs/${id}`);
    expect(after.body.form).toBeNull();
    expect(after.body.steps[0].actions).toEqual([{ name: "request_secure_form", fields: 2, outcome: "filled" }]);
    expect((await f.admin("POST", `/computer-runs/${id}/secure-form`, { formId, cancel: true })).status).toBe(409);
  });

  it("lets the person label a step's failure class, and not a dog", async () => {
    const f = await fixture(engineWith([reply([toolUse("toolu_1", "left_click", { coordinate: [640, 400] })]), finished("Sent the request.")]));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    await f.runs.finished(id);
    expect((await f.admin("POST", `/computer-runs/${id}/steps/1/failure-class`, { failureClass: "wrong_field" })).body.step).toMatchObject({ step: 1, failureClass: "wrong_field" });
    expect((await f.admin("POST", `/computer-runs/${id}/steps/1/failure-class`, { failureClass: "cosmic_rays" })).status).toBe(400);
    expect((await f.admin("POST", `/computer-runs/${id}/steps/9/failure-class`, { failureClass: null })).status).toBe(404);
    expect((await f.dog("POST", `/computer-runs/${id}/steps/1/failure-class`, { failureClass: null })).status).toBe(403);
    expect((await f.admin("GET", `/computer-runs/${id}`)).body.steps[0].failureClass).toBe("wrong_field");
  });

  it("stops a run on request", async () => {
    const first = deferred<MessagesReply>();
    const f = await fixture(engineWith([() => first.promise]));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    expect((await f.admin("POST", `/computer-runs/${id}/stop`)).body.run).toMatchObject({ state: "failed", failure: "stopped" });
    first.resolve(finished("Done."));
    expect((await f.runs.finished(id)).failure).toBe("stopped");
  });

  it("runs one computer-use run at a time on a computer", async () => {
    const first = deferred<MessagesReply>();
    const f = await fixture(engineWith([() => first.promise, finished("Done."), finished("Done.")]));
    const id = (await f.admin("POST", "/computer-runs", START)).body.run.id as string;
    const second = await f.admin("POST", "/computer-runs", START);
    expect(second).toEqual({ status: 409, body: { error: "Another computer-use run is going on that computer; stop it, or wait for it to end, before starting one there." } });
    expect((await f.admin("POST", "/computer-runs", { ...START, computerId: "cmp_fixture67890" })).status).toBe(202);
    await f.admin("POST", `/computer-runs/${id}/stop`);
    first.resolve(finished("Done."));
    await f.runs.finished(id);
    expect((await f.admin("POST", "/computer-runs", START)).status).toBe(202);
  });

  it("checks what it is given", async () => {
    const f = await fixture(engineWith([]));
    expect((await f.admin("POST", "/computer-runs", { ...START, done: undefined })).status).toBe(400);
    expect((await f.admin("POST", "/computer-runs", { ...START, computerId: "not a computer" })).status).toBe(400);
    expect((await f.admin("POST", "/computer-runs/not-a-uuid/done")).status).toBe(400);
    expect((await f.admin("GET", "/computer-runs/6f9619ff-8b86-4011-b42d-00cf4fc964ff")).status).toBe(404);
  });

  it("turns screen checks on only when asked, and keeps that on the run", async () => {
    expect(screenChecksSwitch(undefined)).toBe(false);
    expect(screenChecksSwitch(" off ")).toBe(false);
    expect(screenChecksSwitch("ON")).toBe(true);
    expect(() => screenChecksSwitch("yes")).toThrow("on or off");
    const key = "sk-ant-api03-" + "f".repeat(40);
    const off = await fixture((db) => computerUseRunsFromEnvironment(db, { ANTHROPIC_API_KEY: key, ...DEAD_ENDS }));
    const id = (await off.admin("POST", "/computer-runs", START)).body.run.id as string;
    expect((await off.admin("GET", `/computer-runs/${id}`)).body.run.screenChecks).toBe(false);
    await off.admin("POST", `/computer-runs/${id}/stop`);
    const on = await fixture((db) => computerUseRunsFromEnvironment(db, { ANTHROPIC_API_KEY: key, ...DEAD_ENDS, LATERDOG_SCREEN_CHECKS: "on" }));
    const checked = await on.admin("POST", "/computer-runs", START);
    expect(checked.body.run.screenChecks).toBe(true);
    await on.admin("POST", `/computer-runs/${checked.body.run.id}/stop`);
    const wrong = await fixture((db) => computerUseRunsFromEnvironment(db, { ANTHROPIC_API_KEY: key, ...DEAD_ENDS, LATERDOG_SCREEN_CHECKS: "maybe" }));
    expect((await wrong.admin("POST", "/computer-runs", START)).body.error).toBe("LATERDOG_SCREEN_CHECKS is on or off.");
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
