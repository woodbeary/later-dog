import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";

const LOGIN = "account/login/start";
const AUTH_TYPE = "chatgptAuthTokens";
const REFRESH = "account/chatgptAuthTokens/refresh";
const LOGIN_ID_PREFIX = "laterdog-external-account-";
const LOGIN_TIMEOUT_MS = 30_000;
const ACCOUNT_REQUIRED = "The home could not lend the selected Codex account.";
const REFRESH_REQUIRED = "The home could not refresh the selected Codex account.";

type RpcId = number | string;
type Credential = { accessToken: string; chatgptAccountId: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const requestId = (value: unknown): value is RpcId => (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isSafeInteger(value));

export interface CodexExternalAuthSource {
  read(): Promise<unknown>;
  refresh(): Promise<unknown>;
}

export function codexExternalAccount(accountId: string, source: CodexExternalAuthSource) {
  if (!accountId) throw new Error(ACCOUNT_REQUIRED);
  let renewal: Promise<Credential | null> | undefined;
  const project = (value: unknown): Credential | null => {
    const auth = record(value);
    if (auth.auth_mode !== undefined && auth.auth_mode !== "chatgpt") return null;
    const tokens = record(auth.tokens);
    const access = tokens.access_token;
    if (tokens.account_id !== accountId || typeof access !== "string" || !access || /\s/.test(access)) return null;
    return { accessToken: access, chatgptAccountId: accountId };
  };
  const load = async (read: () => Promise<unknown>) => {
    try { return project(await read()); } catch { return null; }
  };
  return {
    accountId,
    read: () => load(() => source.read()),
    refresh: () => renewal ??= load(() => source.refresh()).finally(() => { renewal = undefined; }),
  };
}

export type CodexExternalAccount = ReturnType<typeof codexExternalAccount>;

export function codexExternalAuthChannel(account: CodexExternalAccount, stdin: Pick<Writable, "write">) {
  const id = `${LOGIN_ID_PREFIX}${randomUUID()}`;
  let closed = false;
  let signedIn = false;
  let login: Promise<void> | undefined;
  let settleLogin: ((accepted: boolean) => void) | undefined;
  const refreshing = new Set<RpcId>();
  const send = (frame: Record<string, unknown>) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);

  const signIn = () => login ??= (async () => {
    const credentials = await account.read();
    if (closed || !credentials) throw new Error(ACCOUNT_REQUIRED);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => settleLogin?.(false), LOGIN_TIMEOUT_MS);
      timer.unref();
      settleLogin = (accepted) => {
        clearTimeout(timer);
        settleLogin = undefined;
        signedIn = accepted;
        if (accepted) resolve(); else reject(new Error(ACCOUNT_REQUIRED));
      };
      try { send({ id, method: LOGIN, params: { type: AUTH_TYPE, ...credentials } }); }
      catch { settleLogin?.(false); }
    });
  })();

  const close = () => {
    closed = true;
    settleLogin?.(false);
  };

  const refresh = async (request: RpcId, params: Record<string, unknown>) => {
    try {
      const previous = params.previousAccountId;
      const selected = previous === undefined || previous === null || previous === account.accountId;
      const result = !closed && signedIn && selected && params.reason === "unauthorized" ? await account.refresh() : null;
      if (!closed) send(result ? { id: request, result } : { id: request, error: { code: -32000, message: REFRESH_REQUIRED } });
    } catch { close(); }
    finally { refreshing.delete(request); }
  };

  const receive = (frame: unknown) => {
    const message = record(frame);
    if (message.method === REFRESH) {
      if (requestId(message.id) && !refreshing.has(message.id)) {
        refreshing.add(message.id);
        void refresh(message.id, record(message.params));
      }
      return true;
    }
    if (message.id !== id || message.method !== undefined) return false;
    settleLogin?.(message.error === undefined && record(message.result).type === AUTH_TYPE);
    return true;
  };

  return { signIn, receive, close };
}

export function redactCodexExternalAuthFrame(frame: unknown): unknown {
  const { method, id, params, result } = record(frame);
  const login = method === LOGIN && record(params).type === AUTH_TYPE;
  const reserved = typeof id === "string" && id.startsWith(LOGIN_ID_PREFIX);
  if (!login && method !== REFRESH && !reserved && typeof record(result).accessToken !== "string") return frame;
  return { jsonrpc: "2.0", ...(login || method === REFRESH ? { method } : {}), auth: "[account authentication omitted]" };
}
