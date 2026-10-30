import { z } from "zod";
import { readCapped } from "../laterdog/cloud-computers.ts";
import { trialUsage, type IncludedTrial } from "../laterdog/included-trial.ts";
import {
  GRANT_DAY,
  INSTALL_TIERS,
  SPEND_PROVIDERS,
  SPEND_SERVICES,
  USAGE_HISTORY_DAYS,
  USAGE_KINDS,
  grantProblem,
  type Grant,
  type GrantSpend,
  type IncludedUsage,
  type OwnerReport,
  type UsageAmounts,
} from "../../shared/included-usage.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface IncludedUsageRouteDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

const USAGE_PATH = "/api/included-usage";
const OWNER_PATH = "/api/owner-usage";
const GRANTS_PATH = "/api/owner-usage/grants";
const DEFAULT_DAYS = 30;
const CACHE_MS = 60_000;
const TIMEOUT_MS = 10_000;
const MAX_ANSWER_BYTES = 1024 * 1024;
const MAX_ROWS = 10_000;

class UsageServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "UsageServiceError"; this.status = status;
  }
}

const unexpected = () => new UsageServiceError(502, "later.dog's usage service returned an unexpected answer");
const isOne = <T extends string>(list: readonly T[], value: string): value is T => (list as readonly string[]).includes(value);

const day = z.string().regex(GRANT_DAY);
const amount = z.number().nonnegative();
const amounts = z.record(z.string(), z.unknown()).transform((raw) => {
  const out: UsageAmounts = {};
  for (const kind of USAGE_KINDS) {
    const value = raw[kind];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[kind] = value;
  }
  return out;
});
const tier = z.enum(INSTALL_TIERS).nullable().catch(null);
const grantSpend = z.array(z.object({ provider: z.string(), usd: z.number().positive(), since: day, spentMicros: amount })).max(MAX_ROWS)
  .transform((rows) => rows.flatMap((row) => isOne(SPEND_PROVIDERS, row.provider) ? [{ ...row, provider: row.provider }] : []));

const usageBody = z.object({
  owner: z.boolean(),
  tier,
  today: day,
  days: z.array(z.object({ day, used: amounts, micros: amount.optional() })).max(MAX_ROWS),
  limits: amounts.nullable().catch(null),
});

const reportBody = z.object({
  today: day,
  days: z.array(day).max(MAX_ROWS),
  usage: z.array(z.object({ day, kind: z.string(), used: amount })).max(MAX_ROWS)
    .transform((rows) => rows.flatMap((row) => isOne(USAGE_KINDS, row.kind) ? [{ ...row, kind: row.kind }] : [])),
  active: z.array(z.object({ day, installs: amount })).max(MAX_ROWS),
  activeInstalls: amount,
  spend: z.array(z.object({ day, service: z.string(), provider: z.string(), units: amount, micros: amount })).max(MAX_ROWS)
    .transform((rows) => rows.flatMap((row) => isOne(SPEND_SERVICES, row.service) && isOne(SPEND_PROVIDERS, row.provider)
      ? [{ ...row, service: row.service, provider: row.provider }] : [])),
  top: z.array(z.object({
    label: z.string().max(200),
    tier,
    owner: z.boolean(),
    micros: amount,
    services: z.array(z.object({ service: z.string(), units: amount, micros: amount })).max(MAX_ROWS)
      .transform((rows) => rows.flatMap((row) => isOne(SPEND_SERVICES, row.service) ? [{ ...row, service: row.service }] : [])),
  })).max(MAX_ROWS),
  grants: grantSpend,
});

const grantsAnswer = z.object({ grants: grantSpend });
const grantsBody = z.object({
  grants: z.array(z.object({ provider: z.enum(SPEND_PROVIDERS), usd: z.number(), since: z.string().max(10) })).max(SPEND_PROVIDERS.length),
});
const failure = z.object({ error: z.object({ message: z.string().max(500).optional() }) });

function daysFrom(url: URL): number {
  const raw = url.searchParams.get("days");
  const days = raw === null ? DEFAULT_DAYS : Number(raw);
  return Number.isInteger(days) && days >= 1 && days <= USAGE_HISTORY_DAYS ? days : DEFAULT_DAYS;
}

export function createIncludedUsageRoutes(deps: IncludedUsageRouteDeps = {}): RouteHandler {
  const send = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { at: number; token: string; value: unknown }>();

  async function ask(trial: IncludedTrial, path: string, body?: string): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await send(`${trial.api}${path}`, {
        method: body === undefined ? "GET" : "PUT",
        body,
        headers: { authorization: `Bearer ${trial.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new UsageServiceError(503, "later.dog's usage service could not be reached", { cause: error });
    }
    let answer: unknown = null;
    try { answer = JSON.parse((await readCapped(response, MAX_ANSWER_BYTES, unexpected)).toString("utf8")); } catch {}
    return { status: response.status, body: answer };
  }

  function refused(status: number, body: unknown): UsageServiceError {
    const theirs = failure.safeParse(body).data?.error.message;
    if (status === 422) return new UsageServiceError(422, theirs ?? "later.dog's usage service refused those grants");
    if (status === 429) return new UsageServiceError(429, theirs ?? "later.dog's usage service is busy, try again in a minute");
    return new UsageServiceError(502, `later.dog's usage service could not answer (${status})`);
  }

  async function read<T>(trial: IncludedTrial, path: string, schema: z.ZodType<T>): Promise<T | null> {
    const key = path;
    const hit = cache.get(key);
    if (hit && hit.token === trial.token && now() - hit.at < CACHE_MS) return hit.value as T | null;
    const answer = await ask(trial, path);
    let value: T | null;
    if (answer.status === 401 || answer.status === 404) value = null;
    else if (answer.status !== 200) throw refused(answer.status, answer.body);
    else {
      const parsed = schema.safeParse(answer.body);
      if (!parsed.success) throw unexpected();
      value = parsed.data;
    }
    cache.set(key, { at: now(), token: trial.token, value });
    return value;
  }

  async function saveGrants(trial: IncludedTrial, grants: Grant[]): Promise<GrantSpend[] | null> {
    const answer = await ask(trial, "/usage/owner/grants", JSON.stringify({ grants }));
    if (answer.status === 401 || answer.status === 404) return null;
    if (answer.status !== 200) throw refused(answer.status, answer.body);
    const parsed = grantsAnswer.safeParse(answer.body);
    if (!parsed.success) throw unexpected();
    for (const key of cache.keys()) if (key.startsWith("/usage/owner")) cache.delete(key);
    return parsed.data.grants;
  }

  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path !== USAGE_PATH && path !== OWNER_PATH && path !== GRANTS_PATH) return PASS;
    res.setHeader("cache-control", "private, no-store");
    const allowed = path === GRANTS_PATH ? "PUT" : "GET";
    if (method !== allowed) {
      res.setHeader("allow", allowed);
      return json(res, 405, { error: "method not allowed" });
    }
    try {
      const trial = trialUsage();
      if (path === USAGE_PATH) {
        const usage: IncludedUsage | null = trial ? await read(trial, `/usage?days=${daysFrom(url)}`, usageBody) : null;
        return json(res, 200, { usage });
      }
      if (path === OWNER_PATH) {
        const report: OwnerReport | null = trial ? await read(trial, `/usage/owner?days=${daysFrom(url)}`, reportBody) : null;
        return json(res, 200, { report });
      }
      if (!trial) return json(res, 404, { error: "only the owner's later.dog keeps grants" });
      const body = grantsBody.safeParse(await readBody(req, 8192));
      if (!body.success || grantProblem(body.data.grants)) return json(res, 422, { error: "send up to four grants, one per provider, each with an amount and a YYYY-MM-DD start day" });
      const grants = await saveGrants(trial, body.data.grants);
      return grants ? json(res, 200, { grants }) : json(res, 404, { error: "only the owner's later.dog keeps grants" });
    } catch (error) {
      if (error instanceof UsageServiceError) return json(res, error.status, { error: error.message });
      const status = (error as { status?: unknown } | null)?.status;
      if (typeof status === "number" && status >= 400 && status < 500) return json(res, status, { error: (error as Error).message });
      throw error;
    }
  };
}
