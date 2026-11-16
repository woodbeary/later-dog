import {
  GOOGLE_CALLBACK_PATH,
  GoogleError,
  ownGoogleIssuer,
  type FetchLike,
  type GoogleAccountRecord,
  type GoogleClient,
  type GoogleGrant,
  type GoogleIssuer,
  type SharedGoogleClient,
} from "./google.ts";

export const GOOGLE_SHARED_OFF =
  "later.dog's Google connection isn't switched on yet, so there is nothing to connect right now. Tell the owner that in one short line and end the turn.";
export const GOOGLE_SHARED_UNREACHABLE = "later.dog's Google connection can't be reached right now. Try again in a minute.";
export const SHARED_MACHINE_ID = /^h[0-9a-f]{24}$/;
const CLIENT_ID = /^[\w.-]+\.apps\.googleusercontent\.com$/;
const TIMEOUT_MS = 20_000;

export type SharedClientAnswer = SharedGoogleClient | "off" | "unreachable";

export interface SharedGoogle {
  client(): Promise<SharedClientAnswer>;
  token(grant: GoogleGrant): Promise<Record<string, unknown>>;
}

export interface CloudGoogle {
  machineId: string;
  shared: SharedGoogle | null;
}

export function sharedClientInfo(value: unknown): SharedGoogleClient | null {
  const { clientId, redirectUri } = (value ?? {}) as Partial<Record<keyof SharedGoogleClient, unknown>>;
  if (typeof clientId !== "string" || !CLIENT_ID.test(clientId) || typeof redirectUri !== "string") return null;
  try {
    const url = new URL(redirectUri);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== GOOGLE_CALLBACK_PATH) return null;
    return { clientId, redirectUri: url.href };
  } catch {
    return null;
  }
}

export function cloudGoogleConnection(url: string | undefined, token: string | undefined, fetcher: FetchLike = (target, init) => fetch(target, init)): SharedGoogle | null {
  if (!url || !token) return null;
  const base = url.replace(/\/+$/, "");
  const authorization = `Bearer ${token}`;
  return {
    async client() {
      let text: string;
      try {
        const response = await fetcher(`${base}/client`, { headers: { authorization }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        if (response.status === 404) return "off";
        if (!response.ok) return "unreachable";
        text = await response.text();
      } catch {
        return "unreachable";
      }
      try {
        return sharedClientInfo(JSON.parse(text)) ?? "off";
      } catch {
        return "off";
      }
    },
    async token(grant) {
      let response: Response;
      try {
        response = await fetcher(`${base}/token`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(grant),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new GoogleError(GOOGLE_SHARED_UNREACHABLE, 503);
      }
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !body) throw new GoogleError(typeof body?.error === "string" ? body.error : GOOGLE_SHARED_UNREACHABLE, response.ok ? 502 : response.status);
      return body;
    },
  };
}

export function sharedGoogleIssuer(shared: SharedGoogle, client: SharedGoogleClient): GoogleIssuer {
  return { clientId: client.clientId, redirectUri: client.redirectUri, token: (grant) => shared.token(grant) };
}

export async function sharedConnectClient(cloud: CloudGoogle | null | undefined): Promise<SharedClientAnswer> {
  if (!cloud?.shared || !SHARED_MACHINE_ID.test(cloud.machineId)) return "off";
  return cloud.shared.client();
}

export function googleReconnect(email: string): string {
  return `${email} was connected through a Google connection this later.dog no longer has. Call connect_google with account ${email} to connect it again.`;
}

export async function issuerForAccount(input: { own: GoogleClient | null; cloud: CloudGoogle | null | undefined; fetcher: FetchLike }, account: GoogleAccountRecord): Promise<GoogleIssuer> {
  const { own, cloud } = input;
  if (own && (!account.clientId || account.clientId === own.clientId)) return ownGoogleIssuer(input.fetcher, own, "");
  if (account.clientId && cloud?.shared) {
    const client = await cloud.shared.client();
    if (typeof client !== "string" && client.clientId === account.clientId) return sharedGoogleIssuer(cloud.shared, client);
    if (typeof client === "string") throw new GoogleError(`${account.email} uses later.dog's Google connection, which can't be reached or is switched off right now. Try again later; if it keeps failing, call connect_google with account ${account.email} to connect it again.`, 503);
  }
  throw new GoogleError(googleReconnect(account.email), 409);
}
