import { createHash, randomBytes } from "node:crypto";

export const GOOGLE_CALLBACK_PATH = "/google-oauth/callback";
export const GOOGLE_CLIENT_SITE = "googleapis.com";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_SCOPES = ["openid", "email", GMAIL_READONLY_SCOPE];
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GOOGLE_STATE_MS = 15 * 60_000;
export const GOOGLE_ACCOUNT_PREFIX = "google/";
export const GOOGLE_ACCOUNT_SUFFIX = "/REFRESH_TOKEN";
export const GMAIL_BODY_CHARS = 20_000;

export const GOOGLE_PROMPT =
  " To read the owner's Gmail, use gmail_search and gmail_read; for an emailed sign-in code, use gmail_code_to_vault, so the code goes to the vault without passing through you.";

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
}

export interface GoogleAccountRecord {
  email: string;
  refreshToken: string;
  scope: string;
  connectedAt: number;
}

export interface PendingGoogleAuth {
  state: string;
  verifier: string;
  botId: string;
  threadId: string;
  messageId?: string;
  loginHint?: string;
  createdAt: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

export function isGoogleEmail(value: unknown): value is string {
  return typeof value === "string" && EMAIL.test(value.trim());
}

export function googleAccountItem(email: string): string {
  const slug = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return `${GOOGLE_ACCOUNT_PREFIX}${slug}${GOOGLE_ACCOUNT_SUFFIX}`;
}

export function isGoogleAccountItem(name: string): boolean {
  return name.startsWith(GOOGLE_ACCOUNT_PREFIX) && name.endsWith(GOOGLE_ACCOUNT_SUFFIX);
}

export function parseGoogleAccount(raw: string | null): GoogleAccountRecord | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<GoogleAccountRecord>;
    if (!isGoogleEmail(value.email) || typeof value.refreshToken !== "string" || !value.refreshToken) return null;
    return { email: value.email, refreshToken: value.refreshToken, scope: String(value.scope ?? ""), connectedAt: Number(value.connectedAt) || 0 };
  } catch {
    return null;
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function googleAuthUrl(input: { client: GoogleClient; redirectUri: string; state: string; challenge: string; loginHint?: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", input.client.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent select_account");
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.href;
}

export class PendingGoogleAuths {
  private byState = new Map<string, PendingGoogleAuth>();
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  start(input: Omit<PendingGoogleAuth, "state" | "verifier" | "createdAt">): { pending: PendingGoogleAuth; challenge: string } {
    this.prune();
    const { verifier, challenge } = pkcePair();
    const pending: PendingGoogleAuth = { ...input, state: randomBytes(24).toString("base64url"), verifier, createdAt: this.now() };
    this.byState.set(pending.state, pending);
    return { pending, challenge };
  }

  attach(state: string, messageId: string): void {
    const pending = this.byState.get(state);
    if (pending) pending.messageId = messageId;
  }

  take(state: string): PendingGoogleAuth | null {
    this.prune();
    const pending = this.byState.get(state) ?? null;
    this.byState.delete(state);
    return pending;
  }

  private prune(): void {
    const cutoff = this.now() - GOOGLE_STATE_MS;
    for (const [state, pending] of this.byState) if (pending.createdAt < cutoff) this.byState.delete(state);
  }
}

async function googleJson(fetcher: FetchLike, url: string, init: RequestInit, what: string): Promise<Record<string, unknown>> {
  const response = await fetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new GoogleError(`${what} (HTTP ${response.status}).`, response.status);
  }
  return body;
}

export class GoogleError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function exchangeGoogleCode(fetcher: FetchLike, input: { client: GoogleClient; code: string; verifier: string; redirectUri: string }, now: number): Promise<GoogleAccountRecord> {
  const token = await googleJson(fetcher, GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: input.code, client_id: input.client.clientId, client_secret: input.client.clientSecret,
      redirect_uri: input.redirectUri, grant_type: "authorization_code", code_verifier: input.verifier,
    }).toString(),
  }, "Google did not accept the sign-in");
  const scope = String(token.scope ?? "");
  if (!scope.split(/\s+/).includes(GMAIL_READONLY_SCOPE)) throw new GoogleError("Google did not grant read access to Gmail. Connect again and leave the Gmail box ticked.", 400);
  if (typeof token.refresh_token !== "string" || !token.refresh_token) throw new GoogleError("Google sent no refresh token. Remove later.dog under myaccount.google.com/permissions and connect again.", 400);
  const info = await googleJson(fetcher, GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${String(token.access_token)}` } }, "Google did not say which account this is");
  if (!isGoogleEmail(info.email)) throw new GoogleError("Google did not say which account this is.", 400);
  return { email: info.email.toLowerCase(), refreshToken: token.refresh_token, scope, connectedAt: now };
}

export class GoogleAccessTokens {
  private cache = new Map<string, { token: string; until: number }>();
  private fetcher: FetchLike;
  private now: () => number;

  constructor(fetcher: FetchLike, now: () => number = Date.now) {
    this.fetcher = fetcher;
    this.now = now;
  }

  forget(email: string): void {
    this.cache.delete(email);
  }

  async token(client: GoogleClient, account: GoogleAccountRecord): Promise<string> {
    const cached = this.cache.get(account.email);
    if (cached && cached.until > this.now()) return cached.token;
    const body = await googleJson(this.fetcher, GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: client.clientId, client_secret: client.clientSecret, refresh_token: account.refreshToken, grant_type: "refresh_token",
      }).toString(),
    }, `Google refused ${account.email}'s saved access`);
    if (typeof body.access_token !== "string" || !body.access_token) throw new GoogleError("Google sent no access token.", 502);
    const token = body.access_token;
    const lifetime = Number(body.expires_in) || 3600;
    this.cache.set(account.email, { token, until: this.now() + Math.max(60, lifetime - 120) * 1000 });
    return token;
  }
}

export interface GmailSummary {
  id: string;
  threadId: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  internalDate: number;
}

interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailPart;
}

function header(part: GmailPart | undefined, name: string): string {
  return part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function summary(message: GmailMessage): GmailSummary {
  return {
    id: String(message.id ?? ""),
    threadId: String(message.threadId ?? ""),
    date: header(message.payload, "Date"),
    from: header(message.payload, "From"),
    to: header(message.payload, "To"),
    subject: header(message.payload, "Subject"),
    snippet: String(message.snippet ?? ""),
    internalDate: Number(message.internalDate) || 0,
  };
}

function decode(data: string | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf8") : "";
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

export function messageText(part: GmailPart | undefined): { text: string; attachments: string[] } {
  const plain: string[] = [];
  const html: string[] = [];
  const attachments: string[] = [];
  const walk = (node: GmailPart | undefined) => {
    if (!node) return;
    if (node.filename) attachments.push(node.filename);
    else if (node.mimeType === "text/plain") plain.push(decode(node.body?.data));
    else if (node.mimeType === "text/html") html.push(decode(node.body?.data));
    for (const child of node.parts ?? []) walk(child);
  };
  walk(part);
  const text = plain.join("\n").trim() || htmlToText(html.join("\n"));
  return { text, attachments };
}

export interface GmailClient {
  search(query: string, limit: number): Promise<GmailSummary[]>;
  read(id: string): Promise<GmailSummary & { text: string; attachments: string[]; labels: string[] }>;
}

export function gmailClient(fetcher: FetchLike, token: () => Promise<string>): GmailClient {
  const get = async (path: string) => googleJson(fetcher, `${GMAIL_API}${path}`, { headers: { authorization: `Bearer ${await token()}` } }, "Gmail refused the request");
  return {
    async search(query, limit) {
      const list = await get(`/messages?${new URLSearchParams({ q: query, maxResults: String(limit) })}`);
      const ids = ((list.messages as Array<{ id: string }> | undefined) ?? []).map((m) => m.id);
      const metas = await Promise.all(ids.map((id) =>
        get(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`)));
      return metas.map((m) => summary(m as GmailMessage));
    },
    async read(id) {
      const message = (await get(`/messages/${encodeURIComponent(id)}?format=full`)) as GmailMessage;
      const { text, attachments } = messageText(message.payload);
      return { ...summary(message), text: text.length > GMAIL_BODY_CHARS ? `${text.slice(0, GMAIL_BODY_CHARS)}…` : text, attachments, labels: message.labelIds ?? [] };
    },
  };
}

export function findCode(text: string, digits: number): string | null {
  const pattern = new RegExp(`(?<![\\d-])\\d{${digits}}(?![\\d-])`, "g");
  const found = text.match(pattern);
  return found?.[0] ?? null;
}

export function parseGoogleClient(username: string, password: string): GoogleClient | null {
  const clientId = username.trim();
  const clientSecret = password.trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function callbackPage(title: string, body: string): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>` +
    `<body style="font-family:-apple-system,system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1.5rem;line-height:1.5">` +
    `<h1 style="font-size:1.25rem">${escape(title)}</h1><p>${escape(body)}</p></body>`;
}
