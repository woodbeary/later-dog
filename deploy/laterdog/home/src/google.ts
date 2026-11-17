import { authorizedState } from "./state.ts";

export const GOOGLE_HOST = "google.internal";
export const GOOGLE_MAX_BYTES = 8 * 1024;

export const GOOGLE_UNREACHABLE = "later.dog's Google connection can't be reached right now. Try again in a minute.";
export const GOOGLE_SWITCHED_OFF = "later.dog's Google connection isn't switched on yet.";
const TOO_BIG = "That Google request is too big.";
const UNREADABLE = "That Google request could not be read.";

export interface GoogleClientInfo {
  clientId: string;
  redirectUri: string;
}

export interface GoogleTokenSet {
  access_token: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export type GoogleTokenResult = { ok: true; token: GoogleTokenSet } | { ok: false; status: number; error: string };

export interface GoogleAccounts {
  googleClient?(): Promise<GoogleClientInfo | null>;
  googleToken?(accountId: string, grant: unknown): Promise<GoogleTokenResult>;
}

const NO_ANSWER = Symbol("no answer");

async function ask<T>(call: () => Promise<T> | T): Promise<T | typeof NO_ANSWER> {
  try {
    return await call();
  } catch {
    return NO_ANSWER;
  }
}

function clientInfo(value: unknown): GoogleClientInfo | null | typeof NO_ANSWER {
  if (value === null) return null;
  const client = value as Partial<GoogleClientInfo> | undefined;
  if (typeof client?.clientId !== "string" || !client.clientId || typeof client.redirectUri !== "string" || !client.redirectUri) return NO_ANSWER;
  return { clientId: client.clientId, redirectUri: client.redirectUri };
}

function tokenAnswer(value: unknown): Response {
  const result = value as Partial<{ ok: boolean; token: Partial<GoogleTokenSet>; status: number; error: string }> | undefined;
  if (result?.ok === false && typeof result.error === "string" && Number.isInteger(result.status) && result.status! >= 400 && result.status! <= 599) {
    return Response.json({ error: result.error }, { status: result.status });
  }
  const token = result?.ok === true ? result.token : undefined;
  if (!token || typeof token.access_token !== "string" || typeof token.expires_in !== "number" || typeof token.scope !== "string") {
    return Response.json({ error: GOOGLE_UNREACHABLE }, { status: 503 });
  }
  return Response.json({
    access_token: token.access_token,
    expires_in: token.expires_in,
    scope: token.scope,
    ...(typeof token.refresh_token === "string" ? { refresh_token: token.refresh_token } : {}),
  });
}

async function boundedText(request: Request, limit: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function handleGoogle(request: Request, params: { token?: string; accountId?: string } | undefined, accounts: GoogleAccounts): Promise<Response> {
  const accountId = params?.accountId;
  if (!accountId || !(await authorizedState(request, params?.token))) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const path = new URL(request.url).pathname;
  if (path === "/client") {
    if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
    const answered = await ask(() => accounts.googleClient!());
    const client = answered === NO_ANSWER ? NO_ANSWER : clientInfo(answered);
    if (client === NO_ANSWER) return Response.json({ error: GOOGLE_UNREACHABLE }, { status: 503 });
    if (!client) return Response.json({ error: GOOGLE_SWITCHED_OFF }, { status: 404 });
    return Response.json(client);
  }
  if (path === "/token") {
    if (request.method !== "POST") return Response.json({ error: "Method not allowed" }, { status: 405 });
    if (Number(request.headers.get("content-length") ?? "0") > GOOGLE_MAX_BYTES) return Response.json({ error: TOO_BIG }, { status: 413 });
    const raw = await boundedText(request, GOOGLE_MAX_BYTES);
    if (raw === null) return Response.json({ error: TOO_BIG }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return Response.json({ error: UNREADABLE }, { status: 400 });
    }
    const answered = await ask(() => accounts.googleToken!(accountId, body));
    if (answered === NO_ANSWER) return Response.json({ error: GOOGLE_UNREACHABLE }, { status: 503 });
    return tokenAnswer(answered);
  }
  return Response.json({ error: "Not found" }, { status: 404 });
}
