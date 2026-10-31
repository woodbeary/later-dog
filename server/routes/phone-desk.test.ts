import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import { PhoneDesk, type PhoneJobKind } from "../laterdog/phone-desk.ts";
import { requestGone } from "../laterdog/request-gone.ts";
import { requiredScope, type RequestAuth } from "../request-auth.ts";
import type { BotRecord } from "../store.ts";
import { dispatchInternalRoutes } from "./internal.ts";
import { createPhoneDeviceRoutes, createPhoneToolRoute, PHONE_SECRET_HEADER } from "./phone-desk.ts";
import { dispatchRoutes } from "./table.ts";

const PHONE = "4f6f5c1e-2d4a-4f5b-8c7d-9e0f1a2b3c4d";
const SECRET = "c".repeat(64);
const OWNER = { session: "phone-session", person: "cloud-home" };
const SENDER = { id: "dog-1", name: "Olive" } as BotRecord;
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => { server.closeAllConnections(); server.close(done); })));
});

async function serve(options: { owner?: ReturnType<Parameters<typeof createPhoneDeviceRoutes>[0]["owner"]> } = {}) {
  const desk = new PhoneDesk(() => true, { pollMs: 2_000, jobMs: 5_000 });
  const asked: PhoneJobKind[] = [];
  const routes = [createPhoneDeviceRoutes({ desk, enabled: () => true, owner: () => options.owner ?? OWNER, gone: requestGone })];
  const internal = [createPhoneToolRoute({
    enabled: () => true,
    active: () => true,
    request: (job, _capability, sender) => desk.request("cloud-home", job, () => true, (kind) => { asked.push(kind); expect(sender.name).toBe("Olive"); }, 200),
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const auth = { kind: "session", scopes: ["admin"] } as unknown as RequestAuth;
    if (await dispatchRoutes(routes, { req, res, url, path: url.pathname, method, auth, json, readBody })) return;
    if (await dispatchInternalRoutes(internal, { req, res, url, path: url.pathname, method, json, sender: SENDER, threadId: "thread-1", capability: {}, readBody: () => readBody(req) })) return;
    json(res, 404, { from: "inline routes" });
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, secret = SECRET) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", [PHONE_SECRET_HEADER]: secret }, body: JSON.stringify(body),
  });
  return { desk, asked, post, base };
}

describe("the phone's routes on the home", () => {
  it("are for the owner's own signed-in phone", () => {
    expect(requiredScope("POST", "/api/phone/device/connect")).toBe("admin");
    expect(requiredScope("POST", `/api/phone/device/${PHONE}/poll`)).toBe("admin");
    expect(requiredScope("GET", "/api/phone/device")).toBe("admin");
  });

  it("carry a dog's calendar read to the phone and its answer back", async () => {
    const { post, base } = await serve();
    expect((await post("/api/phone/device/connect", { id: PHONE, name: "Jacob's iPhone", can: ["calendar"] })).status).toBe(200);
    const polled = post(`/api/phone/device/${PHONE}/poll`, {});
    const asked = post("/api/internal/phone/read", { what: "calendar", from: "2026-11-03" });
    const { job } = await (await polled).json() as { job: { id: string; kind: string; arguments: unknown } };
    expect(job).toMatchObject({ kind: "calendar", arguments: { from: "2026-11-03" } });
    expect((await post(`/api/phone/device/${PHONE}/result`, { jobId: job.id, ok: true, result: { events: [{ title: "Standup" }] } })).status).toBe(200);
    const answer = await asked;
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ result: { events: [{ title: "Standup" }] } });
    const listed = await (await fetch(`${base}/api/phone/device`)).json() as { phones: { name: string; online: boolean }[] };
    expect(listed.phones).toEqual([expect.objectContaining({ name: "Jacob's iPhone", online: true })]);
  });

  it("tell the dog what's wrong with its request before bothering the phone", async () => {
    const { post, asked } = await serve();
    const answer = await post("/api/internal/phone/add", { what: "calendar_event", title: "Dentist" });
    expect(answer.status).toBe(400);
    expect((await answer.json() as { error: string }).error).toMatch(/start: calendar_event needs start/);
    expect(asked).toEqual([]);
  });

  it("send a change to the phone as its own job, and check it first", async () => {
    const { desk, post, asked } = await serve();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ["change_reminder"] }, OWNER, SECRET);
    desk.disconnect(PHONE, OWNER.session, SECRET);
    const refused = await post("/api/internal/phone/change", { what: "reminder", id: "r-1", start: "2026-11-04" });
    expect(refused.status).toBe(400);
    expect(asked).toEqual([]);
    const answer = await post("/api/internal/phone/change", { what: "reminder", id: "r-1", completed: true });
    expect(asked).toEqual(["change_reminder"]);
    expect(answer.status).toBe(409);
  });

  it("ask the person to open the app when no phone is listening, and say so when it stays closed", async () => {
    const { desk, post, asked } = await serve();
    desk.connect({ id: PHONE, name: "Jacob's iPhone", can: ["add_reminder"] }, OWNER, SECRET);
    desk.disconnect(PHONE, OWNER.session, SECRET);
    const answer = await post("/api/internal/phone/add", { what: "reminder", title: "Call mom" });
    expect(asked).toEqual(["add_reminder"]);
    expect(answer.status).toBe(409);
    expect((await answer.json() as { error: string }).error).toMatch(/didn't open within/);
  });

  it("turn away a phone that isn't the owner's, and a poll without its secret", async () => {
    const refused = await serve({ owner: { error: "Only your own phone can connect to your later.dog Cloud.", status: 403 } });
    expect((await refused.post("/api/phone/device/connect", { id: PHONE, name: "Someone's iPhone", can: [] })).status).toBe(403);
    const { post } = await serve();
    await post("/api/phone/device/connect", { id: PHONE, name: "Jacob's iPhone", can: ["calendar"] });
    expect((await post(`/api/phone/device/${PHONE}/poll`, {}, "d".repeat(64))).status).toBe(403);
  });
});
