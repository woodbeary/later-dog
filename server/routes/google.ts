import {
  callbackPage,
  exchangeGoogleCode,
  findCode,
  GoogleError,
  googleAuthUrl,
  gmailClient,
  GOOGLE_STATE_MS,
  isGoogleEmail,
  type FetchLike,
  type GoogleAccessTokens,
  type GoogleAccountRecord,
  type GoogleClient,
  type PendingGoogleAuth,
  type PendingGoogleAuths,
} from "../laterdog/google.ts";
import { secretNameProblem, vaultFingerprint } from "../laterdog/vault-refs.ts";
import type { BotRecord } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";

export const GOOGLE_INTERNAL_PATH = "/api/internal/google";
export const GOOGLE_OWNER_ONLY = "Only the owner's own dogs, working for the owner, can connect or read the owner's Google accounts.";
export const GOOGLE_NEEDS_CLIENT =
  "later.dog has no Google OAuth client yet, so there is nothing to connect. The owner adds one once: in Settings → Vault, a login for googleapis.com with the OAuth client ID as the username and the client secret as the password. Tell them that in one short line, with the redirect address from this message, and end the turn.";

export interface GoogleRouteDeps {
  ownerActing(threadId: string): boolean;
  client(): GoogleClient | null;
  redirectUri(): string | null;
  accounts(): GoogleAccountRecord[];
  saveAccount(account: GoogleAccountRecord, by: string): void;
  saveSecret(name: string, value: string, by: string): { replaced: boolean };
  pending: PendingGoogleAuths;
  tokens: GoogleAccessTokens;
  fetcher: FetchLike;
  postCard(sender: BotRecord, threadId: string, input: { url: string; service: string; expiresAt: number }): string;
  finishCard(pending: PendingGoogleAuth, outcome: "connected" | "failed", detail: string): void;
  now(): number;
}

export function pickAccount(accounts: readonly GoogleAccountRecord[], asked: unknown): GoogleAccountRecord | string {
  const want = typeof asked === "string" ? asked.trim().toLowerCase() : "";
  if (!accounts.length) return "No Google account is connected yet. Call connect_google first.";
  if (want) {
    const found = accounts.find((account) => account.email === want);
    return found ?? `${want} isn't connected. Connected: ${accounts.map((a) => a.email).join(", ")}. Call connect_google with account ${want} to add it.`;
  }
  if (accounts.length === 1) return accounts[0]!;
  return `More than one Google account is connected; name one with account: ${accounts.map((a) => a.email).join(", ")}.`;
}

export function maskDigits(text: string, digits: number): string {
  return text.replace(new RegExp(`\\d{${digits}}`, "g"), "•".repeat(digits));
}

export function createGoogleRoute(deps: GoogleRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, sender, threadId }) => {
    if (path !== GOOGLE_INTERNAL_PATH || method !== "POST") return PASS;
    if (!deps.ownerActing(threadId)) return json(res, 403, { error: GOOGLE_OWNER_ONLY });
    const body = (await readBody()) ?? {};
    const action = String(body.action ?? "");
    const accounts = deps.accounts();
    if (action === "connect") {
      const client = deps.client();
      const redirectUri = deps.redirectUri();
      if (!redirectUri) return json(res, 409, { error: "This later.dog has no public address, so Google has nowhere to send the approval back to." });
      if (!client) return json(res, 409, { error: `${GOOGLE_NEEDS_CLIENT} Redirect address: ${redirectUri}` });
      const hint = isGoogleEmail(body.account) ? body.account.trim().toLowerCase() : undefined;
      const { pending, challenge } = deps.pending.start({ botId: sender.id, threadId, ...(hint ? { loginHint: hint } : {}) });
      const url = googleAuthUrl({ client, redirectUri, state: pending.state, challenge, ...(hint ? { loginHint: hint } : {}) });
      const messageId = deps.postCard(sender, threadId, { url, service: `Google${hint ? ` (${hint})` : ""}`, expiresAt: deps.now() + GOOGLE_STATE_MS });
      deps.pending.attach(pending.state, messageId);
      const already = hint && accounts.some((a) => a.email === hint) ? ` ${hint} is already connected; approving again refreshes it.` : "";
      return json(res, 201, {
        text: `The owner now sees a Connect Google card that opens Google's own consent page on their phone or Mac, for read-only Gmail.${already} End this turn with one short line, for example "Tap Open, approve with your passkey, and I'll carry on." Never open the consent page in your own browser. later.dog wakes you when Google sends the approval back, or after 15 minutes.`,
      });
    }
    if (action === "accounts") {
      return json(res, 200, { text: accounts.length
        ? `Connected Google accounts (read-only Gmail): ${accounts.map((a) => a.email).join(", ")}.`
        : "No Google account is connected. Call connect_google." });
    }
    const client = deps.client();
    if (!client) return json(res, 409, { error: GOOGLE_NEEDS_CLIENT });
    const account = pickAccount(accounts, body.account);
    if (typeof account === "string") return json(res, 404, { error: account });
    const gmail = gmailClient(deps.fetcher, () => deps.tokens.token(client, account));
    try {
      if (action === "search") {
        const query = String(body.query ?? "").trim();
        if (!query) return json(res, 400, { error: "gmail_search needs query, in Gmail's search words, for example \"from:nextdoor.com newer_than:1d\"." });
        const limit = Math.min(Math.max(Math.trunc(Number(body.limit) || 10), 1), 25);
        const hits = await gmail.search(query, limit);
        return json(res, 200, { account: account.email, messages: hits });
      }
      if (action === "read") {
        const id = String(body.id ?? "").trim();
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return json(res, 400, { error: "gmail_read needs message_id from a gmail_search result." });
        return json(res, 200, { account: account.email, message: await gmail.read(id) });
      }
      if (action === "code") {
        const from = String(body.from ?? "").trim();
        if (!from || /[\s()]/.test(from)) return json(res, 400, { error: "gmail_code_to_vault needs from: the sender's address or domain, for example nextdoor.com." });
        const name = String(body.name ?? "").trim();
        const problem = secretNameProblem(name);
        if (problem) return json(res, 400, { error: problem });
        const digits = Math.min(Math.max(Math.trunc(Number(body.digits) || 6), 4), 10);
        const minutes = Math.min(Math.max(Math.trunc(Number(body.within_minutes) || 15), 1), 24 * 60);
        const after = Math.floor((deps.now() - minutes * 60_000) / 1000);
        const hits = await gmail.search(`from:${from} after:${after}`, 5);
        for (const hit of hits) {
          const full = await gmail.read(hit.id);
          const code = findCode(`${full.subject}\n${full.text}`, digits);
          if (!code) continue;
          const saved = deps.saveSecret(name, code, `${sender.name} from ${account.email}`);
          return json(res, 200, {
            text: JSON.stringify({
              name, fingerprint: vaultFingerprint(code), digits, replaced: saved.replaced,
              from: full.from, subject: maskDigits(full.subject, digits), received: new Date(full.internalDate).toISOString(),
            }),
          });
        }
        return json(res, 404, { error: `No ${digits}-digit code from ${from} in ${account.email} in the last ${minutes} minutes. If the email is still on its way, wait a little and try again.` });
      }
    } catch (error) {
      if (error instanceof GoogleError && (error.status === 400 || error.status === 401)) deps.tokens.forget(account.email);
      return json(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
    return json(res, 400, { error: "Use action connect, accounts, search, read or code." });
  };
}

export async function answerGoogleCallback(deps: Pick<GoogleRouteDeps, "client" | "redirectUri" | "pending" | "fetcher" | "saveAccount" | "finishCard" | "now" | "tokens">, search: URLSearchParams): Promise<{ status: number; html: string }> {
  const state = search.get("state") ?? "";
  const pending = state ? deps.pending.take(state) : null;
  if (!pending) return { status: 400, html: callbackPage("This link has expired", "Go back to later.dog and ask your dog to connect Google again.") };
  const denied = search.get("error");
  if (denied) {
    deps.finishCard(pending, "failed", denied === "access_denied" ? "The owner declined on Google's page." : "Google did not approve the connection.");
    return { status: 200, html: callbackPage("Not connected", "Nothing was shared with later.dog. You can close this page.") };
  }
  const client = deps.client();
  const redirectUri = deps.redirectUri();
  const code = search.get("code") ?? "";
  if (!client || !redirectUri || !code) {
    deps.finishCard(pending, "failed", "Google's answer was incomplete.");
    return { status: 400, html: callbackPage("Not connected", "Google's answer was incomplete. Go back to later.dog and try again.") };
  }
  try {
    const account = await exchangeGoogleCode(deps.fetcher, { client, code, verifier: pending.verifier, redirectUri }, deps.now());
    if (pending.loginHint && pending.loginHint !== account.email) throw new GoogleError(`You approved ${account.email}, but this request is for ${pending.loginHint}. Connect again and choose that account.`, 400);
    deps.saveAccount(account, "Google sign-in");
    deps.tokens.forget(account.email);
    const other = pending.loginHint && pending.loginHint !== account.email ? ` (you asked for ${pending.loginHint})` : "";
    deps.finishCard(pending, "connected", `Connected ${account.email}${other} with read-only Gmail.`);
    return { status: 200, html: callbackPage(`Connected ${account.email}`, "later.dog can now read this Gmail, read-only. You can close this page.") };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    deps.finishCard(pending, "failed", detail);
    return { status: 400, html: callbackPage("Not connected", detail) };
  }
}
