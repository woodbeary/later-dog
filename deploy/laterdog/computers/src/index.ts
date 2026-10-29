
import { WorkerEntrypoint } from "cloudflare:workers";
import { BROWSER_ORIGIN, type Refusal, bearerToken, refuseApiRequest, sha256Hex } from "./auth";
import type { DogComputer, Result } from "./computer";
import { TooLarge, apiError, json, readLimited } from "./http";
import { AI_DEFAULT_MODEL, AI_MAX_BODY_BYTES, AI_MAX_PROMPT_TOKENS, AI_WORKERS_MODEL, chatRequest, grokRequest, openAiStream, plainErrors, streamedTokens, tokensOf, usableStream, workersInput, type ChatRequest } from "./ai";
import { AI_BUDGET, GROK_BUDGET, type Reservation, type TokenBudget, chatEstimate, jointReservation, reserveTokens } from "./usage-reserve";
import { DECIDE_MAX_IMAGE_BODY_BYTES, DECISIONS_PER_DAY, DECISIONS_TOTAL_PER_DAY, SCREEN_CHECKS_PER_DAY, SCREEN_CHECKS_TOTAL_PER_DAY, TOOL_DECISIONS_PER_DAY, TOOL_DECISIONS_TOTAL_PER_DAY, type Decision, type UsageKind, VOICE_CHARS_TOTAL_PER_DAY, clefInput, clefModelId, decisionFrom, toolDecisionFrom } from "./decide";
import { COMPLETE_DEFAULT_MODEL, COMPLETE_MAX_BODY_BYTES, COMPLETIONS_PER_DAY, COMPLETIONS_TOTAL_PER_DAY, completeInput, completeRequest, completionFrom } from "./complete";
import { FILE_MAX_BYTES, JSON_MAX_BYTES, parseCreate, parseExec, parseIdempotencyKey, parsePath, parseRename } from "./inputs";
import { type McpBackend, handleMcp } from "./mcp";
import type { ComputerRegistry } from "./registry";
import { type ComputerOp, type TrialOp, route } from "./routes";
import {
  DAY,
  TRIAL_CLAIM,
  TRIAL_FORM_MAX_BYTES,
  TRIAL_TOKEN,
  TURNSTILE_TOKEN_MAX_CHARS,
  type TrialRecord,
  allowedCountry,
  networkDigest,
  networkOf,
  parseTrialForm,
  trialListing,
  trialOffer,
  trialPolicy,
  trialView,
  verifyTurnstile,
} from "./trial";
import { trialPage, trialPageHeaders } from "./trial-page";
import { type PlanRow, planPolicy, trials } from "./trial-registry";
import { cancelSubscription, createPlanLink, customerPlan, orderCustomer, paidThrough, squareConfigured, subscription } from "./square";
import { messagePage, newNonce } from "./viewer";
import { AURA_FORMAT, ELEVENLABS_ENGINE, type ElevenLabsVoice, type SpeechRequest, VOICE_CHARS_PER_DAY, VOICE_MODEL, audioBytes, auraSpeaker, elevenLabsBudget, elevenLabsFor, elevenLabsRequest, elevenLabsVoice, includedVoices, speechRequest, voiceInput } from "./voice";
import { SCRIBE_URL, TRANSCRIBE_MAX_BYTES, TRANSCRIBE_MODEL, TRANSCRIBE_SECONDS_PER_DAY, TRANSCRIBE_SECONDS_TOTAL_PER_DAY, type Transcript, type TranscriptionRequest, scribeForm, scribeKey, scribeTimeout, scribeTranscript, takesGateway, transcribeInput, transcribeModel, transcriptFrom, transcriptionRequest } from "./transcribe";
import { type GatewayMetadata, gatewayId, gatewayMetadata, gatewayOptions, withMetadata } from "./gateway";
import { type MessagesRequest, anthropicBudget, anthropicFirst, anthropicGatewayRequest, anthropicModel, chatCompletion, chatCompletionStream, messagesRequest } from "./anthropic";
import { type Audio, SpeechCache, type SpeechKey, edgeSpeechStore } from "./speech-cache";

export { DogComputer } from "./computer";
export { ComputerRegistry } from "./registry";
export { TrialRegistry } from "./trial-registry";

declare global {
  interface Env {
    COMPUTERS_KEY_SHA256?: string;
    DESKTOP_SIGNING_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    TRIAL_NETWORK_KEY?: string;
    AI_GATEWAY_ID?: string;
    ELEVENLABS_API_KEY?: string;
    ELEVENLABS_MODE?: string;
    ELEVENLABS_CHARS_PER_DAY?: string;
    ELEVENLABS_PLAN_CHARS_PER_DAY?: string;
    TRANSCRIBE_AI_MODEL?: string;
    TRANSCRIBE_ENGINE?: string;
    SQUARE_ACCESS_TOKEN?: string;
    SQUARE_ENVIRONMENT?: string;
    XAI_API_KEY?: string;
    TRIAL_AI_MODEL?: string;
    TRIAL_AI_WORKERS_MODEL?: string;
    TRIAL_AI_ANTHROPIC_MODEL?: string;
    ANTHROPIC_FIRST?: string;
    TYPING_AI_MODEL?: string;
  }
}

type Caller = { registry: DurableObjectStub<ComputerRegistry>; trial?: TrialRecord; keySha256?: string; fullAllowance?: boolean; home?: boolean };

const trialLimited = (caller: Caller): boolean => Boolean(caller.trial && !caller.fullAllowance);

type Identified = { ok: true; caller: Caller } | { ok: false; response: Response };

type Via = "public" | "binding";

const CHALLENGE = { "www-authenticate": 'Bearer realm="laterdog-computers"' };
const TRIALS_OFF: Refusal = { status: 503, code: "trials_off", message: "Free trials are switched off on this service right now." };
const NO_COMPUTER: Refusal = { status: 404, code: "not_found", message: "No computer with that id." };
const NO_TRIAL: Refusal = { status: 401, code: "unauthorized", message: "This free trial has ended or has not started yet." };
const TOO_MANY: Refusal = { status: 429, code: "rate_limited", message: "Too many requests from this network. Wait a minute, then try again." };

type LimiterDown = "allow" | "refuse";

async function allowed(limiter: RateLimit | undefined, key: string, whenDown: LimiterDown = "allow"): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return whenDown === "allow";
  }
}

const networkKey = (request: Request) => networkOf(request.headers.get("cf-connecting-ip")) ?? "unknown";

function computer(env: Env, id: string): DurableObjectStub<DogComputer> {
  return env.COMPUTER.get(env.COMPUTER.idFromName(id));
}

function registry(env: Env, name = "registry"): DurableObjectStub<ComputerRegistry> {
  return env.REGISTRY.get(env.REGISTRY.idFromName(name));
}

function answer<T>(result: Result<T>, render: (value: T) => Response): Response {
  return result.ok ? render(result.value) : apiError(result.refusal);
}

function countryOf(request: Request): string | undefined {
  const country = (request.cf as { country?: unknown } | undefined)?.country;
  return typeof country === "string" ? country : undefined;
}

async function identify(request: Request, env: Env, via: Via): Promise<Identified> {
  if (via === "binding") {
    if (request.headers.has("origin")) return { ok: false, response: apiError(BROWSER_ORIGIN) };
    return { ok: true, caller: { registry: registry(env) } };
  }
  const token = bearerToken(request.headers.get("authorization"));
  if (token !== null && TRIAL_TOKEN.test(token) && !request.headers.has("origin")) {
    if (!(await allowed(env.TRIAL_API_LIMIT, networkKey(request)))) return { ok: false, response: apiError(TOO_MANY) };
    const keySha256 = await sha256Hex(token);
    const holder = await trials(env).holder(keySha256);
    if (!holder) return { ok: false, response: apiError(NO_TRIAL, CHALLENGE) };
    const { trial, fullAllowance, home } = holder;
    return { ok: true, caller: { registry: registry(env, trialListing(trial.id)), trial, keySha256, ...(fullAllowance ? { fullAllowance } : {}), ...(home ? { home } : {}) } };
  }
  const refusal = await refuseApiRequest(request.headers, env.COMPUTERS_KEY_SHA256);
  if (refusal) return { ok: false, response: apiError(refusal, refusal.status === 401 ? CHALLENGE : {}) };
  return { ok: true, caller: { registry: registry(env) } };
}

type Body = { ok: true; value: unknown } | { ok: false; response: Response };

async function readJson(request: Request): Promise<Body> {
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request.body, JSON_MAX_BYTES);
  } catch (error) {
    if (error instanceof TooLarge) return { ok: false, response: apiError({ status: 413, code: "too_large", message: error.message }) };
    throw error;
  }
  if (bytes.byteLength === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: apiError({ status: 400, code: "invalid_json", message: "The body is not valid JSON." }) };
  }
}

async function listComputers(caller: Caller): Promise<Response> {
  return json({ computers: await caller.registry.list() });
}

async function createComputer(request: Request, env: Env, caller: Caller): Promise<Response> {
  const limited = trialLimited(caller);
  if (limited && !trialPolicy(env).enabled) return apiError(TRIALS_OFF);
  const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
  if (!key.ok) return apiError(key.refusal);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const input = parseCreate(body.value);
  if (!input.ok) return apiError(input.refusal);
  if (limited && input.value.size !== "standard") {
    return apiError({ status: 403, code: "trial_size", message: "A free trial computer is the standard size." });
  }
  const reservation = await caller.registry.reserve({
    ...input.value,
    ...(key.value === undefined ? {} : { idempotencyKey: key.value }),
    ...(limited ? { max: 1 } : {}),
  });
  if (!reservation.ok) {
    if (limited && reservation.refusal.code === "limit_reached") {
      return apiError({ status: 409, code: "trial_one_computer", message: "The free trial includes one cloud computer. later.dog Cloud gives every dog its own." });
    }
    return apiError(reservation.refusal);
  }
  const stub = computer(env, reservation.id);
  let result: Result<unknown>;
  try {
    result = await stub.init({
      id: reservation.id,
      name: reservation.name,
      size: reservation.size,
      ...(caller.trial ? { registry: trialListing(caller.trial.id), trial: caller.trial.id } : {}),
      ...(caller.fullAllowance ? { fullAllowance: true } : {}),
    });
  } catch (error) {
    result = { ok: false, refusal: { status: 502, code: "start_failed", message: error instanceof Error ? error.message : String(error) } };
  }
  if (!result.ok) {
    if (!reservation.replayed) {
      await stub.remove().catch(() => undefined);
      await caller.registry.remove(reservation.id);
    }
    return apiError(result.refusal);
  }
  return json({ computer: result.value }, 201, reservation.replayed ? { "idempotent-replayed": "true" } : {});
}

async function computerRequest(op: ComputerOp, id: string, request: Request, env: Env, url: URL, caller: Caller): Promise<Response> {
  if (caller.trial && !(await caller.registry.has(id))) return apiError(NO_COMPUTER);
  const stub = computer(env, id);
  switch (op) {
    case "get":
      return answer(await stub.describe(), (value) => json({ computer: value }));
    case "rename": {
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const input = parseRename(body.value);
      if (!input.ok) return apiError(input.refusal);
      return answer(await stub.rename(input.value.name), (value) => json({ computer: value }));
    }
    case "delete": {
      const result = await stub.remove();
      const listed = await caller.registry.remove(id);
      if (!result.ok && !(result.refusal.status === 404 && listed)) return apiError(result.refusal);
      return json({ deleted: true });
    }
    case "wake":
      if (trialLimited(caller) && !trialPolicy(env).enabled) return apiError(TRIALS_OFF);
      return answer(await stub.wake({ fullAllowance: Boolean(caller.fullAllowance) }), (value) => json({ computer: value }));
    case "sleep":
      return answer(await stub.sleep("request"), (value) => json({ computer: value }));
    case "reset":
    case "update": {
      if (trialLimited(caller) && !trialPolicy(env).enabled) return apiError(TRIALS_OFF);
      const allowance = { fullAllowance: Boolean(caller.fullAllowance) };
      return answer(await (op === "reset" ? stub.reset(allowance) : stub.updateImage(allowance)), (value) => json({ computer: value }));
    }
    case "exec": {
      const body = await readJson(request);
      if (!body.ok) return body.response;
      const input = parseExec(body.value);
      if (!input.ok) return apiError(input.refusal);
      return answer(await stub.exec(input.value), (value) => json(value));
    }
    case "readFile": {
      const path = parsePath(url.searchParams.get("path"));
      if (!path.ok) return apiError(path.refusal);
      return answer(await stub.readFile(path.value), (bytes) => new Response(bytes, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store" } }));
    }
    case "writeFile": {
      const path = parsePath(url.searchParams.get("path"));
      if (!path.ok) return apiError(path.refusal);
      const declared = Number(request.headers.get("content-length") ?? "0");
      const tooLarge = apiError({ status: 413, code: "too_large", message: `Files are limited to ${FILE_MAX_BYTES} bytes.` });
      if (declared > FILE_MAX_BYTES) return tooLarge;
      let bytes: Uint8Array;
      try {
        bytes = await readLimited(request.body, FILE_MAX_BYTES);
      } catch (error) {
        if (error instanceof TooLarge) return tooLarge;
        throw error;
      }
      return answer(await stub.writeFile(path.value, bytes), () => json({ ok: true }));
    }
    case "screenshot":
      return answer(await stub.screenshot(), (bytes) => new Response(bytes, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } }));
    case "desktop":
      return answer(await stub.desktopLink(url.origin), (value) => json(value));
  }
}

const HOME_KEY: Refusal = { status: 409, code: "home_grant", message: "This computer is part of your later.dog Cloud." };

async function trialRequest(op: TrialOp, env: Env, caller: Caller): Promise<Response> {
  const trial = caller.trial;
  if (!trial) return apiError({ status: 404, code: "no_trial", message: "This key is not a free trial key." });
  const plan = caller.keySha256 ? await trials(env).planFor(caller.keySha256) : null;
  if (op === "end") {
    if (caller.home) return apiError(HOME_KEY);
    if (plan && (plan.status === "active" || plan.status === "canceled")) {
      return apiError({ status: 409, code: "plan_active", message: "This computer is on later.dog Cloud. Cancel the plan to stop it." });
    }
    await trials(env).end(trial.id);
    return json({ ended: true });
  }
  for (const listed of await caller.registry.list()) await computer(env, listed.id).meter();
  const current = await trials(env).lookup(trial.id);
  if (!current) return apiError(NO_TRIAL, CHALLENGE);
  return json({ trial: trialView(current), ...includedField(env), ...(squareConfigured(env) ? { planOffered: true } : {}), ...(plan ? { plan: planView(plan) } : {}) });
}

function includedServices(env: Env): string[] {
  if (!env.AI) return [];
  return ["decisions", "voice", "ai"];
}

function includedField(env: Env): { included?: string[] } {
  const included = includedServices(env);
  return included.length ? { included } : {};
}

function planView(plan: PlanRow) {
  return { status: plan.status, ...(plan.period_end ? { periodEnd: new Date(plan.period_end).toISOString() } : {}) };
}

const PLANS_CLOSED: Refusal = { status: 503, code: "plans_closed", message: "later.dog Cloud isn't open for sign-ups yet." };
const PLAN_REFRESH_MS = 6 * 60 * 60 * 1000;

function planKey(request: Request): string | null {
  if (request.headers.has("origin")) return null;
  const token = bearerToken(request.headers.get("authorization"));
  return token && TRIAL_TOKEN.test(token) ? token : null;
}

async function settlePlan(env: Env, plan: PlanRow): Promise<PlanRow> {
  const registry = trials(env);
  let customerId = plan.customer_id;
  if (!customerId) {
    const order = await orderCustomer(env, plan.order_id);
    customerId = order.customerId;
    if (!customerId) return plan;
  }
  const current = plan.subscription_id ? await subscription(env, plan.subscription_id) : await customerPlan(env, customerId);
  const until = current ? paidThrough(current, Date.now()) : null;
  if (!current || until === null) {
    if (plan.status === "active" || plan.status === "canceled") registry.markPlan(plan.key_sha256, "ended");
    return (await registry.planFor(plan.key_sha256)) ?? plan;
  }
  const policy = planPolicy(env);
  await registry.applyPlan({
    keySha256: plan.key_sha256, customerId, subscriptionId: current.id, status: current.status === "CANCELED" ? "canceled" : "active",
    periodEnd: until, limitMs: policy.limitMs, graceMs: policy.graceMs,
  });
  return (await registry.planFor(plan.key_sha256)) ?? plan;
}

async function planRequest(op: "status" | "checkout" | "cancel", request: Request, env: Env, url: URL): Promise<Response> {
  const token = planKey(request);
  if (!token) return apiError(request.headers.has("origin") ? BROWSER_ORIGIN : NO_TRIAL, CHALLENGE);
  if (!(await allowed(env.TRIAL_API_LIMIT, networkKey(request)))) return apiError(TOO_MANY);
  const keySha256 = await sha256Hex(token);
  const registry = trials(env);
  let plan = await registry.planFor(keySha256);
  if (op === "status") {
    if (plan && squareConfigured(env) && (plan.status === "pending" || !plan.checked_at || Date.now() - plan.checked_at > PLAN_REFRESH_MS)) {
      plan = await settlePlan(env, plan).catch((error) => {
        console.error(`laterdog computers: plan check failed: ${error instanceof Error ? error.message : String(error)}`);
        return plan;
      });
    }
    return json({ plan: plan ? planView(plan) : { status: "none" } });
  }
  if (!squareConfigured(env)) return apiError(PLANS_CLOSED);
  if (op === "checkout") {
    if (plan?.status === "active") return json({ plan: planView(plan) });
    const ref = newPlanRef();
    const link = await createPlanLink(env, { idempotencyKey: ref, redirectUrl: `${url.origin}/plan/done?ref=${ref}` });
    registry.planPending({ keySha256, ref, linkId: link.id, orderId: link.orderId });
    return json({ url: link.url }, 201);
  }
  if (!plan?.subscription_id || plan.status !== "active") return apiError({ status: 404, code: "no_plan", message: "There is no later.dog Cloud plan to cancel." });
  const canceled = await cancelSubscription(env, plan.subscription_id);
  const until = canceled ? paidThrough(canceled, Date.now()) : null;
  if (canceled && until !== null && plan.customer_id) {
    const policy = planPolicy(env);
    await registry.applyPlan({ keySha256, customerId: plan.customer_id, subscriptionId: canceled.id, status: "canceled", periodEnd: until, limitMs: policy.limitMs, graceMs: 0 });
  } else {
    registry.markPlan(keySha256, "canceled");
  }
  return json({ plan: planView((await registry.planFor(keySha256)) ?? plan) });
}

function htmlPage(status: number, title: string, message: string, openApp?: { href: string; label: string }): Response {
  const nonce = newNonce();
  return new Response(messagePage({ title, message, nonce, ...(openApp ? { openApp } : {}) }), { status, headers: trialPageHeaders(nonce) });
}

function newPlanRef(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function planDonePage(env: Env, url: URL): Promise<Response> {
  const page = htmlPage;
  const ref = url.searchParams.get("ref") ?? "";
  const plan = /^[a-f0-9]{32}$/.test(ref) ? await trials(env).planByRef(ref) : null;
  if (!plan) return page(404, "We couldn't find that checkout", "Start again from later.dog.");
  const settled = squareConfigured(env) ? await settlePlan(env, plan).catch(() => plan) : plan;
  if (settled.status === "active" || settled.status === "canceled") {
    return page(200, "You're on later.dog Cloud", "Your cloud computer and included features are ready. later.dog picks this up by itself.", { href: "laterdog://plan", label: "Open later.dog" });
  }
  return page(202, "Almost there", "Square hasn't confirmed the payment yet. Refresh this page in a moment.");
}

const CHECK_NEEDED: Refusal = { status: 403, code: "check_needed", message: "Start the free trial from the page later.dog opens, which runs a quick browser check." };

async function startTrialFromApp(request: Request, env: Env): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const policy = trialPolicy(env);
  if (!policy.enabled) return apiError({ status: 503, code: "trials_off", message: "Free trials are switched off on this service right now." });
  if (!allowedCountry(policy, countryOf(request))) return apiError({ status: 403, code: "trials_not_here", message: "Free trials are not offered in your country yet." });
  const network = networkOf(request.headers.get("cf-connecting-ip") ?? undefined);
  if (!network) return apiError({ status: 400, code: "no_network", message: "Your network could not be identified." });
  if (!(await allowed(env.TRIAL_FORM_LIMIT, network, "refuse"))) return apiError(TOO_MANY);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const fields = (body.value ?? {}) as { claim?: unknown; turnstile?: unknown };
  const claim = fields.claim;
  if (typeof claim !== "string" || !TRIAL_CLAIM.test(claim)) return apiError({ status: 400, code: "invalid_claim", message: "Send { \"claim\": \"<64-character claim>\" }." });
  const token = fields.turnstile;
  if (typeof token !== "string" || token.length === 0 || token.length > TURNSTILE_TOKEN_MAX_CHARS) return apiError(CHECK_NEEDED);
  const ip = request.headers.get("cf-connecting-ip") ?? undefined;
  const verdict = await verifyTurnstile({ secret: env.TURNSTILE_SECRET_KEY?.trim() ?? "", token, ...(ip === undefined ? {} : { ip }), hostname: new URL(request.url).hostname, cdata: claim });
  if (verdict === "unavailable") return apiError({ status: 502, code: "check_unavailable", message: "The browser check could not be confirmed. Try again in a minute." });
  if (verdict === "failed") return apiError({ status: 403, code: "check_failed", message: "The browser check did not pass. Start the free trial from the page later.dog opens." });
  const activation = await trials(env).activate({
    keySha256: claim,
    network: await networkDigest(env.TRIAL_NETWORK_KEY?.trim() ?? "", network),
    limitMs: policy.limitMs,
    windowMs: policy.windowMs,
    perDay: policy.perDay,
    perNetwork: policy.perNetwork,
  });
  if (!activation.ok) return apiError(activation.refusal);
  return json({ trial: trialView(activation.trial), ...includedField(env) }, activation.replayed ? 200 : 201);
}

export const HOME_GRANT_DAYS = 90;

async function grantHome(request: Request, env: Env): Promise<Response> {
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const claim = (body.value as { claim?: unknown } | undefined)?.claim;
  if (typeof claim !== "string" || !TRIAL_CLAIM.test(claim)) {
    return apiError({ status: 400, code: "invalid_claim", message: "Send { \"claim\": \"<the home key's 64-character SHA-256>\" }." });
  }
  const granted = await trials(env).grantHome({ keySha256: claim, limitMs: planPolicy(env).limitMs, windowMs: HOME_GRANT_DAYS * DAY });
  if (!granted.ok) return apiError(granted.refusal);
  return json({ trial: trialView(granted.trial), home: true }, granted.replayed ? 200 : 201);
}

async function grantTrial(request: Request, env: Env, caller: Caller): Promise<Response> {
  if (caller.trial) return apiError({ status: 403, code: "owner_only", message: "Only the owner's key can grant a free trial." });
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const claim = (body.value as { claim?: unknown } | undefined)?.claim;
  if (typeof claim !== "string" || !TRIAL_CLAIM.test(claim)) {
    return apiError({ status: 400, code: "invalid_claim", message: "Send { \"claim\": \"<the trial link's 64-character claim>\" }." });
  }
  const policy = trialPolicy(env);
  const granted = await trials(env).grant({ keySha256: claim, limitMs: policy.limitMs, windowMs: policy.windowMs });
  if (!granted.ok) return apiError(granted.refusal);
  return json({ trial: trialView(granted.trial) }, granted.replayed ? 200 : 201);
}

async function trialPageRequest(request: Request, env: Env, url: URL): Promise<Response> {
  const nonce = newNonce();
  const page = (status: number, title: string, message: string, openApp?: { href: string; label: string }) =>
    new Response(messagePage({ title, message, nonce, ...(openApp ? { openApp } : {}) }), { status, headers: trialPageHeaders(nonce) });
  const policy = trialPolicy(env);
  if (!policy.enabled) return page(503, "Free trials are not available", "Free trials are switched off on this service right now.");
  const { minutes, days } = trialOffer(policy);
  const incomplete = () => page(400, "This link is not complete", "Start the free trial from later.dog, in a dog's Computer panel.");
  if (request.method === "GET") {
    const claim = url.searchParams.get("claim") ?? "";
    if (!TRIAL_CLAIM.test(claim)) return incomplete();
    return new Response(trialPage({ claim, siteKey: policy.siteKey, minutes, days, nonce }), { headers: trialPageHeaders(nonce) });
  }
  if (request.headers.get("origin") !== url.origin) return page(403, "This form came from another page", "Open the free trial link from later.dog again.");
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/x-www-form-urlencoded") return page(415, "This form could not be read", "Open the free trial link from later.dog again.");
  let text: string;
  try {
    text = new TextDecoder().decode(await readLimited(request.body, TRIAL_FORM_MAX_BYTES));
  } catch (error) {
    if (error instanceof TooLarge) return page(413, "This form could not be read", "Open the free trial link from later.dog again.");
    throw error;
  }
  const form = parseTrialForm(text);
  if (!form.ok) {
    return form.problem === "claim" ? incomplete() : page(400, "The check did not finish", "Go back, wait for the check to pass, then press Start free trial.");
  }
  if (!allowedCountry(policy, countryOf(request))) return page(403, "Free trials are not offered here", "Free trials are not offered in your country yet.");
  const ip = request.headers.get("cf-connecting-ip") ?? undefined;
  const network = networkOf(ip);
  if (!network) return page(400, "Your network could not be identified", "Try again from another network.");
  if (!(await allowed(env.TRIAL_FORM_LIMIT, network, "refuse"))) return page(429, "Too many tries", "Wait a minute, then try again.");
  const verdict = await verifyTurnstile({
    secret: env.TURNSTILE_SECRET_KEY?.trim() ?? "",
    token: form.token,
    ...(ip === undefined ? {} : { ip }),
    hostname: url.hostname,
    cdata: form.claim,
  });
  if (verdict === "unavailable") return page(502, "The check could not be confirmed", "Try again in a minute.");
  if (verdict === "failed") return page(403, "The check did not pass", "Go back and try the check again.");
  const activation = await trials(env).activate({
    keySha256: form.claim,
    network: await networkDigest(env.TRIAL_NETWORK_KEY?.trim() ?? "", network),
    limitMs: policy.limitMs,
    windowMs: policy.windowMs,
    perDay: policy.perDay,
    perNetwork: policy.perNetwork,
  });
  if (!activation.ok) return page(activation.refusal.status, "The free trial could not start", activation.refusal.message);
  const message = activation.replayed
    ? `This free trial has ${trialView(activation.trial).minutesLeft} minutes left. later.dog is starting your cloud computer.`
    : `You have ${minutes} minutes of cloud computer time in the next ${days} days. later.dog is starting your cloud computer.`;
  return page(200, "Your free trial has started", message, { href: "laterdog://trial", label: "Open later.dog" });
}

const NO_ENDPOINT: Refusal = { status: 404, code: "not_found", message: "No such endpoint." };
const NOT_INCLUDED: Refusal = { status: 503, code: "not_included", message: "Included services are not set up on this service." };
const INCLUDED_FAILED: Refusal = { status: 502, code: "upstream_failed", message: "The service did not answer. Try again." };

function includedKey(request: Request): string | null {
  if (request.headers.has("origin")) return null;
  const token = request.headers.get("xi-api-key")?.trim() || bearerToken(request.headers.get("authorization"));
  return token && TRIAL_TOKEN.test(token) ? token : null;
}

async function readBody(request: Request, limit: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request.body, limit);
  } catch (error) {
    if (error instanceof TooLarge) return { ok: false, response: apiError({ status: 413, code: "too_large", message: error.message }) };
    throw error;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, response: apiError({ status: 400, code: "invalid_json", message: "The body is not valid JSON." }) };
  }
}

async function readForm(request: Request, limit: number): Promise<{ ok: true; value: FormData } | { ok: false; response: Response }> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data\s*;/i.test(type)) {
    await request.body?.cancel().catch(() => {});
    return { ok: false, response: apiError({ status: 415, code: "unsupported_media_type", message: "Send the audio as multipart/form-data." }) };
  }
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request.body, limit);
  } catch (error) {
    if (error instanceof TooLarge) return { ok: false, response: apiError({ status: 413, code: "too_large", message: error.message }) };
    throw error;
  }
  try {
    return { ok: true, value: await new Response(bytes, { headers: { "content-type": type } }).formData() };
  } catch {
    return { ok: false, response: apiError({ status: 400, code: "invalid_form", message: "The body is not a valid form." }) };
  }
}

async function decideRequest(request: Request, env: Env): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const token = includedKey(request);
  if (!token) return apiError(NO_TRIAL, CHALLENGE);
  const keySha256 = await sha256Hex(token);
  if (!(await allowed(env.INCLUDED_LIMIT, keySha256))) return apiError(TOO_MANY);
  const body = await readBody(request, DECIDE_MAX_IMAGE_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = decisionFrom(body.value);
  if (!parsed.ok) return apiError(parsed.refusal);
  return await runDecision(env, keySha256, parsed.decision, ROOM_DECISIONS);
}

type DecisionBudget = { kind: UsageKind; perKey: number; total: number };

const ROOM_DECISIONS: DecisionBudget = { kind: "decisions", perKey: DECISIONS_PER_DAY, total: DECISIONS_TOTAL_PER_DAY };
const SCREEN_CHECKS: DecisionBudget = { kind: "screen_checks", perKey: SCREEN_CHECKS_PER_DAY, total: SCREEN_CHECKS_TOTAL_PER_DAY };
const TOOL_DECISIONS: DecisionBudget = { kind: "tool_decisions", perKey: TOOL_DECISIONS_PER_DAY, total: TOOL_DECISIONS_TOTAL_PER_DAY };

async function runDecision(env: Env, keySha256: string, decision: Decision, budget: DecisionBudget, exhausted?: Refusal): Promise<Response> {
  if (!env.AI) return apiError(NOT_INCLUDED);
  const allowance = await trials(env).allowUsage({ keySha256, amount: 1, ...budget });
  if (!allowance.ok) {
    if (exhausted && allowance.refusal.status !== 401) return apiError(exhausted);
    return apiError(allowance.refusal, allowance.refusal.status === 401 ? CHALLENGE : {});
  }
  try {
    return json(await env.AI.run(clefModelId(decision), clefInput(decision), gatewayOptions(env, gatewayMetadata(keySha256, allowance.tier))));
  } catch (error) {
    console.error(`laterdog computers: decision failed: ${error instanceof Error ? error.message : String(error)}`);
    return apiError(INCLUDED_FAILED);
  }
}

const NEEDS_PLAN: Refusal = { status: 403, code: "decisions_need_plan", message: "Free-form decisions come with the later.dog Cloud plan." };
const SCREEN_CHECKS_USED: Refusal = { status: 429, code: "screen_checks_used", message: "Today's screen checks are used up, so there is no screen check. The screenshot is still returned." };

async function planActive(env: Env, keySha256: string): Promise<boolean> {
  const plan = await trials(env).planFor(keySha256);
  if (!plan || (plan.status !== "active" && plan.status !== "canceled") || plan.period_end === null) return false;
  return Date.now() < plan.period_end + planPolicy(env).graceMs;
}

function mcpBackend(request: Request, env: Env, caller: Caller, url: URL): McpBackend {
  const post = (value: unknown) => new Request(request.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const decide = async (input: unknown, keySha256: string, budget: DecisionBudget, exhausted?: Refusal) => {
    if (!(await allowed(env.INCLUDED_LIMIT, keySha256))) return apiError(TOO_MANY);
    const parsed = toolDecisionFrom(input);
    if (!parsed.ok) return apiError(parsed.refusal);
    return await runDecision(env, keySha256, parsed.decision, budget, exhausted);
  };
  return {
    screenChecks: Boolean(caller.trial && caller.keySha256),
    list: () => listComputers(caller),
    create: (input) => createComputer(post({ ...input, size: input.size ?? (caller.trial ? "standard" : "small") }), env, caller),
    computer: (op, id, input) => computerRequest(op, id, input === undefined ? new Request(request.url, { method: "POST" }) : post(input), env, url, caller),
    screenCheck: async (input) => (caller.keySha256 ? await decide(input, caller.keySha256, SCREEN_CHECKS, SCREEN_CHECKS_USED) : apiError(NEEDS_PLAN)),
    decide: async (input) => {
      if (!caller.keySha256 || !(await planActive(env, caller.keySha256))) return apiError(NEEDS_PLAN);
      return await decide(input, caller.keySha256, TOOL_DECISIONS);
    },
  };
}

async function mcpRequest(request: Request, env: Env, via: Via, url: URL): Promise<Response> {
  const identified = await identify(request, env, via);
  if (!identified.ok) return identified.response;
  return await handleMcp(request, { backend: mcpBackend(request, env, identified.caller, url) });
}

async function completeHandler(request: Request, env: Env): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const token = includedKey(request);
  if (!token) return apiError(NO_TRIAL, CHALLENGE);
  const keySha256 = await sha256Hex(token);
  if (!(await allowed(env.INCLUDED_LIMIT, keySha256))) return apiError(TOO_MANY);
  const body = await readBody(request, COMPLETE_MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = completeRequest(body.value);
  if (!parsed.ok) return apiError(parsed.refusal);
  if (!env.AI) return apiError(NOT_INCLUDED);
  const allowance = await trials(env).allowUsage({ keySha256, kind: "completions", amount: 1, perKey: COMPLETIONS_PER_DAY, total: COMPLETIONS_TOTAL_PER_DAY });
  if (!allowance.ok) return apiError(allowance.refusal, allowance.refusal.status === 401 ? CHALLENGE : {});
  try {
    const model = env.TYPING_AI_MODEL?.trim() || COMPLETE_DEFAULT_MODEL;
    const raw = await (env.AI.run as (model: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>)(model, completeInput(parsed.request), gatewayOptions(env, gatewayMetadata(keySha256, allowance.tier)));
    const completion = completionFrom(parsed.request.prefix, raw);
    return completion === null ? apiError(INCLUDED_FAILED) : json({ completion, model });
  } catch (error) {
    console.error(`laterdog computers: completion failed: ${error instanceof Error ? error.message : String(error)}`);
    return apiError(INCLUDED_FAILED);
  }
}

async function voicesRequest(request: Request, env: Env): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const token = includedKey(request);
  if (!token) return apiError(NO_TRIAL, CHALLENGE);
  const tier = elevenLabsVoice(env) ? await trials(env).tierFor(await sha256Hex(token)) : null;
  return json({ voices: includedVoices(Boolean(elevenLabsFor(env, tier))) });
}

function audioResponse(audio: Audio, engine: "elevenlabs" | "aura", cached: boolean): Response {
  return new Response(audio, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store", "x-speech-engine": engine, "x-speech-cache": cached ? "hit" : "miss" } });
}

async function elevenLabsSpeech(env: Env, voice: ElevenLabsVoice, request: SpeechRequest, keySha256: string, metadata: GatewayMetadata, cache: SpeechCache): Promise<Response | null> {
  const key: SpeechKey = { engine: ELEVENLABS_ENGINE, voice: request.voiceId, format: request.outputFormat, text: request.text };
  const cached = await cache.find(key);
  if (cached) return audioResponse(cached, "elevenlabs", true);
  const held = await reserveTokens(trials(env), keySha256, elevenLabsBudget(voice), request.text.length);
  if (!held.ok) return null;
  const upstream = await env.AI.gateway(gatewayId(env)).run(withMetadata(elevenLabsRequest(request, voice.key), metadata)).catch((error: unknown) => {
    console.error(`laterdog computers: speech failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (upstream?.ok && upstream.body) {
    const [toClient, toCache] = upstream.body.tee();
    cache.keep(key, toCache);
    return audioResponse(toClient, "elevenlabs", false);
  }
  if (upstream) console.error(`laterdog computers: speech failed: ElevenLabs answered ${upstream.status}`);
  await upstream?.body?.cancel().catch(() => {});
  await held.reservation.refund();
  return null;
}

async function auraSpeech(env: Env, request: SpeechRequest, metadata: GatewayMetadata, cache: SpeechCache): Promise<Response> {
  const key: SpeechKey = { engine: VOICE_MODEL, voice: auraSpeaker(request), format: AURA_FORMAT, text: request.text };
  const cached = await cache.find(key);
  if (cached) return audioResponse(cached, "aura", true);
  const bytes = await audioBytes(await (env.AI.run as (model: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>)(VOICE_MODEL, voiceInput(request), gatewayOptions(env, metadata)));
  if (!bytes || bytes.byteLength === 0) return apiError(INCLUDED_FAILED);
  cache.keep(key, bytes);
  return audioResponse(bytes, "aura", false);
}

async function speakRequest(request: Request, env: Env, url: URL, voiceId: string, waitUntil: (work: Promise<unknown>) => void): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const token = includedKey(request);
  if (!token) return apiError(NO_TRIAL, CHALLENGE);
  const keySha256 = await sha256Hex(token);
  if (!(await allowed(env.INCLUDED_LIMIT, keySha256, "refuse"))) return apiError(TOO_MANY);
  const body = await readBody(request, 32 * 1024);
  if (!body.ok) return body.response;
  const parsed = speechRequest(voiceId, url.searchParams, body.value);
  if (!parsed.ok) return apiError(parsed.refusal);
  if (!env.AI) return apiError(NOT_INCLUDED);
  const allowance = await trials(env).allowUsage({ keySha256, kind: "voice_chars", amount: parsed.request.text.length, perKey: VOICE_CHARS_PER_DAY, total: VOICE_CHARS_TOTAL_PER_DAY });
  if (!allowance.ok) return apiError(allowance.refusal, allowance.refusal.status === 401 ? CHALLENGE : {});
  const metadata = gatewayMetadata(keySha256, allowance.tier);
  const cache = new SpeechCache(edgeSpeechStore(), url.origin, waitUntil);
  try {
    const voice = elevenLabsFor(env, allowance.tier);
    if (voice) {
      const spoken = await elevenLabsSpeech(env, voice, parsed.request, keySha256, metadata, cache);
      if (spoken) return spoken;
    }
    return await auraSpeech(env, parsed.request, metadata, cache);
  } catch (error) {
    console.error(`laterdog computers: speech failed: ${error instanceof Error ? error.message : String(error)}`);
    return apiError(INCLUDED_FAILED);
  }
}

async function scribeTranscribe(request: TranscriptionRequest, key: string): Promise<Transcript | null> {
  try {
    const response = await fetch(SCRIBE_URL, { method: "POST", headers: { "xi-api-key": key }, body: scribeForm(request), signal: AbortSignal.timeout(scribeTimeout(request)) });
    if (!response.ok) {
      console.error(`laterdog computers: Scribe failed: ElevenLabs answered ${response.status}`);
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return scribeTranscript(await response.json());
  } catch (error) {
    console.error(`laterdog computers: Scribe failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function transcribeRequest(request: Request, env: Env): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const token = includedKey(request);
  if (!token) return apiError(NO_TRIAL, CHALLENGE);
  const keySha256 = await sha256Hex(token);
  if (!(await allowed(env.INCLUDED_LIMIT, keySha256, "refuse"))) return apiError(TOO_MANY);
  const form = await readForm(request, TRANSCRIBE_MAX_BYTES + 64 * 1024);
  if (!form.ok) return form.response;
  const parsed = await transcriptionRequest(form.value);
  if (!parsed.ok) return apiError(parsed.refusal);
  if (!env.AI) return apiError(NOT_INCLUDED);
  const allowance = await trials(env).allowUsage({ keySha256, kind: "transcribe_seconds", amount: parsed.request.seconds, perKey: TRANSCRIBE_SECONDS_PER_DAY, total: TRANSCRIBE_SECONDS_TOTAL_PER_DAY });
  if (!allowance.ok) return apiError(allowance.refusal, allowance.refusal.status === 401 ? CHALLENGE : {});
  const scribe = scribeKey(env);
  if (scribe) {
    const transcript = await scribeTranscribe(parsed.request, scribe);
    if (transcript) return json(transcript, 200, { "x-transcribe-engine": "elevenlabs" });
  }
  try {
    const model = transcribeModel(env);
    const run = env.AI.run.bind(env.AI) as (model: string, input: Record<string, unknown>, options?: unknown) => Promise<unknown>;
    const input = transcribeInput(parsed.request, model);
    const raw = takesGateway(model) ? await run(model, input, gatewayOptions(env, gatewayMetadata(keySha256, allowance.tier))) : await run(model, input);
    const transcript = transcriptFrom(raw);
    return transcript ? json(transcript, 200, { "x-transcribe-engine": model === TRANSCRIBE_MODEL ? "nova-3" : "whisper" }) : apiError(INCLUDED_FAILED);
  } catch (error) {
    console.error(`laterdog computers: transcription failed: ${error instanceof Error ? error.message : String(error)}`);
    return apiError(INCLUDED_FAILED);
  }
}

type ChatAnswer = { stream: ReadableStream<Uint8Array> } | { answer: Record<string, unknown> };

const isAnswer = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && !(value instanceof ReadableStream);

async function grokAnswer(env: Env, request: ChatRequest, key: string, metadata: GatewayMetadata): Promise<ChatAnswer | null> {
  try {
    const upstream = await env.AI.gateway(gatewayId(env)).run(withMetadata(grokRequest(request, key), metadata));
    if (upstream.ok && upstream.body) {
      if (request.stream) {
        const stream = await usableStream(plainErrors(upstream.body));
        if (stream) return { stream };
        console.error("laterdog computers: chat stream opened with an error");
        return null;
      }
      const answer = (await upstream.json()) as Record<string, unknown>;
      if (answer.error === undefined) return { answer };
      console.error(`laterdog computers: chat answered an error: ${JSON.stringify(answer.error).slice(0, 500)}`);
      return null;
    }
    const detail = (await upstream.text().catch(() => "")).slice(0, 500);
    console.error(`laterdog computers: chat answered ${upstream.status}: ${detail}`);
  } catch (error) {
    console.error(`laterdog computers: chat failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

async function workersAnswer(env: Env, request: ChatRequest, metadata: GatewayMetadata): Promise<ChatAnswer | null> {
  try {
    const model = env.TRIAL_AI_WORKERS_MODEL?.trim() || AI_WORKERS_MODEL;
    const result: unknown = await (env.AI.run as (model: string, input: Record<string, unknown>, options: unknown) => Promise<unknown>)(model, workersInput(request), gatewayOptions(env, metadata));
    if (result instanceof ReadableStream) {
      const stream = await usableStream(openAiStream(result as ReadableStream<Uint8Array>));
      if (stream) return { stream };
      console.error("laterdog computers: Workers AI chat stream opened with an error");
      return null;
    }
    if (isAnswer(result) && result.error === undefined) return { answer: result };
    console.error("laterdog computers: Workers AI chat returned nothing usable");
  } catch (error) {
    console.error(`laterdog computers: Workers AI chat failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

async function anthropicAnswer(env: Env, body: MessagesRequest, metadata: GatewayMetadata): Promise<ChatAnswer | null> {
  try {
    const upstream = await env.AI.gateway(gatewayId(env)).run(withMetadata(anthropicGatewayRequest(body), metadata));
    if (upstream.ok && upstream.body) {
      if (body.stream) {
        const stream = await usableStream(chatCompletionStream(upstream.body));
        if (stream) return { stream };
        console.error("laterdog computers: Claude chat stream opened with an error or a refusal");
        return null;
      }
      const answer = chatCompletion(await upstream.json());
      if (answer) return { answer };
      console.error("laterdog computers: Claude chat returned nothing usable or refused");
      return null;
    }
    const detail = (await upstream.text().catch(() => "")).slice(0, 500);
    console.error(`laterdog computers: Claude chat answered ${upstream.status}: ${detail}`);
  } catch (error) {
    console.error(`laterdog computers: Claude chat failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return null;
}

const PROMPT_TOO_LARGE: Refusal = { status: 413, code: "prompt_too_large", message: `The free model takes prompts of up to about ${AI_MAX_PROMPT_TOKENS / 1000}k tokens. Start a new chat or send less.` };

type ChatAttempt = { provider: "anthropic" | "grok" | "workers"; budget: TokenBudget; cap?: TokenBudget; answer: (metadata: GatewayMetadata) => Promise<ChatAnswer | null> };

function standingAttempts(env: Env, request: ChatRequest, asked: string): ChatAttempt[] {
  const workers: ChatAttempt = { provider: "workers", budget: AI_BUDGET, answer: (metadata) => workersAnswer(env, request, metadata) };
  const key = env.XAI_API_KEY?.trim();
  if (!key) return [workers];
  const grok = (budget: TokenBudget): ChatAttempt => ({ provider: "grok", budget, answer: (metadata) => grokAnswer(env, request, key, metadata) });
  if (asked.startsWith("grok")) return [grok(GROK_BUDGET), workers, grok(AI_BUDGET)];
  if (!asked.startsWith("kimi") && env.TRIAL_AI_FIRST?.trim() === "xai") return [grok(AI_BUDGET), workers];
  return [workers, grok(AI_BUDGET)];
}

function chatAttempts(env: Env, request: ChatRequest, asked: string): ChatAttempt[] {
  const standing = standingAttempts(env, request, asked);
  if (!anthropicFirst(env) || asked.startsWith("grok")) return standing;
  const body = messagesRequest(request, anthropicModel(env));
  if (!body) return standing;
  return [{ provider: "anthropic", budget: AI_BUDGET, cap: anthropicBudget(env), answer: (metadata) => anthropicAnswer(env, body, metadata) }, ...standing];
}

function deliverChat(result: ChatAnswer, reservation: Reservation, waitUntil: (work: Promise<unknown>) => void): Promise<Response> | Response {
  if ("answer" in result) return reservation.settle(tokensOf(result.answer.usage)).then(() => json(result.answer));
  const [toClient, toCount] = result.stream.tee();
  waitUntil(streamedTokens(toCount).then((tokens) => reservation.settle(tokens)).catch((error) => console.error(`laterdog computers: counting chat tokens failed: ${String(error)}`)));
  return new Response(toClient, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

async function chatRequestHandler(request: Request, env: Env, waitUntil: (work: Promise<unknown>) => void): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const token = includedKey(request);
  if (!token) return apiError(NO_TRIAL, CHALLENGE);
  const keySha256 = await sha256Hex(token);
  if (!(await allowed(env.INCLUDED_LIMIT, keySha256, "refuse"))) return apiError(TOO_MANY);
  if (!env.AI) return apiError(NOT_INCLUDED);
  const body = await readBody(request, AI_MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = chatRequest(body.value, env.TRIAL_AI_MODEL?.trim() || AI_DEFAULT_MODEL);
  if (!parsed.ok) return apiError(parsed.refusal);
  const estimate = chatEstimate(parsed.request);
  if (estimate.prompt > AI_MAX_PROMPT_TOKENS) return apiError(PROMPT_TOO_LARGE);
  const registry = trials(env);
  const asked = body.value && typeof body.value === "object" ? String((body.value as { model?: unknown }).model ?? "") : "";
  const tried = new Set<ChatAttempt["provider"]>();
  let refusal: Refusal | null = null;
  for (const attempt of chatAttempts(env, parsed.request, asked)) {
    if (tried.has(attempt.provider)) continue;
    const capped = attempt.cap ? await reserveTokens(registry, keySha256, attempt.cap, estimate.reserve) : null;
    if (capped && !capped.ok) continue;
    const held = await reserveTokens(registry, keySha256, attempt.budget, estimate.reserve);
    if (!held.ok) {
      await capped?.reservation.refund();
      if (held.refusal.status === 401) return apiError(held.refusal, CHALLENGE);
      if (attempt.budget === AI_BUDGET || !refusal) refusal = held.refusal;
      continue;
    }
    tried.add(attempt.provider);
    const reservation = capped ? jointReservation(held.reservation, capped.reservation) : held.reservation;
    const result = await attempt.answer(gatewayMetadata(keySha256, held.reservation.tier));
    if (result) return await deliverChat(result, reservation, waitUntil);
    await reservation.refund();
  }
  if (tried.size === 0 && refusal) return apiError(refusal);
  return apiError({ status: 502, code: "upstream_failed", message: "The model did not answer. Try again." });
}

async function serve(request: Request, env: Env, via: Via, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const target = route(request.method, url.pathname);
  try {
    if (via === "binding" && target.kind !== "health" && !url.pathname.startsWith("/v1/")) return apiError(NO_ENDPOINT);
    switch (target.kind) {
      case "health":
        return new Response("ok\n", { headers: { "cache-control": "no-store" } });
      case "redirect":
        return new Response(null, { status: 302, headers: { location: target.location, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
      case "desktop":
        return await computer(env, target.id).fetch(request);
      case "not_found":
        return target.api ? apiError(NO_ENDPOINT) : new Response("Not found\n", { status: 404 });
      case "method_not_allowed":
        return apiError({ status: 405, code: "method_not_allowed", message: `Use ${target.allow.join(" or ")}.` }, { allow: target.allow.join(", ") });
      case "trial_page":
        return await trialPageRequest(request, env, url);
      case "trial_offer":
        if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
        return json({ ...trialOffer(trialPolicy(env)), ...includedField(env), ...(squareConfigured(env) ? { planOffered: true } : {}) });
      case "decide":
        return await decideRequest(request, env);
      case "mcp":
        return await mcpRequest(request, env, via, url);
      case "voices":
        return await voicesRequest(request, env);
      case "plan":
        return await planRequest(target.op, request, env, url);
      case "plan_done":
        return await planDonePage(env, url);
      case "chat":
        return await chatRequestHandler(request, env, (work) => (ctx ? ctx.waitUntil(work) : void work));
      case "complete":
        return await completeHandler(request, env);
      case "speak":
        return await speakRequest(request, env, url, target.voiceId, (work) => (ctx ? ctx.waitUntil(work) : void work));
      case "transcribe":
        return await transcribeRequest(request, env);
      case "trial_start":
        return await startTrialFromApp(request, env);
      case "home_grant":
        if (via !== "binding") return apiError(NO_ENDPOINT);
        return await grantHome(request, env);
      case "trial":
      case "trial_grant":
      case "collection":
      case "computer": {
        const identified = await identify(request, env, via);
        if (!identified.ok) return identified.response;
        const { caller } = identified;
        if (target.kind === "trial") return await trialRequest(target.op, env, caller);
        if (target.kind === "trial_grant") return await grantTrial(request, env, caller);
        if (target.kind === "collection") return target.op === "list" ? await listComputers(caller) : await createComputer(request, env, caller);
        return await computerRequest(target.op, target.id, request, env, url, caller);
      }
    }
  } catch (error) {
    const path = url.pathname.replace(/^(\/desktop\/[^/]+\/)[^/]+/, "$1<token>");
    console.error(`laterdog computers: ${request.method} ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return apiError({ status: 500, code: "internal", message: "Something went wrong; the error was logged." });
  }
}

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => serve(request, env, "public", ctx),
} satisfies ExportedHandler<Env>;

export class ComputersApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return serve(request, this.env, "binding", this.ctx);
  }
}
