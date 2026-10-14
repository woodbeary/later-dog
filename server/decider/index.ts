import type { AppConfig } from "../config.ts";
import { deciderCredential, type ServiceCredential } from "../included-services.ts";
import { jevBackend } from "./jev.ts";
import { appendDeciderLog, stateHash } from "./log.ts";
import { KEY_CHECK_QUESTION, KEY_CHECK_STATE, relayAccepts, relaySeam } from "./relay.ts";
import { DECIDER_MODELS } from "./types.ts";
import type {
  Answers, AskOptions, BackendResult, ChoiceAnswer, ChoiceQuestion, DeciderBackend, DeciderFailure, DeciderJob, DeciderModel,
  DeciderProvider, DeciderQuestion, DeciderResult, DeciderSeam, ScoreAnswer, YesNoAnswer,
} from "./types.ts";

export { DECIDER_JOBS, DECIDER_MODELS } from "./types.ts";

export const DEFAULT_DECIDER_TIMEOUT_MS = 1_500;
export const KEY_CHECK_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;

const offBackend: { id: "off"; decide(): Promise<BackendResult> } = {
  id: "off",
  decide: async () => ({ ok: false, reason: "disabled" }),
};
const BACKENDS: Record<DeciderProvider, DeciderBackend> = { jev: jevBackend };

type DeciderConfig = NonNullable<AppConfig["decider"]>;

export function deciderProvider(cfg: AppConfig): DeciderProvider | "off" {
  const provider = cfg.decider?.provider ?? "jev";
  return provider in BACKENDS ? (provider as DeciderProvider) : "off";
}

function deciderAccount(cfg: AppConfig, seam?: DeciderSeam, draft?: string): ServiceCredential | null {
  const account = deciderCredential(draft?.trim() || cfg.decider?.key, cfg.decider?.baseUrl);
  return account?.included && seam && !relaySeam(seam) ? null : account;
}

export function deciderConfigured(cfg: AppConfig): boolean {
  return Boolean(deciderAccount(cfg));
}

export function deciderIncludedHere(): boolean {
  return deciderCredential(undefined, undefined)?.included === true;
}

export function deciderEnabled(cfg: AppConfig): boolean {
  const account = deciderAccount(cfg);
  if (!account || deciderProvider(cfg) === "off") return false;
  return account.included ? cfg.decider?.enabled !== false : cfg.decider?.enabled === true;
}

const OPT_IN_JOBS: ReadonlySet<DeciderJob> = new Set<DeciderJob>(["autoReview", "turnEnd", "screenCheck", "screenshotFilter"]);

export function deciderJobOn(cfg: AppConfig, job: DeciderJob): boolean {
  const saved = cfg.decider?.jobs?.[job];
  return OPT_IN_JOBS.has(job) ? saved === true : saved !== false;
}

export function deciderEndpointLabel(cfg: AppConfig): string {
  const account = deciderAccount(cfg);
  if (account?.included) return "later.dog Cloud";
  const base = cfg.decider?.baseUrl?.trim();
  if (base) {
    try {
      return new URL(base).host;
    } catch {
      return "your decision endpoint";
    }
  }
  return "api.typesafe.ai";
}

export function deciderCanRun(cfg: AppConfig, job: DeciderJob): boolean {
  return deciderEnabled(cfg) && Boolean(deciderAccount(cfg, job));
}

export function deciderReady(cfg: AppConfig, job: DeciderJob): boolean {
  return deciderEnabled(cfg) && deciderJobOn(cfg, job) && Boolean(deciderAccount(cfg, job));
}

export const JOB_MODEL_DEFAULTS: Partial<Record<DeciderJob, DeciderModel>> = {
  autoReview: "clef",
  screenCheck: "clef",
  screenshotFilter: "clef",
  turnEnd: "clef-flash",
};

const TYPESAFE_HOSTS: ReadonlySet<string> = new Set(["api.typesafe.ai"]);

function clefEndpoint(cfg: AppConfig): boolean {
  const account = deciderAccount(cfg);
  if (account?.included) return true;
  const base = cfg.decider?.baseUrl?.trim();
  if (!base) return false;
  try {
    return !TYPESAFE_HOSTS.has(new URL(base).host);
  } catch {
    return false;
  }
}

export function deciderModel(cfg: AppConfig): DeciderModel | undefined {
  const model = cfg.decider?.model;
  return model && DECIDER_MODELS.includes(model) ? model : undefined;
}

export function deciderModelFor(cfg: AppConfig, job: DeciderJob): DeciderModel | undefined {
  const own = (cfg.decider?.models as Partial<Record<DeciderJob, DeciderModel>> | undefined)?.[job];
  if (own && DECIDER_MODELS.includes(own)) return own;
  return deciderModel(cfg) ?? (clefEndpoint(cfg) ? JOB_MODEL_DEFAULTS[job] : undefined);
}

export function deciderImagesReady(cfg: AppConfig, job: DeciderJob): boolean {
  return deciderReady(cfg, job) && deciderModelFor(cfg, job) !== undefined;
}

export function describeDecider(cfg: AppConfig) {
  const account = deciderAccount(cfg);
  return {
    provider: "jev" as const,
    configured: Boolean(account),
    ...(account?.included ? { included: true as const } : {}),
    enabled: deciderEnabled(cfg),
    jobs: { roomRouting: deciderJobOn(cfg, "roomRouting") },
  };
}

export function deciderSavePatch(
  patch: Partial<DeciderConfig>,
  current: DeciderConfig | undefined,
  included = false,
): { ok: true; patch: Partial<DeciderConfig> } | { ok: false; error: string } {
  const next: Partial<DeciderConfig> = { ...patch };
  const savingKey = typeof patch.key === "string" && Boolean(patch.key.trim());
  const clearingKey = typeof patch.key === "string" && !patch.key.trim();
  if (typeof patch.key === "string") next.key = patch.key.trim();
  if (savingKey) {
    next.enabled = patch.enabled ?? true;
    next.jobs = { ...current?.jobs, roomRouting: true, ...patch.jobs };
  } else if (clearingKey) {
    if (!included) next.enabled = false;
  } else if (patch.jobs) {
    next.jobs = { ...current?.jobs, ...patch.jobs };
  }
  if (next.enabled === true && !savingKey && !current?.key?.trim() && !included) {
    return { ok: false, error: "Save a Jev API key before turning on fast decisions." };
  }
  return { ok: true, patch: next };
}

export interface DeciderDeps {
  config(): AppConfig;
  fetch?: typeof fetch;
  dataDir?: string;
  now?: () => number;
}

export interface Decider {
  ask<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    state: unknown,
    questions: Qs,
    options?: AskOptions,
  ): Promise<DeciderResult<Answers<Qs>>>;
  choose<K extends string>(
    seam: DeciderSeam,
    state: unknown,
    question: { instructions: string; options: Record<K, string> },
    options?: AskOptions,
  ): Promise<DeciderResult<ChoiceAnswer<K>>>;
  score(
    seam: DeciderSeam,
    state: unknown,
    question: { instructions: string; levels: string[] },
    options?: AskOptions,
  ): Promise<DeciderResult<ScoreAnswer>>;
  yesNo(seam: DeciderSeam, state: unknown, instructions: string, options?: AskOptions): Promise<DeciderResult<YesNoAnswer>>;
  testKey(input?: { key?: string }, options?: AskOptions): Promise<DeciderResult<YesNoAnswer>>;
}

export function createDecider(deps: DeciderDeps): Decider {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? (() => performance.now());

  function gate(cfg: AppConfig, seam: DeciderSeam): DeciderFailure | null {
    if (deciderProvider(cfg) === "off") return "disabled";
    if (seam === "keyCheck") return null;
    if (!deciderConfigured(cfg)) return cfg.decider?.enabled === true ? "no_key" : "disabled";
    if (!deciderEnabled(cfg)) return "disabled";
    if (!deciderJobOn(cfg, seam)) return "job_off";
    if (!deciderAccount(cfg, seam)) return "no_key";
    return null;
  }

  async function call<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    backend: DeciderBackend | typeof offBackend,
    request: { key: string; baseUrl?: string; state: unknown; questions: Qs; images?: string[]; model?: DeciderModel },
    options: AskOptions,
  ): Promise<DeciderResult<Answers<Qs>>> {
    const provider = backend.id === "off" ? undefined : backend.id;
    if (options.signal?.aborted) return { ok: false, ...(provider ? { provider } : {}), reason: "cancelled" };
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_DECIDER_TIMEOUT_MS));
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<BackendResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
    });
    const started = now();
    let outcome: BackendResult;
    try {
      const decided = Promise.resolve()
        .then(() => backend.decide({ ...request, signal: controller.signal, fetch: fetchImpl }))
        .catch((): BackendResult => ({ ok: false, reason: "malformed" }));
      outcome = await Promise.race([decided, timedOut]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
    const latencyMs = Math.max(0, Math.round(now() - started));
    if (!outcome.ok && outcome.reason !== "timeout" && options.signal?.aborted) outcome = { ok: false, reason: "cancelled" };
    if (provider && deps.dataDir) {
      const first = outcome.ok ? Object.values(outcome.answers).find((answer) => answer.type === "choice") as ChoiceAnswer | undefined : undefined;
      appendDeciderLog(deps.dataDir, {
        at: new Date().toISOString(),
        seam,
        provider,
        ok: outcome.ok,
        ...(!outcome.ok ? { reason: outcome.reason, ...(outcome.status ? { status: outcome.status } : {}) } : {}),
        ...(first ? { choice: first.choice } : {}),
        ...(request.model ? { model: request.model } : {}),
        pTop: first?.pTop ?? null,
        margin: first?.margin ?? null,
        latencyMs,
        ...(outcome.ok && outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
        stateHash: stateHash(request.state),
      });
    }
    if (!outcome.ok) return { ok: false, ...(provider ? { provider } : {}), reason: outcome.reason, ...(outcome.status ? { status: outcome.status } : {}), latencyMs };
    return {
      ok: true,
      provider: provider!,
      answers: outcome.answers as Answers<Qs>,
      latencyMs,
      ...(outcome.inputTokens !== undefined ? { inputTokens: outcome.inputTokens } : {}),
      ...(outcome.model ? { model: outcome.model } : {}),
    };
  }

  async function ask<Qs extends Record<string, DeciderQuestion>>(
    seam: DeciderSeam,
    state: unknown,
    questions: Qs,
    options: AskOptions = {},
  ): Promise<DeciderResult<Answers<Qs>>> {
    try {
      const cfg = deps.config();
      const refused = gate(cfg, seam);
      if (refused) return { ok: false, reason: refused };
      const provider = deciderProvider(cfg);
      const backend = provider === "off" ? offBackend : BACKENDS[provider];
      const account = deciderAccount(cfg, seam)!;
      if (account.included && !relayAccepts(seam, state, questions)) return { ok: false, reason: "misconfigured" };
      const model = options.model ?? deciderModelFor(cfg, seam === "keyCheck" ? "roomRouting" : seam);
      const images = options.images?.length ? options.images : undefined;
      return await call(seam, backend, {
        key: account.token, baseUrl: account.api, state, questions,
        ...(images ? { images } : {}), ...(model ? { model } : {}),
      }, options);
    } catch {
      return { ok: false, reason: "malformed" };
    }
  }

  const single = <A>(result: DeciderResult<{ answer: A }>): DeciderResult<A> =>
    result.ok ? { ...result, answers: result.answers.answer } : result;

  return {
    ask,
    async choose<K extends string>(
      seam: DeciderSeam,
      state: unknown,
      question: { instructions: string; options: Record<K, string> },
      options?: AskOptions,
    ): Promise<DeciderResult<ChoiceAnswer<K>>> {
      const asked: { answer: ChoiceQuestion<K> } = { answer: { type: "choice", instructions: question.instructions, options: question.options } };
      return single(await ask(seam, state, asked, options)) as DeciderResult<ChoiceAnswer<K>>;
    },
    async score(seam, state, question, options) {
      return single(await ask(seam, state, { answer: { type: "score", instructions: question.instructions, levels: question.levels } }, options));
    },
    async yesNo(seam, state, instructions, options) {
      return single(await ask(seam, state, { answer: { type: "yesno", instructions } }, options));
    },
    async testKey(input = {}, options = {}) {
      try {
        const cfg = deps.config();
        const account = deciderAccount(cfg, "keyCheck", input.key);
        if (!account) return { ok: false, reason: "no_key" };
        const provider = deciderProvider(cfg);
        const backend = provider === "off" ? offBackend : BACKENDS[provider];
        const questions = { answer: { type: "yesno" as const, instructions: KEY_CHECK_QUESTION } };
        if (account.included && !relayAccepts("keyCheck", KEY_CHECK_STATE, questions)) return { ok: false, reason: "misconfigured" };
        return single(await call("keyCheck", backend, {
          key: account.token,
          baseUrl: account.api,
          state: KEY_CHECK_STATE,
          questions,
        }, { timeoutMs: KEY_CHECK_TIMEOUT_MS, ...options }));
      } catch {
        return { ok: false, reason: "malformed" };
      }
    },
  };
}
