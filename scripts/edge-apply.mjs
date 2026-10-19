import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { connect } from "node:tls";
import { fileURLToPath } from "node:url";

const API_BASE = "https://api.cloudflare.com/client/v4";
const PROXY_TYPES = new Set(["A", "AAAA", "CNAME"]);
const RULE_SERVER_FIELDS = ["id", "version", "last_updated", "categories"];
const GATEWAY_FIELDS = [
  "authentication",
  "byok_only",
  "cache_invalidate_on_update",
  "cache_ttl",
  "collect_logs",
  "log_classification",
  "log_management",
  "log_management_strategy",
  "logpush",
  "rate_limiting_interval",
  "rate_limiting_limit",
  "rate_limiting_technique",
  "retry_backoff",
  "retry_delay",
  "retry_max_attempts",
  "spend_limits",
  "workers_ai_billing_mode",
  "zdr",
];
const WIDGET_FIELDS = ["sitekey", "name", "domains", "mode", "bot_fight_mode", "clearance_level", "offlabel", "region", "ephemeral_id"];
const RECORD_FIELDS = ["id", "type", "name", "content", "proxied", "ttl", "comment"];
const MISSING_CODES = new Set([10003, 7002]);

export const EDGE_DIR = fileURLToPath(new URL("../deploy/laterdog/edge/", import.meta.url));
export const STEP_ORDER = ["rate-limits", "managed-rules", "bots", "ai-gateway", "dns", "zone-settings", "ssl-strict", "workers-dev", "turnstile"];
export const TOKEN_VARIABLE = "CLOUDFLARE_API_TOKEN";

const pick = (value, fields) => Object.fromEntries(fields.filter((field) => value?.[field] !== undefined).map((field) => [field, value[field]]));
const omit = (value, fields) => Object.fromEntries(Object.entries(value).filter(([field]) => !fields.includes(field)));
const show = (value) => (value === undefined ? "unset" : JSON.stringify(value));
const readJson = (dir, name) => JSON.parse(readFileSync(resolve(dir, name), "utf8"));

export function matches(want, have) {
  if (Array.isArray(want)) {
    if (!Array.isArray(have) || want.length !== have.length) return false;
    if (want.every((item) => typeof item !== "object")) return [...want].sort().join("\n") === [...have].sort().join("\n");
    return want.every((item, index) => matches(item, have[index]));
  }
  if (want && typeof want === "object") {
    if (!have || typeof have !== "object" || Array.isArray(have)) return false;
    return Object.entries(want).every(([field, value]) => matches(value, have[field]));
  }
  return want === have || (want === null && have === undefined);
}

export function validateRateLimits(file) {
  const problems = [];
  if (file.rules.length > file.maxRules) problems.push(`${file.rules.length} rules, the zone allows ${file.maxRules}`);
  const refs = new Set();
  for (const rule of file.rules) {
    if (!rule.ref) problems.push(`a rule has no ref: ${rule.description}`);
    if (refs.has(rule.ref)) problems.push(`ref ${rule.ref} is used twice`);
    refs.add(rule.ref);
    const limit = rule.ratelimit ?? {};
    if (!file.allowedPeriods.includes(limit.period)) problems.push(`${rule.ref}: period ${limit.period} is not one of ${file.allowedPeriods.join(", ")}`);
    if (!(limit.mitigation_timeout > 0 && limit.mitigation_timeout <= file.maxMitigationTimeout)) problems.push(`${rule.ref}: mitigation_timeout must be 1-${file.maxMitigationTimeout}`);
    if (!(limit.requests_per_period >= 2)) problems.push(`${rule.ref}: requests_per_period must be at least 2`);
    for (const characteristic of ["ip.src", "cf.colo.id"]) {
      if (!limit.characteristics?.includes(characteristic)) problems.push(`${rule.ref}: characteristics need ${characteristic}`);
    }
  }
  return problems;
}

export function validateManagedRules(file) {
  const problems = [];
  const refs = new Set();
  const executed = new Map();
  for (const rule of file.rules) {
    if (!rule.ref) problems.push(`a rule has no ref: ${rule.description}`);
    if (refs.has(rule.ref)) problems.push(`ref ${rule.ref} is used twice`);
    refs.add(rule.ref);
    if (rule.action !== "execute") continue;
    const ruleset = rule.action_parameters?.id;
    if (!ruleset) {
      problems.push(`${rule.ref}: execute needs action_parameters.id`);
      continue;
    }
    if (executed.has(ruleset)) problems.push(`${rule.ref} and ${executed.get(ruleset)} both execute ${ruleset}; Cloudflare refuses a second rule for the same managed ruleset, so cover every host in one rule`);
    else executed.set(ruleset, rule.ref);
  }
  if (file.logModeSince !== undefined) {
    if (Number.isNaN(logModeStart(file.logModeSince))) problems.push(`logModeSince ${file.logModeSince} is not a YYYY-MM-DD date or an ISO timestamp`);
    if (!(Number.isFinite(file.logModeHours) && file.logModeHours > 0)) problems.push("logModeHours must be a positive number of hours when logModeSince is set");
  }
  return problems;
}

const logModeStart = (since) => Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00Z` : since);

export function logModeDue(since, hours) {
  if (!since) return null;
  const start = logModeStart(since);
  if (Number.isNaN(start) || !(Number.isFinite(hours) && hours > 0)) return null;
  const due = new Date(start + hours * 3600 * 1000).toISOString();
  return /^\d{4}-\d{2}-\d{2}$/.test(since) ? due.slice(0, 10) : `${due.slice(0, 16).replace("T", " ")}Z`;
}

const overridesOf = (rule) => rule?.action_parameters?.overrides ?? {};
export const loggedOnly = (rule) => overridesOf(rule).action === "log";

export function resolveSpendRules(rules, env) {
  const notes = [];
  const resolved = [];
  for (const rule of rules) {
    if (!rule.limitFromEnv) {
      resolved.push(rule);
      continue;
    }
    const { limitFromEnv, ...rest } = rule;
    const raw = env[limitFromEnv]?.trim();
    if (!raw) {
      notes.push(`${rule.id} is left out until ${limitFromEnv} holds the dollars per day (a month's ElevenLabs credit / 30)`);
      continue;
    }
    const limit = Number(raw);
    if (!(Number.isFinite(limit) && limit > 0)) throw new Error(`${limitFromEnv} must be a positive number of dollars`);
    resolved.push({ ...rest, limit });
  }
  return { rules: resolved, notes };
}

export function loadDesired(dir = EDGE_DIR, env = process.env) {
  const zone = readJson(dir, "zone.json");
  const rateLimits = readJson(dir, "rate-limits.json");
  const managed = readJson(dir, "managed-rules.json");
  const bots = readJson(dir, "bots.json");
  const gateway = readJson(dir, "ai-gateway.json");
  const workersDev = readJson(dir, "workers-dev.json");
  const problems = validateRateLimits(rateLimits);
  if (problems.length) throw new Error(`rate-limits.json: ${problems.join("; ")}`);
  const managedProblems = validateManagedRules(managed);
  if (managedProblems.length) throw new Error(`managed-rules.json: ${managedProblems.join("; ")}`);
  const spend = resolveSpendRules(gateway.spendLimits.rules, env);
  return {
    zoneName: zone.name,
    workerOrigins: zone.workerOrigins,
    rulesets: { [rateLimits.phase]: rateLimits.rules, [managed.phase]: managed.rules },
    logModeHours: managed.logModeHours,
    logModeSince: managed.logModeSince,
    bots: bots.settings,
    gateway: {
      id: gateway.id,
      settings: gateway.settings,
      spendLimits: { enabled: gateway.spendLimits.enabled, rules: spend.rules },
      byokOnlyWhenKeysFor: gateway.byokOnlyWhenKeysFor,
      providerAliases: gateway.providerAliases,
    },
    dns: zone.dns,
    settings: zone.settings,
    ssl: zone.ssl,
    workersDev: workersDev.scripts,
    turnstile: workersDev.turnstile,
    notes: spend.notes,
  };
}

export class ApiError extends Error {
  constructor(method, path, status, errors) {
    super(`${method} ${path} answered ${status}: ${errors.map((error) => `${error.code} ${error.message}`).join("; ") || "no details"}`);
    this.status = status;
    this.codes = errors.map((error) => error.code);
  }
}

export function requestKey(method, path, query) {
  const entries = Object.entries(query ?? {}).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b));
  return `${method} ${path}${entries.length ? `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)]))}` : ""}`;
}

function withReads(request) {
  const get = (path, query) => request("GET", path, { query }).then((payload) => payload.result);
  return {
    request,
    get,
    async getOrNull(path, query) {
      try {
        return await get(path, query);
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.codes.some((code) => MISSING_CODES.has(code)))) return null;
        throw error;
      }
    },
    async getAll(path) {
      const items = [];
      for (let page = 1; ; page += 1) {
        const payload = await request("GET", path, { query: { page, per_page: 100 } });
        items.push(...payload.result);
        if (page >= (payload.info?.total_pages ?? 1)) return items;
      }
    },
  };
}

export function createApi({ token, fetchImpl = fetch }) {
  return withReads(async (method, path, { query, body } = {}) => {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) throw new ApiError(method, path, response.status, payload.errors ?? []);
    return { result: payload.result, info: payload.result_info };
  });
}

export class NotRecorded extends Error {}

export function createReplayApi(recording) {
  return withReads(async (method, path, { query, body } = {}) => {
    if (method !== "GET" || body !== undefined) throw new Error(`a replay is read-only; refused ${method} ${path}`);
    const key = requestKey(method, path, query);
    const entry = recording[key];
    if (!entry) throw new NotRecorded(key);
    if (entry.error) throw new ApiError(method, path, entry.error.status, entry.error.errors ?? []);
    return { result: entry.result, info: entry.result_info };
  });
}

export async function readState(api, desired) {
  const [zone] = await api.get("/zones", { name: desired.zoneName });
  if (!zone) throw new Error(`zone ${desired.zoneName} is not visible to this token`);
  const zonePath = `/zones/${zone.id}`;
  const accountPath = `/accounts/${zone.account.id}`;
  const rulesets = {};
  for (const phase of Object.keys(desired.rulesets)) {
    const entrypoint = await api.getOrNull(`${zonePath}/rulesets/phases/${phase}/entrypoint`);
    rulesets[phase] = entrypoint ? entrypoint.rules ?? [] : null;
  }
  const settings = {};
  for (const id of [...desired.settings.map((setting) => setting.id), "ssl"]) settings[id] = (await api.get(`${zonePath}/settings/${id}`)).value;
  const gatewayPath = `${accountPath}/ai-gateway/gateways/${desired.gateway.id}`;
  const gateway = await api.getOrNull(gatewayPath);
  const subdomains = {};
  for (const script of Object.keys(desired.workersDev)) subdomains[script] = pick(await api.get(`${accountPath}/workers/scripts/${script}/subdomain`), ["enabled", "previews_enabled"]);
  const widgets = await api.get(`${accountPath}/challenges/widgets`);
  return {
    zone: { id: zone.id, name: zone.name, accountId: zone.account.id },
    rulesets,
    bots: pick(await api.get(`${zonePath}/bot_management`), Object.keys(desired.bots)),
    settings,
    dns: (await api.getAll(`${zonePath}/dns_records`)).map((record) => pick(record, RECORD_FIELDS)),
    customDomains: (await api.get(`${accountPath}/workers/domains`, { zone_id: zone.id })).map((domain) => domain.hostname),
    gateway: gateway ? { id: gateway.id, ...pick(gateway, GATEWAY_FIELDS) } : null,
    providerKeys: gateway ? (await api.get(`${gatewayPath}/provider_configs`)).map((config) => config.provider_slug) : [],
    subdomains,
    widget: widgets.filter((widget) => widget.sitekey === desired.turnstile?.sitekey).map((widget) => pick(widget, WIDGET_FIELDS))[0] ?? null,
  };
}

export function effectiveRecords(desired, state, includeDns, { prune = false } = {}) {
  if (!includeDns || dnsStep(desired.dns, state.dns, "", { prune }).status === "blocked") return state.dns;
  const managed = new Set(desired.dns.map((record) => record.name));
  return [...state.dns.filter((record) => !(managed.has(record.name) && PROXY_TYPES.has(record.type))), ...desired.dns];
}

export function originTargets(desired, records, customDomains) {
  return records.filter(
    (record) => record.proxied && PROXY_TYPES.has(record.type) && !desired.workerOrigins.includes(record.content) && !customDomains.includes(record.name),
  );
}

export function checkOrigin(record, { timeoutMs = 5000 } = {}) {
  return new Promise((done) => {
    const servername = record.name.startsWith("*.") ? `edge-check.${record.name.slice(2)}` : record.name;
    const socket = connect({ host: record.content, port: 443, servername, rejectUnauthorized: false, timeout: timeoutMs });
    const finish = (result) => {
      socket.destroy();
      done(result);
    };
    socket.once("secureConnect", () => finish(socket.authorized ? { ok: true } : { ok: false, reason: String(socket.authorizationError) }));
    socket.once("timeout", () => finish({ ok: false, reason: "no TLS answer on port 443" }));
    socket.once("error", (error) => finish({ ok: false, reason: error.code ?? error.message }));
  });
}

function step(id, title) {
  return { id, title, status: "ok", lines: [], calls: [], notes: [] };
}

const cleanRule = (rule) => omit(rule, RULE_SERVER_FIELDS);
const ruleName = (rule) => rule.ref ?? rule.id ?? rule.description;

const sameOverrides = (want, have) => matches(overridesOf(want), overridesOf(have)) && matches(overridesOf(have), overridesOf(want));

export function ruleChanges(want, have) {
  const changed = Object.keys(cleanRule(want)).filter((field) => !matches(want[field], have[field]));
  if (!changed.includes("action_parameters") && !sameOverrides(want, have)) changed.push("action_parameters");
  return changed;
}

function rulesetStep(id, title, phase, wanted, current, { zonePath, prune }) {
  const result = step(id, title);
  const have = current ?? [];
  const wantedRefs = new Set(wanted.map((rule) => rule.ref));
  for (const rule of wanted) {
    const existing = have.find((candidate) => candidate.ref === rule.ref);
    if (!existing) result.lines.push(`+ ${rule.ref}  ${rule.description ?? ""}`.trimEnd());
    else {
      const changed = ruleChanges(rule, existing);
      for (const field of changed) result.lines.push(`~ ${rule.ref}.${field}: ${show(existing[field])} -> ${show(rule[field])}`);
    }
  }
  const strays = have.filter((rule) => !wantedRefs.has(rule.ref));
  for (const rule of strays) result.lines.push(`- ${ruleName(rule)}  ${rule.description ?? ""} (not in code)`.trimEnd());
  if (current === null) result.notes.push(`the ${phase} entrypoint does not exist yet; the PUT creates it`);
  if (!result.lines.length) return result;
  result.status = strays.length && !prune ? "blocked" : "change";
  if (result.status === "blocked") result.notes.push("rules made outside these files would be removed; re-run with --prune to remove them");
  result.calls.push({ method: "PUT", path: `${zonePath}/rulesets/phases/${phase}/entrypoint`, body: { rules: wanted.map(cleanRule) } });
  return result;
}

function botsStep(wanted, current, zonePath) {
  const result = step("bots", "Bot settings (no challenge on API hosts)");
  for (const [field, value] of Object.entries(wanted)) if (!matches(value, current[field])) result.lines.push(`~ ${field}: ${show(current[field])} -> ${show(value)}`);
  if (result.lines.length) {
    result.status = "change";
    result.calls.push({ method: "PUT", path: `${zonePath}/bot_management`, body: wanted });
  }
  return result;
}

export function byokOnly(gateway, providerKeys) {
  const missing = gateway.byokOnlyWhenKeysFor.filter((provider) => !(gateway.providerAliases?.[provider] ?? [provider]).some((slug) => providerKeys.includes(slug)));
  return { on: missing.length === 0, missing };
}

function gatewayStep(desired, state, accountPath) {
  const result = step("ai-gateway", `AI Gateway ${desired.gateway.id} and its spend limits`);
  const gatewaysPath = `${accountPath}/ai-gateway/gateways`;
  let body;
  if ("restore" in desired.gateway) {
    if (!desired.gateway.restore) {
      if (state.gateway) result.status = "report";
      if (state.gateway) result.lines.push(`! ${desired.gateway.id} did not exist before; delete it in the dashboard only after AI_GATEWAY_ID no longer names it`);
      return result;
    }
    body = desired.gateway.restore;
  } else {
    const byok = byokOnly(desired.gateway, state.providerKeys);
    body = { ...desired.gateway.settings, byok_only: byok.on, spend_limits: desired.gateway.spendLimits };
    result.notes.push(byok.on ? "byok_only turns on: every required provider key is stored on the gateway" : `byok_only stays off until provider keys exist for: ${byok.missing.join(", ")}`);
    result.notes.push(...desired.notes);
  }
  if (!state.gateway) {
    result.status = "change";
    result.lines.push(`+ gateway ${desired.gateway.id}`);
    for (const [field, value] of Object.entries(body)) result.lines.push(`+   ${field}: ${show(value)}`);
    result.calls.push({ method: "POST", path: gatewaysPath, body: { id: desired.gateway.id, ...body } });
    return result;
  }
  for (const [field, value] of Object.entries(body)) if (!matches(value, state.gateway[field])) result.lines.push(`~ ${field}: ${show(state.gateway[field])} -> ${show(value)}`);
  if (result.lines.length) {
    result.status = "change";
    result.calls.push({ method: "PUT", path: `${gatewaysPath}/${desired.gateway.id}`, body: { ...omit(state.gateway, ["id"]), ...body } });
  }
  return result;
}

const recordBody = (record) => omit(pick(record, RECORD_FIELDS), ["id"]);
const recordText = (record) => `${record.name} ${record.type} ${record.content}${record.proxied ? " (proxied)" : ""}`;

function dnsStep(wanted, records, zonePath, { prune }) {
  const result = step("dns", "Apex and www point at the site Worker, not Namecheap parking");
  for (const name of new Set(wanted.map((record) => record.name))) {
    const remaining = records.filter((record) => record.name === name && PROXY_TYPES.has(record.type));
    for (const record of wanted.filter((candidate) => candidate.name === name)) {
      let index = record.id ? remaining.findIndex((candidate) => candidate.id === record.id) : remaining.findIndex((candidate) => matches(recordBody(record), candidate));
      if (index < 0 && !record.id && remaining.length) index = 0;
      if (index < 0) {
        result.lines.push(`+ ${recordText(record)}`);
        result.calls.push({ method: "POST", path: `${zonePath}/dns_records`, body: recordBody(record) });
        continue;
      }
      const [existing] = remaining.splice(index, 1);
      if (matches(recordBody(record), existing)) continue;
      result.lines.push(`~ ${recordText(existing)} -> ${recordText(record)}`);
      result.calls.push({ method: "PUT", path: `${zonePath}/dns_records/${existing.id}`, body: recordBody(record) });
    }
    for (const extra of remaining) {
      result.lines.push(`- ${recordText(extra)}`);
      result.calls.push({ method: "DELETE", path: `${zonePath}/dns_records/${extra.id}` });
    }
  }
  if (!result.calls.length) return result;
  const deletes = result.calls.some((call) => call.method === "DELETE");
  result.status = deletes && !prune ? "blocked" : "change";
  if (result.status === "blocked") result.notes.push("records made outside these files would be deleted; re-run with --prune to delete them");
  return result;
}

function settingsStep(wanted, current, zonePath) {
  const result = step("zone-settings", "Zone hygiene: Always HTTPS, TLS 1.2, HSTS, Brotli, HTTP/3");
  for (const { id, value } of wanted) {
    if (matches(value, current[id])) continue;
    result.lines.push(`~ ${id}: ${show(current[id])} -> ${show(value)}`);
    result.calls.push({ method: "PATCH", path: `${zonePath}/settings/${id}`, body: { value } });
  }
  if (result.calls.length) result.status = "change";
  return result;
}

function sslStep(wanted, current, origins, zonePath) {
  const result = step("ssl-strict", `SSL mode ${wanted}`);
  if (wanted === current) return result;
  result.lines.push(`~ ssl: ${show(current)} -> ${show(wanted)}`);
  const failing = wanted === "strict" ? origins.filter((origin) => !origin.ok) : [];
  for (const origin of origins) result.notes.push(`origin ${origin.name} -> ${origin.content}: ${origin.ok ? "valid certificate" : `no valid certificate (${origin.reason})`}`);
  if (wanted === "strict" && !origins.length) result.notes.push("every proxied record points at a Worker, so no origin certificate is involved");
  if (failing.length) {
    result.status = "blocked";
    result.notes.push("Full (strict) would answer 526 for these hosts; fix or replace their origins first");
    return result;
  }
  result.status = "change";
  result.calls.push({ method: "PATCH", path: `${zonePath}/settings/ssl`, body: { value: wanted } });
  return result;
}

function workersDevStep(wanted, subdomains) {
  const result = step("workers-dev", "workers.dev and preview URLs that bypass the zone rules");
  for (const [script, expected] of Object.entries(wanted)) {
    const actual = subdomains[script] ?? {};
    const off = Object.entries(pick(expected, ["enabled", "previews_enabled"])).filter(([field, value]) => actual[field] !== value);
    if (!off.length) continue;
    result.lines.push(`! ${script}: ${off.map(([field, value]) => `${field} ${show(actual[field])}, want ${show(value)}`).join("; ")}`);
    result.notes.push(`${script}: ${expected.fix}`);
  }
  if (result.lines.length) result.status = "report";
  return result;
}

function turnstileStep(wanted, state, accountPath) {
  const result = step("turnstile", "Turnstile widget hostnames");
  if (!wanted) return result;
  if (!state.widget) {
    result.status = "report";
    result.lines.push(`! widget ${wanted.sitekey} is not on the account`);
    return result;
  }
  const domains = wanted.domains ?? state.widget.domains.filter((domain) => !domain.endsWith(wanted.dropDomainsEndingWith));
  if (matches(domains, state.widget.domains)) return result;
  result.lines.push(`~ domains: ${show(state.widget.domains)} -> ${show(domains)}`);
  if (wanted.after && state.subdomains[wanted.after]?.enabled !== false) {
    result.status = "waiting";
    result.notes.push(`waits until ${wanted.after}'s workers.dev URL is off, so the trial form there keeps working until then`);
    return result;
  }
  result.status = "change";
  const { sitekey, ...widget } = state.widget;
  result.calls.push({ method: "PUT", path: `${accountPath}/challenges/widgets/${sitekey}`, body: { ...widget, domains } });
  return result;
}

export function plan(desired, state, { origins = [], prune = false } = {}) {
  const zonePath = `/zones/${state.zone.id}`;
  const accountPath = `/accounts/${state.zone.accountId}`;
  const [rateLimitPhase, managedPhase] = Object.keys(desired.rulesets);
  const logged = desired.rulesets[managedPhase].filter(loggedOnly).map((rule) => rule.ref);
  const mode = logged.length ? "in log mode" : "with its own actions";
  const managed = rulesetStep("managed-rules", `Cloudflare Managed Ruleset ${mode} on every later.dog host`, managedPhase, desired.rulesets[managedPhase], state.rulesets[managedPhase], { zonePath, prune });
  const due = logModeDue(desired.logModeSince, desired.logModeHours);
  const when = due ? `logging since ${desired.logModeSince}; from ${due}` : `after ${desired.logModeHours ?? 48} h`;
  if (logged.length && !desired.rollback) managed.notes.push(`${logged.join(", ")} only log, ${when}, if Security > Events shows no false positives, delete the overrides in managed-rules.json so the ruleset's own actions apply, and apply again`);
  return [
    rulesetStep("rate-limits", "Zone rate limiting R1-R5", rateLimitPhase, desired.rulesets[rateLimitPhase], state.rulesets[rateLimitPhase], { zonePath, prune }),
    managed,
    botsStep(desired.bots, state.bots, zonePath),
    gatewayStep(desired, state, accountPath),
    dnsStep(desired.dns, state.dns, zonePath, { prune }),
    settingsStep(desired.settings, state.settings, zonePath),
    sslStep(desired.ssl, state.settings.ssl, origins, zonePath),
    workersDevStep(desired.workersDev, state.subdomains),
    turnstileStep(desired.turnstile, state, accountPath),
  ];
}

export function rollbackDesired(desired, snapshot) {
  const managedNames = new Set(desired.dns.map((record) => record.name));
  return {
    ...desired,
    rollback: true,
    rulesets: Object.fromEntries(Object.keys(desired.rulesets).map((phase) => [phase, (snapshot.rulesets[phase] ?? []).map(cleanRule)])),
    bots: snapshot.bots,
    gateway: { id: desired.gateway.id, restore: snapshot.gateway ? omit(snapshot.gateway, ["id"]) : null },
    dns: snapshot.dns.filter((record) => managedNames.has(record.name) && PROXY_TYPES.has(record.type)),
    settings: desired.settings.map(({ id }) => ({ id, value: snapshot.settings[id] })),
    ssl: snapshot.settings.ssl,
    workersDev: {},
    turnstile: snapshot.widget ? { sitekey: snapshot.widget.sitekey, domains: snapshot.widget.domains } : null,
    notes: [],
  };
}

export function render(steps, { state, apply, only }) {
  const out = [
    apply ? "later.dog edge apply: writing the steps marked change, in this order" : "later.dog edge plan (dry run: nothing is written; add --apply to write)",
    `zone ${state.zone.name} ${state.zone.id}  account ${state.zone.accountId}`,
    "",
  ];
  steps.forEach((current, index) => {
    const skipped = only && !only.includes(current.id);
    out.push(`[${index + 1}/${steps.length}] ${current.id}: ${skipped ? "not selected" : current.status}  ${current.title}`);
    if (skipped) return;
    for (const line of current.lines) out.push(`  ${line}`);
    for (const note of current.notes) out.push(`  note: ${note}`);
    if (current.calls.length) out.push(current.status === "change" ? "  calls:" : "  calls once unblocked:");
    for (const call of current.calls) {
      out.push(`    ${call.method} ${call.path}`);
      if (call.body !== undefined) out.push(...JSON.stringify(call.body, null, 2).split("\n").map((line) => `      ${line}`));
    }
    out.push("");
  });
  const counts = steps.filter((current) => !only || only.includes(current.id)).reduce((total, current) => ({ ...total, [current.status]: (total[current.status] ?? 0) + 1 }), {});
  out.push(`summary: ${Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(", ")}`);
  return out.join("\n");
}

export async function execute(api, steps, { only, log }) {
  for (const current of steps) {
    if (current.status !== "change" || (only && !only.includes(current.id))) continue;
    for (const call of current.calls) {
      await api.request(call.method, call.path, { body: call.body });
      log(`done ${current.id}: ${call.method} ${call.path}`);
    }
  }
}

const BOOLEAN_FLAGS = new Set(["--apply", "--prune"]);

export function parseArgs(argv) {
  const options = { apply: false, prune: false };
  for (const argument of argv) {
    const [flag, value] = argument.split(/=(.*)/s, 2);
    if (BOOLEAN_FLAGS.has(flag) && value !== undefined) throw new Error(`${flag} takes no value; leave it out to skip it`);
    if (flag === "--apply") options.apply = true;
    else if (flag === "--prune") options.prune = true;
    else if (flag === "--only" && value) options.only = value.split(",").map((id) => id.trim()).filter(Boolean);
    else if (flag === "--replay" && value) options.replay = value;
    else if (flag === "--save-state" && value) options.saveState = value;
    else if (flag === "--rollback" && value) options.rollback = value;
    else throw new Error(`unknown argument ${argument}`);
  }
  const unknown = (options.only ?? []).filter((id) => !STEP_ORDER.includes(id));
  if (unknown.length) throw new Error(`unknown step ${unknown.join(", ")}; steps are ${STEP_ORDER.join(", ")}`);
  if (options.apply && options.replay) throw new Error("--replay is read-only and cannot be combined with --apply");
  return options;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export async function main(argv, { env = process.env, fetchImpl = fetch, write = (text) => process.stdout.write(`${text}\n`), origin = checkOrigin, now = () => new Date(), snapshotDir = join(homedir(), ".laterdog", "edge-snapshots") } = {}) {
  const token = env[TOKEN_VARIABLE]?.trim();
  const say = (text) => write(token ? String(text).replaceAll(token, "[token]") : String(text));
  try {
    const options = parseArgs(argv);
    let api;
    if (options.replay) api = createReplayApi(JSON.parse(readFileSync(options.replay, "utf8")));
    else if (token) api = createApi({ token, fetchImpl });
    else throw new Error(`set ${TOKEN_VARIABLE} to a Cloudflare API token (read scopes for a dry run, edit scopes for --apply); it is read from the environment and never printed`);
    const configured = loadDesired(EDGE_DIR, env);
    const state = await readState(api, configured);
    const desired = options.rollback ? rollbackDesired(configured, JSON.parse(readFileSync(options.rollback, "utf8"))) : configured;
    const includeDns = !options.only || options.only.includes("dns");
    const prune = options.prune || Boolean(options.rollback);
    const targets = desired.ssl === "strict" ? originTargets(desired, effectiveRecords(desired, state, includeDns, { prune }), state.customDomains) : [];
    const origins = await Promise.all(targets.map(async (record) => ({ name: record.name, content: record.content, ...(await origin(record)) })));
    const steps = plan(desired, state, { origins, prune });
    say(render(steps, { state, apply: options.apply, only: options.only }));
    if (options.saveState) writeJson(options.saveState, state);
    if (!options.apply) return 0;
    const snapshot = join(snapshotDir, `${now().toISOString().replaceAll(":", "-")}.json`);
    writeJson(snapshot, state);
    say(`saved the state before this apply to ${snapshot}; roll back with --rollback=${snapshot} --apply`);
    await execute(api, steps, { only: options.only, log: say });
    say("applied. Run the dry run again: every applied step should now read ok.");
    return 0;
  } catch (error) {
    if (error instanceof NotRecorded) say(`not recorded in the replay: ${error.message}`);
    else say(`edge-apply stopped: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
