import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cloudHomeChildEnvironments } from "../cloud-home-start.ts";
import { CLOUD_HOME_SECRET_KEYS } from "../cloud-secrets.ts";
import { answerGoogleCallback, createGoogleRoute, GOOGLE_NEEDS_CLIENT, type GoogleRouteDeps } from "../routes/google.ts";
import { GMAIL_READONLY_SCOPE, GOOGLE_TOKEN_URL, GoogleAccessTokens, PendingGoogleAuths, type FetchLike, type GoogleAccountRecord, type PendingGoogleAuth } from "./google.ts";
import { cloudGoogleConnection, GOOGLE_SHARED_OFF, googleReconnect, sharedClientInfo } from "./google-shared.ts";

const NOW = Date.UTC(2026, 10, 14, 18);
const MACHINE = "h0123456789abcdef01234567";
const ACCOUNTS_STATE = /^(h[0-9a-f]{24})\.[A-Za-z0-9_-]{16,128}$/;
const SHARED = { clientId: "123456-shared.apps.googleusercontent.com", redirectUri: "https://accounts.later.dog/google-oauth/callback" };
const SHARED_SECRET = "accounts-worker-only-shared-secret";
const OWN = { clientId: "999-own.apps.googleusercontent.com", clientSecret: "own-client-secret-fixture" };
const HOME_TOKEN = "home-google-route-token-fixture";
const GOOGLE_URL = "http://google.internal";
const EMAIL = "lopez731@gmail.com";
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64url");

type Mode = "on" | "off" | "older" | "rotated";
interface Seen { url: string; method: string; headers: Record<string, string>; body: string }

function world(opts: { own?: boolean; cloud?: boolean; route?: boolean; machineId?: string; accounts?: GoogleAccountRecord[]; client?: unknown } = {}) {
  let mode: Mode = "on";
  const requests: Seen[] = [];
  const grants: Array<Record<string, unknown>> = [];
  const accounts = [...(opts.accounts ?? [])];
  const cards: Array<{ url: string; service: string }> = [];
  const finished: Array<[string, string]> = [];
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const fetcher: FetchLike = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ url, method: init?.method ?? "GET", headers, body });
    if (url.startsWith(`${GOOGLE_URL}/`)) {
      if (headers.authorization !== `Bearer ${HOME_TOKEN}`) return reply({ error: "Unauthorized" }, 401);
      if (mode === "older") return reply({ error: "later.dog's Google connection can't be reached right now. Try again in a minute." }, 503);
      if (url === `${GOOGLE_URL}/client`) {
        if (mode === "off") return reply({ error: "later.dog's Google connection isn't switched on yet." }, 404);
        return reply(mode === "rotated" ? { ...SHARED, clientId: "777-rotated.apps.googleusercontent.com" } : opts.client ?? SHARED);
      }
      if (url === `${GOOGLE_URL}/token`) {
        const grant = JSON.parse(body) as Record<string, unknown>;
        grants.push(grant);
        if (grant.grant === "code") return reply({ access_token: "at-shared-code", expires_in: 3599, scope: `openid email ${GMAIL_READONLY_SCOPE}`, refresh_token: "rt-shared" });
        return reply({ access_token: "at-shared-refresh", expires_in: 3599, scope: `openid email ${GMAIL_READONLY_SCOPE}` });
      }
    }
    if (url.startsWith(GOOGLE_TOKEN_URL)) {
      const form = new URLSearchParams(body);
      if (form.get("client_secret") !== OWN.clientSecret) return reply({ error: "invalid_client" }, 401);
      return form.get("grant_type") === "authorization_code"
        ? reply({ access_token: "at-own-code", refresh_token: "rt-own", scope: `openid email ${GMAIL_READONLY_SCOPE}` })
        : reply({ access_token: "at-own-refresh", expires_in: 3600 });
    }
    if (url.startsWith("https://openidconnect.googleapis.com")) return reply({ email: EMAIL });
    if (url.includes("/messages?")) return reply({ messages: [{ id: "msg001" }] });
    if (url.includes("/messages/msg001")) {
      return reply({ id: "msg001", internalDate: String(NOW - 60_000), payload: {
        headers: [{ name: "From", value: "no-reply@nextdoor.com" }, { name: "Subject", value: "Your Nextdoor code is 482913" }],
        mimeType: "text/plain", body: { data: b64("Use 482913 to sign in.") } } });
    }
    return reply({}, 404);
  };
  const deps: GoogleRouteDeps = {
    ownerActing: () => true,
    client: () => (opts.own ? OWN : null),
    redirectUri: () => `https://${MACHINE}-home.later.dog/google-oauth/callback`,
    cloud: opts.cloud === false ? null : { machineId: opts.machineId ?? MACHINE, shared: opts.route === false ? null : cloudGoogleConnection(GOOGLE_URL, HOME_TOKEN, fetcher) },
    accounts: () => accounts,
    saveAccount: (account) => { accounts.splice(0, accounts.length, ...accounts.filter((a) => a.email !== account.email), account); },
    saveSecret: () => ({ replaced: false }),
    pending: new PendingGoogleAuths(() => NOW),
    tokens: new GoogleAccessTokens(fetcher, () => NOW),
    fetcher,
    postCard: (_sender, _thread, input) => { cards.push(input); return `card${cards.length}`; },
    finishCard: (pending: PendingGoogleAuth, outcome, detail) => { finished.push([`${pending.messageId}:${outcome}`, detail]); },
    now: () => NOW,
  };
  const route = createGoogleRoute(deps);
  const call = async (body: Record<string, unknown>) => {
    let status = 0;
    let out: Record<string, unknown> = {};
    await route({
      res: {} as never, path: "/api/internal/google", method: "POST", url: new URL("http://x"), req: {} as never,
      json: ((_r: unknown, code: number, value: Record<string, unknown>) => { status = code; out = value; }) as never,
      sender: { id: "scout", name: "Scout", color: "#000" } as never, threadId: "t1", capability: {}, readBody: async () => body,
    });
    return { status, out };
  };
  const connect = async () => {
    const made = await call({ action: "connect", account: EMAIL });
    expect(made.status, JSON.stringify(made.out)).toBe(201);
    const url = new URL(cards.at(-1)!.url);
    return { url, state: url.searchParams.get("state")! };
  };
  return { deps, call, connect, cards, finished, accounts, requests, grants, setMode: (next: Mode) => { mode = next; } };
}

const SHARED_ACCOUNT: GoogleAccountRecord = { email: EMAIL, refreshToken: "rt-shared", scope: GMAIL_READONLY_SCOPE, connectedAt: 1, clientId: SHARED.clientId };

function noSecretIn(requests: Seen[]) {
  for (const request of requests) {
    const text = JSON.stringify(request);
    expect(text, request.url).not.toContain("client_secret");
    expect(text, request.url).not.toContain(SHARED_SECRET);
    expect(text, request.url).not.toContain(OWN.clientSecret);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("a Cloud home with nothing set up connecting Gmail through later.dog's one client", () => {
  it("posts a card for later.dog's client, its fixed address, and a state that names this home", async () => {
    const h = world();
    const { url, state } = await h.connect();
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(SHARED.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(SHARED.redirectUri);
    expect(ACCOUNTS_STATE.exec(state)?.[1]).toBe(MACHINE);
    expect(url.searchParams.get("scope")).toBe(`openid email ${GMAIL_READONLY_SCOPE}`);
    expect(h.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${GOOGLE_URL}/client`]);
  });

  it("exchanges the code through later.dog's connection and keeps the account, with its client, in the home's vault", async () => {
    const h = world();
    const { url, state } = await h.connect();
    const page = await answerGoogleCallback(h.deps, new URLSearchParams({ state, code: "auth-code" }));
    expect(page.status).toBe(200);
    expect(page.html).toContain(`Connected ${EMAIL}`);
    expect(h.grants).toHaveLength(1);
    const grant = h.grants[0]!;
    expect(grant).toEqual({ grant: "code", code: "auth-code", verifier: expect.any(String) });
    expect(createHash("sha256").update(String(grant.verifier)).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(h.accounts).toEqual([{ email: EMAIL, refreshToken: "rt-shared", scope: `openid email ${GMAIL_READONLY_SCOPE}`, connectedAt: NOW, clientId: SHARED.clientId }]);
    expect(h.finished).toEqual([["card1:connected", `Connected ${EMAIL} with read-only Gmail.`]]);
    expect(h.requests.find((r) => r.url.startsWith("https://openidconnect.googleapis.com"))?.headers.authorization).toBe("Bearer at-shared-code");
    expect(h.requests.some((r) => r.url.startsWith(GOOGLE_TOKEN_URL))).toBe(false);
  });

  it("refreshes a later read through later.dog's connection, once, and reads Gmail with that access", async () => {
    const h = world();
    const { state } = await h.connect();
    await answerGoogleCallback(h.deps, new URLSearchParams({ state, code: "auth-code" }));
    const found = await h.call({ action: "search", query: "from:nextdoor.com" });
    expect(found).toMatchObject({ status: 200, out: { account: EMAIL, messages: [{ id: "msg001" }] } });
    const read = await h.call({ action: "read", id: "msg001" });
    expect((read.out.message as { text: string }).text).toBe("Use 482913 to sign in.");
    expect(h.grants.slice(1)).toEqual([{ grant: "refresh", refreshToken: "rt-shared" }]);
    const gmail = h.requests.filter((r) => r.url.startsWith("https://gmail.googleapis.com"));
    expect(gmail.length).toBeGreaterThan(1);
    for (const request of gmail) expect(request.headers.authorization).toBe("Bearer at-shared-refresh");
    expect(h.requests.filter((r) => r.url === `${GOOGLE_URL}/client`)).toHaveLength(2);
  });

  it("never sends, holds or logs a client secret on the way", async () => {
    const lines: string[] = [];
    for (const level of ["log", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
    }
    const h = world();
    const { state } = await h.connect();
    await answerGoogleCallback(h.deps, new URLSearchParams({ state, code: "auth-code" }));
    await h.call({ action: "search", query: "from:nextdoor.com" });
    await h.call({ action: "code", from: "nextdoor.com", name: "nextdoor/scout/CODE" });
    expect(h.requests.length).toBeGreaterThan(5);
    noSecretIn(h.requests);
    expect(h.requests.some((r) => r.url.startsWith("https://oauth2.googleapis.com"))).toBe(false);
    expect(JSON.stringify(h.accounts)).not.toMatch(/secret/i);
    expect(lines.join("\n")).not.toMatch(/client_secret|rt-shared|at-shared/);
  });

  it("lets a client of the owner's own win, exactly as before, without asking later.dog's connection", async () => {
    const h = world({ own: true });
    const { url, state } = await h.connect();
    expect(url.searchParams.get("client_id")).toBe(OWN.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(`https://${MACHINE}-home.later.dog/google-oauth/callback`);
    expect(state).not.toContain(".");
    expect((await answerGoogleCallback(h.deps, new URLSearchParams({ state, code: "auth-code" }))).status).toBe(200);
    expect(h.accounts[0]).toMatchObject({ email: EMAIL, refreshToken: "rt-own", clientId: OWN.clientId });
    expect((await h.call({ action: "search", query: "from:nextdoor.com" })).status).toBe(200);
    const tokenCalls = h.requests.filter((r) => r.url.startsWith(GOOGLE_TOKEN_URL)).map((r) => new URLSearchParams(r.body));
    expect(tokenCalls.map((form) => [form.get("grant_type"), form.get("client_id"), form.get("client_secret")])).toEqual([
      ["authorization_code", OWN.clientId, OWN.clientSecret],
      ["refresh_token", OWN.clientId, OWN.clientSecret],
    ]);
    expect(h.requests.some((r) => r.url.startsWith(GOOGLE_URL))).toBe(false);
  });
});

describe("when later.dog's connection can't be used", () => {
  it("refuses an address from the Worker that is not https or not exactly the callback page, and posts no card", async () => {
    const wrong = [
      "http://accounts.later.dog/google-oauth/callback",
      "https://accounts.later.dog/elsewhere",
      "https://accounts.later.dog/google-oauth/callback/",
      "https://accounts.later.dog/google-oauth",
      "https://accounts.later.dog/google-oauth/callback?next=https://evil.example",
      "https://accounts.later.dog/google-oauth/callback#x",
      "https://someone:secret@accounts.later.dog/google-oauth/callback",
      "javascript:alert(1)",
      "",
    ];
    for (const redirectUri of wrong) {
      expect(sharedClientInfo({ clientId: SHARED.clientId, redirectUri }), redirectUri).toBeNull();
      const h = world({ client: { clientId: SHARED.clientId, redirectUri } });
      expect(await h.call({ action: "connect", account: EMAIL }), redirectUri).toEqual({ status: 409, out: { error: GOOGLE_SHARED_OFF } });
      expect(h.cards, redirectUri).toEqual([]);
    }
    expect(sharedClientInfo(SHARED)).toEqual(SHARED);
    expect(sharedClientInfo({ ...SHARED, clientId: "not-a-client" })).toBeNull();
  });

  it("tells the dog it isn't switched on, for every earlier piece that is missing", async () => {
    const off = world();
    off.setMode("off");
    const older = world();
    older.setMode("older");
    for (const h of [off, older, world({ route: false }), world({ machineId: "7d1e0c55-2b8a-4f3e-9c61-0a4b2d7e9f13" })]) {
      expect(await h.call({ action: "connect", account: EMAIL })).toEqual({ status: 409, out: { error: GOOGLE_SHARED_OFF } });
      expect(h.cards).toEqual([]);
      noSecretIn(h.requests);
    }
  });

  it("keeps asking a home that is not a Cloud home for a client of its own", async () => {
    const h = world({ cloud: false });
    const made = await h.call({ action: "connect" });
    expect(made.status).toBe(409);
    expect(String(made.out.error)).toBe(`${GOOGLE_NEEDS_CLIENT} Redirect address: https://${MACHINE}-home.later.dog/google-oauth/callback`);
    expect(await h.call({ action: "search", query: "x" })).toEqual({ status: 409, out: { error: GOOGLE_NEEDS_CLIENT } });
    expect(h.requests).toEqual([]);
  });

  it("refreshes with the client that issued the token, and says to connect again when that client is gone", async () => {
    const sharedWithOwn = world({ own: true, accounts: [SHARED_ACCOUNT] });
    expect((await sharedWithOwn.call({ action: "search", query: "x" })).status).toBe(200);
    expect(sharedWithOwn.grants).toEqual([{ grant: "refresh", refreshToken: "rt-shared" }]);
    expect(sharedWithOwn.requests.some((r) => r.url.startsWith(GOOGLE_TOKEN_URL))).toBe(false);

    const legacy = world({ own: true, accounts: [{ ...SHARED_ACCOUNT, clientId: undefined, refreshToken: "rt-own" }] });
    expect((await legacy.call({ action: "search", query: "x" })).status).toBe(200);
    expect(legacy.requests.filter((r) => r.url.startsWith(GOOGLE_TOKEN_URL))).toHaveLength(1);
    expect(legacy.grants).toEqual([]);

    const rotated = world({ accounts: [SHARED_ACCOUNT] });
    rotated.setMode("rotated");
    expect(await rotated.call({ action: "search", query: "x" })).toEqual({ status: 502, out: { error: googleReconnect(EMAIL) } });
    expect(rotated.grants).toEqual([]);

    const ownGone = world({ accounts: [{ ...SHARED_ACCOUNT, clientId: OWN.clientId }] });
    expect(await ownGone.call({ action: "search", query: "x" })).toEqual({ status: 502, out: { error: googleReconnect(EMAIL) } });
    const legacyGone = world({ accounts: [{ ...SHARED_ACCOUNT, clientId: undefined }] });
    expect(await legacyGone.call({ action: "search", query: "x" })).toEqual({ status: 502, out: { error: googleReconnect(EMAIL) } });

    const switchedOff = world({ accounts: [SHARED_ACCOUNT] });
    switchedOff.setMode("off");
    const answer = await switchedOff.call({ action: "search", query: "x" });
    expect(answer.status).toBe(502);
    expect(String(answer.out.error)).toContain("can't be reached or is switched off");
    expect(switchedOff.grants).toEqual([]);
  });

  it("passes on Google's refusal from later.dog's connection in plain words", async () => {
    const h = world({ accounts: [SHARED_ACCOUNT] });
    h.deps.tokens = new GoogleAccessTokens(h.deps.fetcher, () => NOW);
    const refusing = cloudGoogleConnection(GOOGLE_URL, HOME_TOKEN, async (url) => url.endsWith("/client")
      ? Response.json(SHARED)
      : Response.json({ error: "Google no longer accepts this connection. Connect again." }, { status: 400 }));
    h.deps.cloud = { machineId: MACHINE, shared: refusing };
    const answer = await createGoogleRoute(h.deps)({
      res: {} as never, path: "/api/internal/google", method: "POST", url: new URL("http://x"), req: {} as never,
      json: ((_r: unknown, code: number, value: Record<string, unknown>) => ({ code, value })) as never,
      sender: { id: "scout", name: "Scout", color: "#000" } as never, threadId: "t1", capability: {}, readBody: async () => ({ action: "search", query: "x" }),
    });
    expect(answer).toEqual({ code: 502, value: { error: `${EMAIL}: Google no longer accepts this connection. Connect again.` } });
  });
});

describe("the Cloud home's settings for later.dog's connection", () => {
  it("hands the address to the server and the key only through the secrets channel", () => {
    const config = { machineId: MACHINE, adminOrigin: "https://accounts.later.dog", publicOrigin: `https://${MACHINE}-home.later.dog`, bootstrapSecret: "b".repeat(43), warnings: [] };
    const { server, secrets } = cloudHomeChildEnvironments(config, {
      PATH: "/usr/bin", LATERDOG_CLOUD_GOOGLE_URL: GOOGLE_URL, LATERDOG_CLOUD_GOOGLE_TOKEN: HOME_TOKEN, LATERDOG_CLOUD_BOOTSTRAP_SECRET: "b".repeat(43),
    }, "/data");
    expect(server.LATERDOG_CLOUD_GOOGLE_URL).toBe(GOOGLE_URL);
    expect(JSON.stringify(server)).not.toContain(HOME_TOKEN);
    expect(secrets.LATERDOG_CLOUD_GOOGLE_TOKEN).toBe(HOME_TOKEN);
    expect(CLOUD_HOME_SECRET_KEYS).toContain("LATERDOG_CLOUD_GOOGLE_TOKEN");
  });

  it("has no connection without both the address and the key", () => {
    expect(cloudGoogleConnection(undefined, HOME_TOKEN)).toBeNull();
    expect(cloudGoogleConnection(GOOGLE_URL, undefined)).toBeNull();
    expect(cloudGoogleConnection(GOOGLE_URL, "")).toBeNull();
  });
});
