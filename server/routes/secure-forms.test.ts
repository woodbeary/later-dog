import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { SecureFormSubmit } from "../laterdog/secure-form.ts";
import type { SecureFormCardData } from "../../shared/secure-form.ts";
import { requiredScope } from "../request-auth.ts";
import { createSecureFormRoutes, SECURE_FORM_BODY_BYTES } from "./secure-forms.ts";
import { dispatchRoutes } from "./table.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(answer: SecureFormSubmit) {
  const calls: unknown[][] = [];
  const routes = [createSecureFormRoutes({ forms: { submit: (...args) => { calls.push(args); return answer; } } })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const handled = await dispatchRoutes(routes, {
        req, res, url, path: url.pathname, method: req.method ?? "GET",
        auth: { kind: "loopback", scopes: ["admin"] }, json, readBody,
      });
      if (!handled) json(res, 404, { from: "inline routes" });
    } catch (error) {
      json(res, (error as { status?: number }).status ?? 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const submit = (base: string, body: unknown, method = "POST") => fetch(`${base}/api/bots/dog-1/secure-forms/form-1/submit`, {
  method, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
});

const CARD: SecureFormCardData = { title: "Sign in to Example", host: "example.com", fields: [], status: "sending", until: 1 };
const SENDING: SecureFormSubmit = { ok: true, card: CARD };

describe("Secure Form submit route", () => {
  it("is admin-scoped", () => {
    expect(requiredScope("POST", "/api/bots/dog-1/secure-forms/form-1/submit")).toBe("admin");
  });

  it("hands the values to the form it names and answers with the sealed card", async () => {
    const { base, calls } = await serve(SENDING);
    const response = await submit(base, { threadId: "thread-1", values: { email: "kit@example.com" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ card: CARD });
    expect(calls).toEqual([["dog-1", "thread-1", "form-1", { email: "kit@example.com" }]]);
  });

  it("passes on the form's refusal with its status", async () => {
    const { base } = await serve({ ok: false, status: 409, error: "This form was already sent." });
    const response = await submit(base, { threadId: "thread-1", values: {} });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "This form was already sent." });
  });

  it("refuses a body over the Secure Form limit before the form sees it", async () => {
    const { base, calls } = await serve(SENDING);
    const response = await submit(base, { threadId: "thread-1", values: { note: "x".repeat(SECURE_FORM_BODY_BYTES) } });
    expect(response.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("leaves other methods to the inline routes", async () => {
    const { base, calls } = await serve(SENDING);
    const response = await submit(base, undefined, "GET");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ from: "inline routes" });
    expect(calls).toEqual([]);
  });
});
