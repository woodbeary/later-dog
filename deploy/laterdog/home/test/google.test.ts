import { describe, expect, it, vi } from "vitest";
import { GOOGLE_MAX_BYTES, GOOGLE_SWITCHED_OFF, GOOGLE_UNREACHABLE, handleGoogle, type GoogleAccounts } from "../src/google.ts";

const PARAMS = { token: "home-google-token", accountId: "user-1" };
const CLIENT = { clientId: "123-shared.apps.googleusercontent.com", redirectUri: "https://accounts.later.dog/google-oauth/callback" };
const TOKEN = { access_token: "ya29.fixture", expires_in: 3599, scope: "openid email", refresh_token: "1//fixture" };
const GRANT = { grant: "refresh", refreshToken: "1//fixture" };

function clientAsk(token = PARAMS.token): Request {
  return new Request("http://google.internal/client", { headers: { authorization: `Bearer ${token}` } });
}

function tokenAsk(body: unknown, token = PARAMS.token, init: RequestInit = {}): Request {
  return new Request("http://google.internal/token", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function accounts(answers: Partial<{ client: unknown; token: unknown }> = {}) {
  return {
    googleClient: vi.fn(async () => ("client" in answers ? answers.client : CLIENT) as never),
    googleToken: vi.fn(async () => ("token" in answers ? answers.token : { ok: true, token: TOKEN }) as never),
  };
}

describe("a home asking later.dog's Google connection", () => {
  it("answers with later.dog's client and passes a token request on for this home's own account", async () => {
    const service = accounts();
    const client = await handleGoogle(clientAsk(), PARAMS, service);
    expect(client.status).toBe(200);
    expect(await client.json()).toEqual(CLIENT);
    const token = await handleGoogle(tokenAsk(GRANT), PARAMS, service);
    expect(token.status).toBe(200);
    expect(await token.json()).toEqual(TOKEN);
    expect(service.googleToken).toHaveBeenCalledWith("user-1", GRANT);
  });

  it("refuses anything without this home's token", async () => {
    const service = accounts();
    for (const request of [clientAsk("guess"), tokenAsk(GRANT, "guess"), new Request("http://google.internal/client"), tokenAsk(GRANT, "")]) {
      expect((await handleGoogle(request, PARAMS, service)).status).toBe(401);
    }
    expect((await handleGoogle(clientAsk(), { token: PARAMS.token }, service)).status).toBe(401);
    expect((await handleGoogle(clientAsk(), undefined, service)).status).toBe(401);
    expect((await handleGoogle(clientAsk(), { accountId: "user-1" }, service)).status).toBe(401);
    expect(service.googleClient).not.toHaveBeenCalled();
    expect(service.googleToken).not.toHaveBeenCalled();
  });

  it("never lets the caller choose the account", async () => {
    const service = accounts();
    const request = new Request("http://google.internal/token?accountId=someone-else&account=someone-else", {
      method: "POST",
      headers: { authorization: `Bearer ${PARAMS.token}`, "x-account-id": "someone-else", "content-type": "application/json" },
      body: JSON.stringify({ ...GRANT, accountId: "someone-else", account: "someone-else" }),
    });
    expect((await handleGoogle(request, PARAMS, service)).status).toBe(200);
    expect(service.googleToken).toHaveBeenCalledTimes(1);
    expect(service.googleToken.mock.calls[0]![0]).toBe("user-1");
  });

  it("says the connection is off when later.dog has no client", async () => {
    const off = await handleGoogle(clientAsk(), PARAMS, accounts({ client: null }));
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ error: GOOGLE_SWITCHED_OFF });
  });

  it("answers 503 in plain words, and never throws, when the accounts service is older or fails", async () => {
    const older: GoogleAccounts = {};
    const throwing: GoogleAccounts = {
      googleClient: () => { throw new Error("The RPC receiver does not implement the method \"googleClient\"."); },
      googleToken: () => { throw new Error("The RPC receiver does not implement the method \"googleToken\"."); },
    };
    const rejecting: GoogleAccounts = {
      googleClient: async () => { throw new Error("service down"); },
      googleToken: async () => { throw new Error("service down"); },
    };
    const odd = { googleClient: async () => undefined, googleToken: async () => ({ ok: "yes" }) } as unknown as GoogleAccounts;
    for (const service of [older, throwing, rejecting, odd]) {
      for (const request of [clientAsk(), tokenAsk(GRANT)]) {
        const answer = await handleGoogle(request, PARAMS, service);
        expect(answer.status).toBe(503);
        expect(await answer.json()).toEqual({ error: GOOGLE_UNREACHABLE });
      }
    }
  });

  it("passes on the accounts service's refusal, and only the four token fields", async () => {
    const capped = await handleGoogle(tokenAsk(GRANT), PARAMS, accounts({ token: { ok: false, status: 400, error: "Google no longer accepts this connection. Connect again." } }));
    expect(capped.status).toBe(400);
    expect(await capped.json()).toEqual({ error: "Google no longer accepts this connection. Connect again." });
    const extra = await handleGoogle(tokenAsk(GRANT), PARAMS, accounts({ token: { ok: true, token: { ...TOKEN, id_token: "x.y.z", token_type: "Bearer" } } }));
    expect(await extra.json()).toEqual(TOKEN);
  });

  it("refuses bodies over 8 KB, however they arrive, before asking the accounts service", async () => {
    const service = accounts();
    const big = JSON.stringify({ ...GRANT, padding: "p".repeat(GOOGLE_MAX_BYTES) });
    expect((await handleGoogle(tokenAsk(big), PARAMS, service)).status).toBe(413);
    const declared = tokenAsk("{}", PARAMS.token, { headers: { authorization: `Bearer ${PARAMS.token}`, "content-length": String(GOOGLE_MAX_BYTES + 1) } });
    expect((await handleGoogle(declared, PARAMS, service)).status).toBe(413);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 3; index += 1) controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
        controller.close();
      },
    });
    const chunked = new Request("http://google.internal/token", { method: "POST", headers: { authorization: `Bearer ${PARAMS.token}` }, body: streamed, duplex: "half" } as RequestInit);
    expect((await handleGoogle(chunked, PARAMS, service)).status).toBe(413);
    expect((await handleGoogle(tokenAsk("not json"), PARAMS, service)).status).toBe(400);
    expect(service.googleToken).not.toHaveBeenCalled();
  });

  it("answers only its two addresses", async () => {
    const service = accounts();
    const elsewhere = new Request("http://google.internal/other", { headers: { authorization: `Bearer ${PARAMS.token}` } });
    expect((await handleGoogle(elsewhere, PARAMS, service)).status).toBe(404);
    expect((await handleGoogle(tokenAsk(GRANT, PARAMS.token, { method: "PUT" }), PARAMS, service)).status).toBe(405);
    const postedClient = new Request("http://google.internal/client", { method: "POST", headers: { authorization: `Bearer ${PARAMS.token}` }, body: "{}" });
    expect((await handleGoogle(postedClient, PARAMS, service)).status).toBe(405);
  });
});
