import type { AppConfig } from "../config.ts";
import { smarterSuggestionsEnabled, typingSuggestionsEnabled } from "../config.ts";
import { trialAi } from "./included-trial.ts";
import { finishCompletion, looksSecret, typingModelInput, type TypingRequest } from "./typing-context.ts";

export const TYPING_DEFAULT_MODEL = "@cf/meta/llama-3.2-3b-instruct";
export const TYPING_INCLUDED_TIMEOUT_MS = 1_500;
export const TYPING_DIRECT_TIMEOUT_MS = 2_000;
export const TYPING_BACKOFF_MS = 5 * 60_000;
export const TYPING_MAX_IN_FLIGHT = 4;
export const TYPING_CACHE_SIZE = 64;
export const TYPING_CACHE_MS = 60_000;
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

export type TypingSource = "cloud" | "cloudflare";

export type TypingFailure = "off" | "not-allowed" | "no-service" | "sensitive" | "busy" | "unavailable" | "refused" | "timeout" | "failed";

export type TypingResult =
  | { ok: true; completion: string; source: TypingSource; ms: number; cached?: true }
  | { ok: false; reason: TypingFailure };

export type TypingBackend =
  | { kind: "cloud"; url: string; token: string }
  | { kind: "cloudflare"; url: string; token: string; model: string };

export interface IncludedCompletion {
  url: string;
  token: string;
}

export function includedCompletion(): IncludedCompletion | null {
  const ai = trialAi();
  if (!ai || !ai.api.endsWith("/ai")) return null;
  return { url: `${ai.api.slice(0, -"/ai".length)}/complete`, token: ai.token };
}

export function ownCloudflare(cfg: AppConfig): { accountId: string; token: string; model: string } | null {
  const accountId = cfg.typing?.accountId?.trim() ?? "";
  const token = cfg.typing?.token?.trim() ?? "";
  if (!ACCOUNT_ID.test(accountId) || !token) return null;
  return { accountId, token, model: cfg.typing?.model?.trim() || TYPING_DEFAULT_MODEL };
}

export interface CloudflareDraft {
  accountId: string;
  token: string;
  model?: string;
}

export function cloudflareBackend(own: { accountId: string; token: string; model: string }): TypingBackend {
  return { kind: "cloudflare", url: `${CLOUDFLARE_API}/accounts/${own.accountId}/ai/run/${own.model}`, token: own.token, model: own.model };
}

export function pickBackend(cfg: AppConfig, included: IncludedCompletion | null): TypingBackend | null {
  const own = ownCloudflare(cfg);
  if (own) return cloudflareBackend(own);
  return included ? { kind: "cloud", url: included.url, token: included.token } : null;
}

export function describeTyping(cfg: AppConfig, included: IncludedCompletion | null, ranking: boolean) {
  const own = ownCloudflare(cfg);
  return {
    enabled: typingSuggestionsEnabled(cfg),
    smarter: smarterSuggestionsEnabled(cfg),
    included: included !== null,
    cloudflare: { configured: own !== null, accountId: cfg.typing?.accountId?.trim() ?? "", model: cfg.typing?.model?.trim() || TYPING_DEFAULT_MODEL },
    ranking,
  };
}

function theirText(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const result = record.result && typeof record.result === "object" ? (record.result as Record<string, unknown>) : record;
  if (typeof result.completion === "string") return result.completion;
  if (typeof result.response === "string") return result.response;
  if (Array.isArray(result.choices)) {
    const first = result.choices[0] as { message?: { content?: unknown } } | undefined;
    if (typeof first?.message?.content === "string") return first.message.content;
  }
  return null;
}

function refusal(status: number): TypingFailure {
  if (status === 401 || status === 403) return "refused";
  if (status === 429) return "busy";
  if (status === 404 || status === 501 || status >= 500) return "unavailable";
  return "failed";
}

export interface TypingDeps {
  config(): AppConfig;
  included?(): IncludedCompletion | null;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface TypingService {
  complete(request: TypingRequest, signal?: AbortSignal): Promise<TypingResult>;
  test(draft?: CloudflareDraft): Promise<TypingResult>;
}

export function createTypingService(deps: TypingDeps): TypingService {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());
  const clock = deps.now ?? (() => Date.now());
  const includedNow = deps.included ?? includedCompletion;
  const cache = new Map<string, { at: number; completion: string; source: TypingSource }>();
  let inFlight = 0;
  let pausedUntil = 0;

  const keyOf = (request: TypingRequest, backend: TypingBackend) => JSON.stringify([backend.kind, request]);

  async function call(backend: TypingBackend, request: TypingRequest, signal?: AbortSignal): Promise<TypingResult> {
    const started = now();
    const timeout = AbortSignal.timeout(backend.kind === "cloud" ? TYPING_INCLUDED_TIMEOUT_MS : TYPING_DIRECT_TIMEOUT_MS);
    const joined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const body = backend.kind === "cloud"
      ? { prefix: request.prefix, dog: request.dog, messages: request.messages, phrasing: request.phrasing }
      : typingModelInput(request);
    let res: Response;
    try {
      res = await fetchImpl(backend.url, {
        method: "POST",
        headers: { authorization: `Bearer ${backend.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: joined,
      });
    } catch {
      return { ok: false, reason: timeout.aborted ? "timeout" : signal?.aborted ? "busy" : "unavailable" };
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, reason: refusal(res.status) };
    }
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { ok: false, reason: "failed" };
    }
    const said = theirText(parsed);
    if (said === null) return { ok: false, reason: "failed" };
    return { ok: true, completion: finishCompletion(request.prefix, said), source: backend.kind, ms: Math.max(0, Math.round(now() - started)) };
  }

  return {
    async complete(request, signal) {
      const cfg = deps.config();
      if (!typingSuggestionsEnabled(cfg)) return { ok: false, reason: "off" };
      if (!smarterSuggestionsEnabled(cfg)) return { ok: false, reason: "not-allowed" };
      const backend = pickBackend(cfg, includedNow());
      if (!backend) return { ok: false, reason: "no-service" };
      if (looksSecret(request.prefix)) return { ok: false, reason: "sensitive" };
      const at = clock();
      const key = keyOf(request, backend);
      const hit = cache.get(key);
      if (hit && at - hit.at < TYPING_CACHE_MS) return { ok: true, completion: hit.completion, source: hit.source, ms: 0, cached: true };
      if (backend.kind === "cloud" && at < pausedUntil) return { ok: false, reason: "unavailable" };
      if (inFlight >= TYPING_MAX_IN_FLIGHT) return { ok: false, reason: "busy" };
      inFlight += 1;
      try {
        const result = await call(backend, request, signal);
        if (!result.ok) {
          if (backend.kind === "cloud" && (result.reason === "unavailable" || result.reason === "refused")) pausedUntil = clock() + TYPING_BACKOFF_MS;
          return result;
        }
        pausedUntil = 0;
        cache.set(key, { at: clock(), completion: result.completion, source: result.source });
        if (cache.size > TYPING_CACHE_SIZE) cache.delete(cache.keys().next().value as string);
        return result;
      } finally {
        inFlight -= 1;
      }
    },
    async test(draft) {
      const cfg = deps.config();
      const accountId = draft?.accountId.trim() ?? "";
      const token = draft?.token.trim() ?? "";
      if (draft && (!ACCOUNT_ID.test(accountId) || !token)) return { ok: false, reason: "failed" };
      const backend = draft
        ? cloudflareBackend({ accountId, token, model: draft.model?.trim() || TYPING_DEFAULT_MODEL })
        : pickBackend(cfg, includedNow());
      if (!backend) return { ok: false, reason: "no-service" };
      return call(backend, { prefix: "Could you please ", dog: "", messages: [], phrasing: [] });
    },
  };
}
