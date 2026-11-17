import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GOOGLE_EXPIRED,
  GOOGLE_NOT_ISSUED,
  GOOGLE_TIMEOUT_MS,
  GOOGLE_TOKEN_URL,
  GOOGLE_TOKENS_PER_DAY,
  googleToken,
  homeCallbackTarget,
  sharedGoogleClient,
  type GoogleFetch,
} from "../src/google";
import { createWorker } from "../src/index";
import { AccountsApi } from "../src/owner-mail";

const BASE_URL = "https://auth.laterdog.test";
const LABEL = "h0123456789abcdef01234567";
const RANDOM = "Q2xpZW50U3RhdGVSYW5kb21QYXJ0";
const STATE = `${LABEL}.${RANDOM}`;
const CLIENT_ID = "123456-shared.apps.googleusercontent.com";
const CLIENT_SECRET = "test-only-shared-google-secret";
const CODE = "4/0Atest-only-authorization-code";
const VERIFIER = "v".repeat(43);
const REFRESH = "1//test-only-refresh-token";
const ACCESS = "ya29.test-only-access-token";
const EMAIL = "google-person@example.com";
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function sharedOn(extra: Record<string, unknown> = {}): Env {
  return { ...env, GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: CLIENT_SECRET, ...extra } as unknown as Env;
}

async function person(email = EMAIL): Promise<string> {
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)')
    .bind(id, email.split("@")[0], email, at, at).run();
  return id;
}

function fakeGoogle(answer: () => Response) {
  const seen: Array<{ url: string; init: RequestInit; form: URLSearchParams }> = [];
  const fetcher: GoogleFetch = async (url, init) => {
    seen.push({ url, init, form: new URLSearchParams(String(init.body)) });
    return answer();
  };
  return { seen, fetcher };
}

async function hashOf(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function issue(accountId: string, refreshToken = REFRESH, at = NOW) {
  const google = fakeGoogle(() => Response.json({ access_token: ACCESS, expires_in: 3599, scope: "openid", refresh_token: refreshToken }));
  expect(await googleToken(sharedOn(), accountId, { grant: "code", code: CODE, verifier: VERIFIER }, google.fetcher, at)).toMatchObject({ ok: true });
}

async function recorded(accountId: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT token_hash FROM cloud_google_refresh_tokens WHERE account_id = ?").bind(accountId).all<{ token_hash: string }>();
  return rows.results.map((row) => row.token_hash);
}

const granted = () => Response.json({
  access_token: ACCESS,
  expires_in: 3599,
  scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
  refresh_token: REFRESH,
  id_token: "header.payload.signature",
  token_type: "Bearer",
  refresh_token_expires_in: 604_799,
});

async function call(path: string, headers: Record<string, string> = {}, target: Env = env, method = "GET") {
  const ctx = createExecutionContext();
  const response = await createWorker().fetch(new Request(`${BASE_URL}${path}`, { method, headers }), target, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

afterEach(() => vi.restoreAllMocks());

describe("Google's approval coming back to accounts.later.dog", () => {
  it("passes the approval on to the home named in state, with only state, code and error", async () => {
    const response = await call(
      `/google-oauth/callback?state=${STATE}&code=${encodeURIComponent(CODE)}&scope=openid%20email&authuser=0&prompt=consent&hd=example.com`,
      { origin: "https://evil.example" },
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(`https://${LABEL}-home.later.dog/google-oauth/callback`);
    expect([...location.searchParams.keys()]).toEqual(["state", "code"]);
    expect(location.searchParams.get("state")).toBe(STATE);
    expect(location.searchParams.get("code")).toBe(CODE);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("passes a refusal on too", async () => {
    const response = await call(`/google-oauth/callback?error=access_denied&state=${STATE}`);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`https://${LABEL}-home.later.dog/google-oauth/callback?state=${STATE}&error=access_denied`);
  });

  it("never sends the approval anywhere but a home of this later.dog", async () => {
    const refused = [
      "",
      `state=`,
      `state=${LABEL}`,
      `state=${LABEL}.short`,
      `state=${LABEL}.${"a".repeat(129)}`,
      `state=h0123456789abcdef0123456.${RANDOM}`,
      `state=h0123456789abcdef012345678.${RANDOM}`,
      `state=H0123456789abcdef01234567.${RANDOM}`,
      `state=h0123456789ABCDEF01234567.${RANDOM}`,
      `state=evil.example.${LABEL}.${RANDOM}`,
      `state=${LABEL}.evil.example.${RANDOM}`,
      `state=${LABEL}.${RANDOM}/evil`,
      `state=${encodeURIComponent(`${LABEL}.${RANDOM}/../../evil`)}`,
      `state=${encodeURIComponent(`${LABEL}@evil.example.${RANDOM}`)}`,
      `state=${encodeURIComponent(`${LABEL}.${RANDOM}@evil.example`)}`,
      `state=${encodeURIComponent(`evil.example/${LABEL}.${RANDOM}`)}`,
      `state=${encodeURIComponent(`${LABEL}:443.${RANDOM}`)}`,
      `state=${STATE}&state=${LABEL}.${"b".repeat(20)}`,
      `state=${STATE}&code=a&code=b`,
      `state=${STATE}&code=${"c".repeat(2049)}`,
    ];
    for (const query of refused) {
      const response = await call(`/google-oauth/callback?${query}${query.includes("code=") ? "" : "&code=x"}`);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("location"), query).toBeNull();
      const page = await response.text();
      expect(page).toContain("This link has expired");
      expect(page).toContain("Go back to later.dog and ask your dog to connect Google again.");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("refuses when the home address suffix is missing or not a plain host suffix", async () => {
    for (const suffix of ["", "home.later.dog", ".evil.example", "-home.later.dog/evil", "-home.later.dog:8443", "-HOME.later.dog", "-home.later.dog.", "-home@evil.example"]) {
      const response = await call(`/google-oauth/callback?state=${STATE}&code=x`, {}, { ...env, CLOUD_HOME_HOST_SUFFIX: suffix } as unknown as Env);
      expect(response.status, suffix).toBe(400);
      expect(homeCallbackTarget(new URLSearchParams({ state: STATE }), suffix), suffix).toBeNull();
    }
  });

  it("answers only a GET", async () => {
    expect((await call(`/google-oauth/callback?state=${STATE}&code=x`, {}, env, "POST")).status).toBe(404);
  });
});

describe("later.dog's one Google client", () => {
  it("is off until both the client ID and its secret are set", async () => {
    expect(sharedGoogleClient(env)).toBeNull();
    expect(sharedGoogleClient(sharedOn({ GOOGLE_CLIENT_SECRET: "" }))).toBeNull();
    expect(sharedGoogleClient(sharedOn({ GOOGLE_CLIENT_SECRET: undefined }))).toBeNull();
    expect(sharedGoogleClient(sharedOn({ GOOGLE_CLIENT_ID: "" }))).toBeNull();
    expect(sharedGoogleClient(sharedOn({ GOOGLE_CLIENT_ID: "not-a-google-client" }))).toBeNull();
    expect(sharedGoogleClient(sharedOn())).toEqual({ clientId: CLIENT_ID, redirectUri: "https://accounts.later.dog/google-oauth/callback" });
    const accountId = await person();
    const google = fakeGoogle(granted);
    for (const off of [env, sharedOn({ GOOGLE_CLIENT_SECRET: "" }), sharedOn({ GOOGLE_CLIENT_ID: "" })]) {
      expect(await googleToken(off, accountId, { grant: "refresh", refreshToken: REFRESH }, google.fetcher, NOW)).toMatchObject({ ok: false, status: 503 });
    }
    expect(google.seen).toEqual([]);
  });

  it("is what the home-facing service answers", async () => {
    const api = new AccountsApi(createExecutionContext(), sharedOn());
    expect(await api.googleClient()).toEqual({ clientId: CLIENT_ID, redirectUri: "https://accounts.later.dog/google-oauth/callback" });
    expect(await new AccountsApi(createExecutionContext(), env).googleClient()).toBeNull();
    expect(await new AccountsApi(createExecutionContext(), env).googleToken("anyone", { grant: "refresh", refreshToken: REFRESH })).toMatchObject({ ok: false, status: 503 });
  });

  it("exchanges a code with the client ID, the secret and the fixed redirect address, and returns only four fields", async () => {
    const accountId = await person();
    const google = fakeGoogle(granted);
    const result = await googleToken(sharedOn(), accountId, { grant: "code", code: CODE, verifier: VERIFIER }, google.fetcher, NOW);
    expect(result).toEqual({ ok: true, token: { access_token: ACCESS, expires_in: 3599, scope: "openid email https://www.googleapis.com/auth/gmail.readonly", refresh_token: REFRESH } });
    expect(google.seen).toHaveLength(1);
    const [sent] = google.seen;
    expect(sent!.url).toBe(GOOGLE_TOKEN_URL);
    expect(sent!.init.method).toBe("POST");
    expect(sent!.init.redirect).toBe("manual");
    expect(sent!.init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.fromEntries(sent!.form)).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: "https://accounts.later.dog/google-oauth/callback",
    });
    expect(GOOGLE_TIMEOUT_MS).toBe(10_000);
  });

  it("refreshes with the client ID and the secret, and leaves out a refresh token Google did not send", async () => {
    const accountId = await person();
    await issue(accountId);
    const google = fakeGoogle(() => Response.json({ access_token: ACCESS, expires_in: 3599, scope: "openid", token_type: "Bearer" }));
    const result = await googleToken(sharedOn(), accountId, { grant: "refresh", refreshToken: REFRESH }, google.fetcher, NOW);
    expect(result).toEqual({ ok: true, token: { access_token: ACCESS, expires_in: 3599, scope: "openid" } });
    expect(Object.fromEntries(google.seen[0]!.form)).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: REFRESH });
  });

  it("turns Google's invalid_grant into connect again, and anything else into a plain 502", async () => {
    const accountId = await person();
    await issue(accountId);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const expired = fakeGoogle(() => Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }));
    expect(await googleToken(sharedOn(), accountId, { grant: "refresh", refreshToken: REFRESH }, expired.fetcher, NOW))
      .toEqual({ ok: false, status: 400, error: GOOGLE_EXPIRED });
    await issue(accountId);
    for (const answer of [
      () => Response.json({ error: "invalid_client" }, { status: 401 }),
      () => new Response("down", { status: 503 }),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/token" } }),
      () => Response.json({ token_type: "Bearer" }),
      () => { throw new Error("network down"); },
    ]) {
      const result = await googleToken(sharedOn(), accountId, { grant: "refresh", refreshToken: REFRESH }, fakeGoogle(answer).fetcher, NOW);
      expect(result).toMatchObject({ ok: false, status: 502 });
      expect(JSON.stringify(result)).not.toMatch(/invalid_client|down|evil|network/);
    }
  });

  it("checks the shapes before anything reaches Google, and refuses an account that is gone", async () => {
    const accountId = await person();
    const google = fakeGoogle(granted);
    for (const grant of [
      null, "refresh", [], {},
      { grant: "password", refreshToken: REFRESH },
      { grant: "refresh" },
      { grant: "refresh", refreshToken: "" },
      { grant: "refresh", refreshToken: "has space" },
      { grant: "refresh", refreshToken: "r".repeat(2049) },
      { grant: "code", code: CODE },
      { grant: "code", code: CODE, verifier: "short" },
      { grant: "code", code: "", verifier: VERIFIER },
      { grant: "code", code: "c".repeat(2049), verifier: VERIFIER },
    ]) {
      expect(await googleToken(sharedOn(), accountId, grant, google.fetcher, NOW), JSON.stringify(grant)).toMatchObject({ ok: false, status: 400 });
    }
    for (const badAccount of ["", "../x", 7, null]) {
      expect(await googleToken(sharedOn(), badAccount, { grant: "refresh", refreshToken: REFRESH }, google.fetcher, NOW)).toMatchObject({ ok: false, status: 400 });
    }
    expect(await googleToken(sharedOn(), "no-such-account", { grant: "refresh", refreshToken: REFRESH }, google.fetcher, NOW)).toMatchObject({ ok: false, status: 404 });
    expect(google.seen).toEqual([]);
  });

  it(`stops at ${GOOGLE_TOKENS_PER_DAY} calls an account a day, and counts each account on its own`, async () => {
    const accountId = await person();
    const other = await person("someone-else@example.com");
    await issue(accountId, REFRESH, NOW - DAY);
    await issue(other, REFRESH, NOW - DAY);
    const google = fakeGoogle(granted);
    const day = Math.floor(NOW / DAY);
    await env.DB.prepare("INSERT INTO cloud_google_tokens (account_id, day, calls) VALUES (?, ?, ?)").bind(accountId, day, GOOGLE_TOKENS_PER_DAY - 2).run();
    const refresh = { grant: "refresh", refreshToken: REFRESH };
    expect(await googleToken(sharedOn(), accountId, refresh, google.fetcher, NOW)).toMatchObject({ ok: true });
    expect(await googleToken(sharedOn(), accountId, refresh, google.fetcher, NOW)).toMatchObject({ ok: true });
    expect(await googleToken(sharedOn(), accountId, refresh, google.fetcher, NOW)).toMatchObject({ ok: false, status: 429 });
    expect(google.seen).toHaveLength(2);
    expect(await googleToken(sharedOn(), other, refresh, google.fetcher, NOW)).toMatchObject({ ok: true });
    expect(await googleToken(sharedOn(), accountId, refresh, google.fetcher, NOW + DAY)).toMatchObject({ ok: true });
    const row = await env.DB.prepare("SELECT calls FROM cloud_google_tokens WHERE account_id = ? AND day = ?").bind(accountId, day).first<{ calls: number }>();
    expect(row?.calls).toBe(GOOGLE_TOKENS_PER_DAY);
  });

  it("writes no code, token, secret or email to the log, and stores none of them", async () => {
    const lines: string[] = [];
    for (const level of ["log", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); });
    }
    const accountId = await person();
    const answers = [
      granted,
      () => Response.json({ error: "invalid_grant", error_description: `bad ${REFRESH}` }, { status: 400 }),
      () => Response.json({ error: "server_error", error_description: `bad ${CODE}` }, { status: 500 }),
      () => { throw new Error(`fetch failed for ${CODE}`); },
      () => new Response(`{"access_token":"${ACCESS}"`, { status: 200 }),
    ];
    for (const answer of answers) {
      await googleToken(sharedOn(), accountId, { grant: "code", code: CODE, verifier: VERIFIER }, fakeGoogle(answer).fetcher, NOW);
      await googleToken(sharedOn(), accountId, { grant: "refresh", refreshToken: REFRESH }, fakeGoogle(answer).fetcher, NOW);
    }
    expect(lines.length).toBeGreaterThan(0);
    const logged = lines.join("\n");
    for (const value of [CODE, VERIFIER, REFRESH, ACCESS, CLIENT_SECRET, EMAIL, accountId]) expect(logged).not.toContain(value);
    expect(lines.every((line) => /^\{"message":"google token request failed","errorCode":"google_[a-z_]+"\}$/.test(line))).toBe(true);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>();
    for (const { name } of tables.results) {
      const rows = JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results);
      for (const value of [CODE, VERIFIER, REFRESH, ACCESS, CLIENT_SECRET]) expect(rows, name).not.toContain(value);
    }
  });
});

describe("a refresh token works only for the account it was given to", () => {
  it("refuses another account's token without asking Google, and keeps the owner's own working", async () => {
    const owner = await person("owner-a@example.com");
    const other = await person("other-b@example.com");
    await issue(owner);
    const google = fakeGoogle(granted);
    expect(await googleToken(sharedOn(), other, { grant: "refresh", refreshToken: REFRESH }, google.fetcher, NOW))
      .toEqual({ ok: false, status: 409, error: GOOGLE_NOT_ISSUED });
    expect(google.seen).toEqual([]);
    expect(await googleToken(sharedOn(), owner, { grant: "refresh", refreshToken: REFRESH }, google.fetcher, NOW)).toMatchObject({ ok: true });
    expect(google.seen).toHaveLength(1);
  });

  it("refuses a token from before later.dog kept a record of whose it is, with words that say to connect again", async () => {
    const accountId = await person();
    const google = fakeGoogle(granted);
    const answer = await googleToken(sharedOn(), accountId, { grant: "refresh", refreshToken: "1//token-from-before-the-record" }, google.fetcher, NOW);
    expect(answer).toEqual({ ok: false, status: 409, error: GOOGLE_NOT_ISSUED });
    expect(GOOGLE_NOT_ISSUED).toMatch(/Connect again\.$/);
    expect(google.seen).toEqual([]);
  });

  it("keeps only a hash of each token, and forgets it when Google says it is gone or the account is deleted", async () => {
    const accountId = await person();
    await issue(accountId);
    expect(await recorded(accountId)).toEqual([await hashOf(REFRESH)]);
    const stored = JSON.stringify((await env.DB.prepare("SELECT * FROM cloud_google_refresh_tokens").all()).results);
    expect(stored).not.toContain(REFRESH);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const revoked = fakeGoogle(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
    expect(await googleToken(sharedOn(), accountId, { grant: "refresh", refreshToken: REFRESH }, revoked.fetcher, NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await recorded(accountId)).toEqual([]);
    const after = fakeGoogle(granted);
    expect(await googleToken(sharedOn(), accountId, { grant: "refresh", refreshToken: REFRESH }, after.fetcher, NOW)).toMatchObject({ ok: false, status: 409 });
    expect(after.seen).toEqual([]);
    await issue(accountId, "1//second-token");
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(accountId).run();
    expect(await recorded(accountId)).toEqual([]);
  });

  it("keeps no record when Google sends no refresh token", async () => {
    const accountId = await person();
    const google = fakeGoogle(() => Response.json({ access_token: ACCESS, expires_in: 3599, scope: "openid" }));
    expect(await googleToken(sharedOn(), accountId, { grant: "code", code: CODE, verifier: VERIFIER }, google.fetcher, NOW)).toMatchObject({ ok: true });
    expect(await recorded(accountId)).toEqual([]);
  });
});
