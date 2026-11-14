import { readConfig } from "./config";

export const GOOGLE_CALLBACK_PATH = "/google-oauth/callback";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_TOKENS_PER_DAY = 500;
export const GOOGLE_TIMEOUT_MS = 10_000;

export const GOOGLE_OFF = "later.dog's Google connection isn't switched on yet.";
export const GOOGLE_UNREADABLE = "later.dog could not read that Google request.";
export const GOOGLE_NO_ACCOUNT = "This home has no account anymore.";
export const GOOGLE_CAPPED = "Your dogs have asked Google for access too many times today. It works again tomorrow.";
export const GOOGLE_EXPIRED = "Google no longer accepts this connection. Connect again.";
export const GOOGLE_FAILED = "Google didn't answer as expected. Try again in a minute.";

const DAY_MS = 24 * 60 * 60 * 1000;
const CALLBACK_STATE = /^(h[0-9a-f]{24})\.[A-Za-z0-9_-]{16,128}$/;
const HOST_SUFFIX = /^-[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const CLIENT_ID = /^[\w.-]{1,200}\.apps\.googleusercontent\.com$/;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const GOOGLE_VALUE = /^[\x21-\x7e]{1,2048}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PASSED_ON = ["state", "code", "error"] as const;
const PASSED_ON_CHARS = 2048;

export interface GoogleClientInfo {
  clientId: string;
  redirectUri: string;
}

export type GoogleGrant =
  | { grant: "code"; code: string; verifier: string }
  | { grant: "refresh"; refreshToken: string };

export interface GoogleTokenSet {
  access_token: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export type GoogleTokenResult = { ok: true; token: GoogleTokenSet } | { ok: false; status: number; error: string };

export type GoogleFetch = (input: string, init: RequestInit) => Promise<Response>;

function setting(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

export function homeHostSuffix(env: Env): string | null {
  const suffix = setting(env, "CLOUD_HOME_HOST_SUFFIX");
  return HOST_SUFFIX.test(suffix) && suffix.length <= 200 ? suffix : null;
}

export function homeCallbackTarget(search: URLSearchParams, suffix: string | null): string | null {
  if (!suffix || !HOST_SUFFIX.test(suffix)) return null;
  const states = search.getAll("state");
  const label = states.length === 1 ? CALLBACK_STATE.exec(states[0]!)?.[1] : undefined;
  if (!label) return null;
  const host = `${label}${suffix}`;
  const target = new URL(`https://${host}${GOOGLE_CALLBACK_PATH}`);
  if (target.hostname !== host || target.port || target.username || target.password) return null;
  for (const name of PASSED_ON) {
    const values = search.getAll(name);
    if (values.length > 1) return null;
    const value = values[0];
    if (value === undefined) continue;
    if (value.length > PASSED_ON_CHARS) return null;
    target.searchParams.set(name, value);
  }
  return target.href;
}

const EXPIRED_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>This link has expired</title>
<link rel="stylesheet" href="/cloud/style.css">
</head>
<body>
<main>
<div class="brand">later.dog</div>
<h1>This link has expired</h1>
<p>Go back to later.dog and ask your dog to connect Google again.</p>
</main>
</body>
</html>`;

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

export function googleCallback(request: Request, env: Env): Response | null {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);
  if (url.pathname !== GOOGLE_CALLBACK_PATH) return null;
  const target = homeCallbackTarget(url.searchParams, homeHostSuffix(env));
  if (!target) return new Response(EXPIRED_PAGE, { status: 400, headers: PAGE_HEADERS });
  return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

export function sharedGoogleClient(env: Env): GoogleClientInfo | null {
  const clientId = setting(env, "GOOGLE_CLIENT_ID");
  if (!CLIENT_ID.test(clientId) || !setting(env, "GOOGLE_CLIENT_SECRET")) return null;
  return { clientId, redirectUri: `${readConfig(env).authBaseURL}${GOOGLE_CALLBACK_PATH}` };
}

export function parseGoogleGrant(input: unknown): GoogleGrant | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (value.grant === "code" && typeof value.code === "string" && GOOGLE_VALUE.test(value.code) && typeof value.verifier === "string" && VERIFIER.test(value.verifier)) {
    return { grant: "code", code: value.code, verifier: value.verifier };
  }
  if (value.grant === "refresh" && typeof value.refreshToken === "string" && GOOGLE_VALUE.test(value.refreshToken)) {
    return { grant: "refresh", refreshToken: value.refreshToken };
  }
  return null;
}

function tokenSet(answer: Record<string, unknown> | null): GoogleTokenSet | null {
  if (!answer || typeof answer.access_token !== "string" || !GOOGLE_VALUE.test(answer.access_token)) return null;
  const lifetime = Number(answer.expires_in);
  return {
    access_token: answer.access_token,
    expires_in: Number.isFinite(lifetime) && lifetime > 0 ? Math.trunc(lifetime) : 3600,
    scope: typeof answer.scope === "string" ? answer.scope : "",
    ...(typeof answer.refresh_token === "string" && GOOGLE_VALUE.test(answer.refresh_token) ? { refresh_token: answer.refresh_token } : {}),
  };
}

function failed(errorCode: string, status = 502, error = GOOGLE_FAILED): GoogleTokenResult {
  console.error(JSON.stringify({ message: "google token request failed", errorCode }));
  return { ok: false, status, error };
}

export async function googleToken(
  env: Env,
  accountId: unknown,
  input: unknown,
  fetcher: GoogleFetch = (target, init) => fetch(target, init),
  now = Date.now(),
): Promise<GoogleTokenResult> {
  const client = sharedGoogleClient(env);
  if (!client) return { ok: false, status: 503, error: GOOGLE_OFF };
  const grant = parseGoogleGrant(input);
  if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId) || !grant) return { ok: false, status: 400, error: GOOGLE_UNREADABLE };
  const user = await env.DB.prepare('SELECT id FROM "user" WHERE id = ?').bind(accountId).first<{ id: string }>();
  if (!user) return { ok: false, status: 404, error: GOOGLE_NO_ACCOUNT };
  const counted = await env.DB.prepare(
    `INSERT INTO cloud_google_tokens (account_id, day, calls) VALUES (?, ?, 1)
     ON CONFLICT(account_id, day) DO UPDATE SET calls = calls + 1 WHERE calls < ?`,
  ).bind(accountId, Math.floor(now / DAY_MS), GOOGLE_TOKENS_PER_DAY).run();
  if (counted.meta.changes === 0) return { ok: false, status: 429, error: GOOGLE_CAPPED };
  const form = new URLSearchParams({ client_id: client.clientId, client_secret: setting(env, "GOOGLE_CLIENT_SECRET") });
  if (grant.grant === "code") {
    form.set("grant_type", "authorization_code");
    form.set("code", grant.code);
    form.set("code_verifier", grant.verifier);
    form.set("redirect_uri", client.redirectUri);
  } else {
    form.set("grant_type", "refresh_token");
    form.set("refresh_token", grant.refreshToken);
  }
  let response: Response;
  try {
    response = await fetcher(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
  } catch {
    return failed("google_unreachable");
  }
  const answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    if (answer?.error === "invalid_grant") return failed("google_invalid_grant", 400, GOOGLE_EXPIRED);
    return failed(response.status >= 300 && response.status < 400 ? "google_redirected" : "google_refused");
  }
  const token = tokenSet(answer);
  return token ? { ok: true, token } : failed("google_unreadable");
}
