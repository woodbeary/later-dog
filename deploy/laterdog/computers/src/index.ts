// later.dog cloud computers: every dog gets its own Linux desktop on Cloudflare Containers.
//
// This Worker is the front door. /v1/... is the API later.dog's server calls (bearer key, server to server only);
// /desktop/<id>/<token>/... is the signed viewer link a person opens to watch a computer and take it over. Each computer is
// a DogComputer Durable Object addressed by its id (src/computer.ts); one ComputerRegistry Durable Object lists them
// (src/registry.ts). README.md describes the API, the costs and the idle policy.

import { WorkerEntrypoint } from "cloudflare:workers";
import { BROWSER_ORIGIN, type Refusal, bearerToken, refuseApiRequest, sha256Hex } from "./auth";
import type { DogComputer, Result } from "./computer";
import { TooLarge, apiError, json, readLimited } from "./http";
import { CLEF_MODEL, DECIDE_MAX_BODY_BYTES, DECISIONS_PER_DAY, DECISIONS_TOTAL_PER_DAY, VOICE_CHARS_TOTAL_PER_DAY, clefInput, decisionFrom } from "./decide";
import { maxComputers } from "./idle";
import { FILE_MAX_BYTES, JSON_MAX_BYTES, parseCreate, parseExec, parseIdempotencyKey, parsePath, parseRename } from "./inputs";
import type { ComputerRegistry } from "./registry";
import { type ComputerOp, type TrialOp, route } from "./routes";
import {
  TRIAL_CLAIM,
  TRIAL_FORM_MAX_BYTES,
  TRIAL_TOKEN,
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
import { trials } from "./trial-registry";
import { messagePage, newNonce } from "./viewer";
import { INCLUDED_VOICES, VOICE_CHARS_PER_DAY, VOICE_MODEL, audioBytes, elevenLabsRequest, speechRequest, voiceInput } from "./voice";

export { DogComputer } from "./computer";
export { ComputerRegistry } from "./registry";
export { TrialRegistry } from "./trial-registry";

// Secrets are set with `wrangler secret put` (README.md), so the generated Env type does not know them.
declare global {
  interface Env {
    COMPUTERS_KEY_SHA256?: string;
    DESKTOP_SIGNING_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    TRIAL_NETWORK_KEY?: string;
    AI_GATEWAY_ID?: string;
    ELEVENLABS_API_KEY?: string;
  }
}

type Caller = { registry: DurableObjectStub<ComputerRegistry>; trial?: TrialRecord };

type Identified = { ok: true; caller: Caller } | { ok: false; response: Response };

type Via = "public" | "binding";

const CHALLENGE = { "www-authenticate": 'Bearer realm="laterdog-computers"' };
const TRIALS_OFF: Refusal = { status: 503, code: "trials_off", message: "Free trials are switched off on this service right now." };
const NO_COMPUTER: Refusal = { status: 404, code: "not_found", message: "No computer with that id." };
const NO_TRIAL: Refusal = { status: 401, code: "unauthorized", message: "This free trial has ended or has not started yet." };
const TOO_MANY: Refusal = { status: 429, code: "rate_limited", message: "Too many requests from this network. Wait a minute, then try again." };

async function allowed(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try {
    return (await limiter.limit({ key })).success;
  } catch {
    return true;
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
    const trial = await trials(env).find(await sha256Hex(token));
    if (!trial) return { ok: false, response: apiError(NO_TRIAL, CHALLENGE) };
    return { ok: true, caller: { registry: registry(env, trialListing(trial.id)), trial } };
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
  if (caller.trial && !trialPolicy(env).enabled) return apiError(TRIALS_OFF);
  const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
  if (!key.ok) return apiError(key.refusal);
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const input = parseCreate(body.value);
  if (!input.ok) return apiError(input.refusal);
  if (caller.trial && input.value.size !== "standard") {
    return apiError({ status: 403, code: "trial_size", message: "A free trial computer is the standard size." });
  }
  const reservation = await caller.registry.reserve({
    ...input.value,
    ...(key.value === undefined ? {} : { idempotencyKey: key.value }),
    max: caller.trial ? 1 : maxComputers(env),
  });
  if (!reservation.ok) {
    if (caller.trial && reservation.refusal.code === "limit_reached") {
      return apiError({ ...reservation.refusal, message: "A free trial has one computer at a time; delete it first." });
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
    });
  } catch (error) {
    result = { ok: false, refusal: { status: 502, code: "start_failed", message: error instanceof Error ? error.message : String(error) } };
  }
  if (!result.ok) {
    // A computer that never started is not kept around (or counted against the cap).
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
      // Deleting is idempotent while the registry still lists the computer (an earlier delete stopped halfway).
      if (!result.ok && !(result.refusal.status === 404 && listed)) return apiError(result.refusal);
      return json({ deleted: true });
    }
    case "wake":
      if (caller.trial && !trialPolicy(env).enabled) return apiError(TRIALS_OFF);
      return answer(await stub.wake(), (value) => json({ computer: value }));
    case "sleep":
      return answer(await stub.sleep("request"), (value) => json({ computer: value }));
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

async function trialRequest(op: TrialOp, env: Env, caller: Caller): Promise<Response> {
  const trial = caller.trial;
  if (!trial) return apiError({ status: 404, code: "no_trial", message: "This key is not a free trial key." });
  if (op === "end") {
    await trials(env).end(trial.id);
    return json({ ended: true });
  }
  for (const listed of await caller.registry.list()) await computer(env, listed.id).meter();
  const current = await trials(env).lookup(trial.id);
  if (!current) return apiError(NO_TRIAL, CHALLENGE);
  return json({ trial: trialView(current) });
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
  if (!(await allowed(env.TRIAL_FORM_LIMIT, network))) return page(429, "Too many tries", "Wait a minute, then try again.");
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

const aiGateway = (env: Env) => ({ gateway: { id: env.AI_GATEWAY_ID?.trim() || "default", collectLog: false } });

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

async function decideRequest(request: Request, env: Env): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const token = includedKey(request);
  if (!token) return apiError(NO_TRIAL, CHALLENGE);
  const keySha256 = await sha256Hex(token);
  if (!(await allowed(env.INCLUDED_LIMIT, keySha256))) return apiError(TOO_MANY);
  const body = await readBody(request, DECIDE_MAX_BODY_BYTES);
  if (!body.ok) return body.response;
  const parsed = decisionFrom(body.value);
  if (!parsed.ok) return apiError(parsed.refusal);
  if (!env.AI) return apiError(NOT_INCLUDED);
  const allowance = await trials(env).allowUsage({ keySha256, kind: "decisions", amount: 1, perKey: DECISIONS_PER_DAY, total: DECISIONS_TOTAL_PER_DAY });
  if (!allowance.ok) return apiError(allowance.refusal, allowance.refusal.status === 401 ? CHALLENGE : {});
  try {
    return json(await env.AI.run(CLEF_MODEL, clefInput(parsed.decision), aiGateway(env)));
  } catch (error) {
    console.error(`laterdog computers: decision failed: ${error instanceof Error ? error.message : String(error)}`);
    return apiError(INCLUDED_FAILED);
  }
}

async function voicesRequest(request: Request): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  if (!includedKey(request)) return apiError(NO_TRIAL, CHALLENGE);
  return json({ voices: INCLUDED_VOICES });
}

async function speakRequest(request: Request, env: Env, url: URL, voiceId: string): Promise<Response> {
  if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
  const token = includedKey(request);
  if (!token) return apiError(NO_TRIAL, CHALLENGE);
  const keySha256 = await sha256Hex(token);
  if (!(await allowed(env.INCLUDED_LIMIT, keySha256))) return apiError(TOO_MANY);
  const body = await readBody(request, 32 * 1024);
  if (!body.ok) return body.response;
  const parsed = speechRequest(voiceId, url.searchParams, body.value);
  if (!parsed.ok) return apiError(parsed.refusal);
  if (!env.AI) return apiError(NOT_INCLUDED);
  const allowance = await trials(env).allowUsage({ keySha256, kind: "voice_chars", amount: parsed.request.text.length, perKey: VOICE_CHARS_PER_DAY, total: VOICE_CHARS_TOTAL_PER_DAY });
  if (!allowance.ok) return apiError(allowance.refusal, allowance.refusal.status === 401 ? CHALLENGE : {});
  try {
    const key = env.ELEVENLABS_API_KEY?.trim();
    if (key) {
      const upstream = await env.AI.gateway(aiGateway(env).gateway.id).run(elevenLabsRequest(parsed.request, key));
      if (!upstream.ok || !upstream.body) {
        console.error(`laterdog computers: speech failed: ElevenLabs answered ${upstream.status}`);
        await upstream.body?.cancel().catch(() => {});
        return apiError(INCLUDED_FAILED);
      }
      return new Response(upstream.body, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    const bytes = await audioBytes(await env.AI.run(VOICE_MODEL, voiceInput(parsed.request), aiGateway(env)));
    if (!bytes || bytes.byteLength === 0) return apiError(INCLUDED_FAILED);
    return new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
  } catch (error) {
    console.error(`laterdog computers: speech failed: ${error instanceof Error ? error.message : String(error)}`);
    return apiError(INCLUDED_FAILED);
  }
}

async function serve(request: Request, env: Env, via: Via): Promise<Response> {
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
        // The computer's Durable Object checks the link against its current boot and serves or proxies the request.
        return await computer(env, target.id).fetch(request);
      case "not_found":
        return target.api ? apiError(NO_ENDPOINT) : new Response("Not found\n", { status: 404 });
      case "method_not_allowed":
        return apiError({ status: 405, code: "method_not_allowed", message: `Use ${target.allow.join(" or ")}.` }, { allow: target.allow.join(", ") });
      case "trial_page":
        return await trialPageRequest(request, env, url);
      case "trial_offer":
        if (request.headers.has("origin")) return apiError(BROWSER_ORIGIN);
        return json(trialOffer(trialPolicy(env)));
      case "decide":
        return await decideRequest(request, env);
      case "voices":
        return await voicesRequest(request);
      case "speak":
        return await speakRequest(request, env, url, target.voiceId);
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
  fetch: (request: Request, env: Env): Promise<Response> => serve(request, env, "public"),
} satisfies ExportedHandler<Env>;

export class ComputersApi extends WorkerEntrypoint<Env> {
  override fetch(request: Request): Promise<Response> {
    return serve(request, this.env, "binding");
  }
}
