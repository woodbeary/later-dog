import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EDGE_DIR,
  STEP_ORDER,
  byokOnly,
  createReplayApi,
  effectiveRecords,
  loadDesired,
  main,
  matches,
  parseArgs,
  plan,
  readState,
  requestKey,
  rollbackDesired,
  validateRateLimits,
} from "./edge-apply.mjs";

const ZONE = "z0000000000000000000000000000000";
const ACCOUNT = "a0000000000000000000000000000000";
const TOKEN = "cf-test-token-never-printed-7d1e";
const MANAGED_RULESET = "efb7b8c949ac4650a09736fc376e9aee";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

type Entry = { result?: unknown; result_info?: unknown; error?: { status: number; errors: { code: number; message: string }[] } };

function liveLike(): Record<string, Entry> {
  const z = `/zones/${ZONE}`;
  const a = `/accounts/${ACCOUNT}`;
  const missing = (code: number) => ({ error: { status: 404, errors: [{ code, message: "not found" }] } });
  return {
    "GET /zones?name=later.dog": { result: [{ id: ZONE, name: "later.dog", account: { id: ACCOUNT } }] },
    [`GET ${z}/rulesets/phases/http_ratelimit/entrypoint`]: missing(10003),
    [`GET ${z}/rulesets/phases/http_request_firewall_managed/entrypoint`]: missing(10003),
    [`GET ${z}/settings/always_use_https`]: { result: { value: "off" } },
    [`GET ${z}/settings/min_tls_version`]: { result: { value: "1.0" } },
    [`GET ${z}/settings/security_header`]: { result: { value: { strict_transport_security: { enabled: false, max_age: 0, include_subdomains: false, preload: false, nosniff: false } } } },
    [`GET ${z}/settings/brotli`]: { result: { value: "off" } },
    [`GET ${z}/settings/http3`]: { result: { value: "off" } },
    [`GET ${z}/settings/ssl`]: { result: { value: "full" } },
    [`GET ${a}/ai-gateway/gateways/laterdog`]: missing(7002),
    [`GET ${a}/workers/scripts/laterdog-computers/subdomain`]: { result: { enabled: true, previews_enabled: true } },
    [`GET ${a}/workers/scripts/laterdog-supervisor/subdomain`]: { result: { enabled: true, previews_enabled: true } },
    [`GET ${a}/challenges/widgets`]: { result: [{ sitekey: "0x4AAAAAAFToUIA2DvjWJrmf", name: "later.dog trial", domains: ["later.dog", "laterdog-computers.example.workers.dev"], mode: "managed", secret: TOKEN }] },
    [`GET ${z}/bot_management`]: { result: { sbfm_definitely_automated: "allow", sbfm_likely_automated: "allow", sbfm_verified_bots: "allow", enable_js: false, ai_bots_protection: "disabled" } },
    [`GET ${z}/dns_records?page=1&per_page=100`]: {
      result: [
        { id: "apex", type: "A", name: "later.dog", content: "162.255.119.236", proxied: true, ttl: 1, comment: null },
        { id: "www", type: "CNAME", name: "www.later.dog", content: "parkingpage.namecheap.com", proxied: true, ttl: 1, comment: null },
        { id: "mx", type: "MX", name: "later.dog", content: "eforward1.registrar-servers.com", proxied: false, ttl: 1, comment: null },
      ],
      result_info: { total_pages: 2 },
    },
    [`GET ${z}/dns_records?page=2&per_page=100`]: {
      result: [{ id: "cloud", type: "AAAA", name: "cloud.later.dog", content: "100::", proxied: true, ttl: 1, comment: null }],
      result_info: { total_pages: 2 },
    },
    [`GET ${a}/workers/domains?zone_id=${ZONE}`]: { result: [{ hostname: "cloud.later.dog" }] },
  };
}

function fakeFetch(recording: Record<string, Entry>, writes: string[], { failOn }: { failOn?: string } = {}) {
  return async (input: URL | string, init: { method: string; body?: string; headers: Record<string, string> }) => {
    const url = new URL(input);
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const path = url.pathname.replace("/client/v4", "");
    const query = Object.fromEntries(url.searchParams);
    if (init.method !== "GET") {
      writes.push(`${init.method} ${path}`);
      if (failOn && path.endsWith(failOn)) return Response.json({ success: false, errors: [{ code: 1000, message: `bad request carrying ${TOKEN}` }] }, { status: 400 });
      return Response.json({ success: true, result: {} });
    }
    const entry = recording[requestKey("GET", path, query)];
    if (!entry) return Response.json({ success: false, errors: [{ code: 9999, message: `unrecorded ${path}` }] }, { status: 500 });
    if (entry.error) return Response.json({ success: false, errors: entry.error.errors }, { status: entry.error.status });
    return Response.json({ success: true, result: entry.result, result_info: entry.result_info });
  };
}

async function liveState(env: Record<string, string> = {}) {
  const desired = loadDesired(EDGE_DIR, env);
  return { desired, state: await readState(createReplayApi(liveLike()), desired) };
}

function appliedState(desired: ReturnType<typeof loadDesired>, state: Awaited<ReturnType<typeof readState>>) {
  const [ratePhase, managedPhase] = Object.keys(desired.rulesets);
  return {
    ...state,
    rulesets: {
      [ratePhase]: desired.rulesets[ratePhase].map((rule: object, index: number) => ({ id: `r${index}`, version: "1", ...rule })),
      [managedPhase]: desired.rulesets[managedPhase].map((rule: object, index: number) => ({ id: `m${index}`, version: "1", ...rule, categories: [] })),
    },
    settings: { ...Object.fromEntries(desired.settings.map((setting: { id: string; value: unknown }) => [setting.id, setting.value])), ssl: desired.ssl },
    dns: [...state.dns.filter((record: { type: string }) => record.type === "MX" || record.type === "AAAA"), ...desired.dns.map((record: object, index: number) => ({ id: ["apex", "www"][index], ...record }))],
    gateway: { id: "laterdog", ...desired.gateway.settings, byok_only: false, spend_limits: desired.gateway.spendLimits, log_management: 10000000 },
    subdomains: { "laterdog-computers": { enabled: false, previews_enabled: false }, "laterdog-supervisor": { enabled: true, previews_enabled: false } },
    widget: { ...state.widget, domains: ["later.dog"] },
  };
}

type Request = { host: string; method: string; path: string };

function ruleMatches(expression: string, request: Request): boolean {
  const tokens = expression.match(/"[^"]*"|[(){},]|[A-Za-z_][\w.]*/g) ?? [];
  let at = 0;
  const next = () => tokens[at++];
  const expect_ = (token: string) => {
    if (next() !== token) throw new Error(`expected ${token} in ${expression}`);
  };
  const text = () => {
    const token = next();
    if (!token?.startsWith('"')) throw new Error(`expected a string in ${expression}`);
    return token.slice(1, -1);
  };
  const fields: Record<string, string> = { "http.host": request.host, "http.request.method": request.method, "http.request.uri.path": request.path };
  const field = () => {
    const name = next();
    if (!(name in fields)) throw new Error(`unknown field ${name}`);
    return fields[name];
  };
  const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
  const primary = (): boolean => {
    const token = tokens[at];
    if (token === "(") {
      next();
      const value = either();
      expect_(")");
      return value;
    }
    if (token === "not") {
      next();
      return !primary();
    }
    if (token === "starts_with") {
      next();
      expect_("(");
      const value = field();
      expect_(",");
      const prefix = text();
      expect_(")");
      return value.startsWith(prefix);
    }
    const value = field();
    const operator = next();
    if (operator === "eq") return value === text();
    if (operator === "wildcard") return glob(text()).test(value);
    if (operator === "in") {
      expect_("{");
      const set: string[] = [];
      while (tokens[at] !== "}") set.push(text());
      next();
      return set.includes(value);
    }
    throw new Error(`unknown operator ${operator}`);
  };
  const both = (): boolean => {
    let value = primary();
    while (tokens[at] === "and") {
      next();
      value = primary() && value;
    }
    return value;
  };
  const either = (): boolean => {
    let value = both();
    while (tokens[at] === "or") {
      next();
      value = both() || value;
    }
    return value;
  };
  const value = either();
  if (at !== tokens.length) throw new Error(`unparsed ${tokens.slice(at).join(" ")} in ${expression}`);
  return value;
}

const byId = (steps: { id: string }[], id: string) => steps.find((step) => step.id === id) as { status: string; lines: string[]; calls: { method: string; path: string; body?: any }[]; notes: string[] };

describe("the edge files", () => {
  it("hold R1-R5 within the zone's entitlement and every rule counts per IP and data centre", () => {
    const file = JSON.parse(readFileSync(join(EDGE_DIR, "rate-limits.json"), "utf8"));
    expect(validateRateLimits(file)).toEqual([]);
    expect(file.rules.map((rule: { ref: string }) => rule.ref)).toEqual(["r1-otp-send", "r2-otp-sign-in", "r3-trial-start", "r4-cloud-api", "r5-homes"]);
    expect(validateRateLimits({ ...file, rules: [...file.rules, { ...file.rules[0], ref: "r6" }] })).toContain("6 rules, the zone allows 5");
    expect(validateRateLimits({ ...file, rules: [{ ...file.rules[0], ratelimit: { ...file.rules[0].ratelimit, period: 120, characteristics: ["ip.src"] } }] })).toEqual([
      "r1-otp-send: period 120 is not one of 10, 60, 600",
      "r1-otp-send: characteristics need cf.colo.id",
    ]);
  });

  it("match the sign-in and trial paths the Workers really serve", () => {
    const auth = readFileSync(new URL("../cloudflare/control-plane/src/auth.ts", import.meta.url), "utf8");
    const routes = readFileSync(new URL("../deploy/laterdog/computers/src/routes.ts", import.meta.url), "utf8");
    const [r1, r2, r3] = loadDesired(EDGE_DIR, {}).rulesets.http_ratelimit;
    const basePath = auth.match(/basePath: "([^"]+)"/)?.[1];
    expect(basePath).toBe("/api/auth");
    for (const [rule, path] of [[r1, "/email-otp/send-verification-otp"], [r2, "/sign-in/email-otp"]] as const) {
      expect(auth).toContain(`"${path}"`);
      expect(rule.expression).toContain(`"${basePath}${path}"`);
    }
    for (const path of ["/v1/trials/start", "/trial"]) {
      expect(routes).toContain(`pathname === "${path}"`);
      expect(r3.expression).toContain(`"${path}"`);
    }
  });

  it("send every Better Auth route that emails a code through R1", () => {
    const [r1] = loadDesired(EDGE_DIR, {}).rulesets.http_ratelimit;
    for (const path of ["/api/auth/email-otp/send-verification-otp", "/api/auth/email-otp/request-password-reset", "/api/auth/forget-password/email-otp"]) {
      expect(ruleMatches(r1.expression, { host: "accounts.later.dog", method: "POST", path })).toBe(true);
    }
    expect(ruleMatches(r1.expression, { host: "accounts.later.dog", method: "POST", path: "/api/auth/sign-in/email-otp" })).toBe(false);
  });

  it("leave the routes Cloud homes call from shared egress out of the per-address R4", () => {
    const rules = loadDesired(EDGE_DIR, {}).rulesets.http_ratelimit;
    const r4 = rules.find((rule: { ref: string }) => rule.ref === "r4-cloud-api");
    const r5 = rules.find((rule: { ref: string }) => rule.ref === "r5-homes");
    expect(r4.action).toBe("block");
    const routes = readFileSync(new URL("../deploy/laterdog/computers/src/routes.ts", import.meta.url), "utf8");
    const home = readFileSync(new URL("../deploy/laterdog/home/wrangler.jsonc", import.meta.url), "utf8");
    const includedAi = readFileSync(new URL("../server/laterdog/included-ai.ts", import.meta.url), "utf8");
    const jev = readFileSync(new URL("../server/decider/jev.ts", import.meta.url), "utf8");
    expect(home).toContain('"INCLUDED_API": "https://cloud.later.dog/v1"');
    expect(includedAi).toContain('"https://cloud.later.dog/v1/ai"');
    expect(jev).toContain("/v1/systemone");
    expect(routes).toContain("/^\\/v1\\/voice\\/text-to-speech\\/");
    const included = ["/v1/ai/chat/completions", "/v1/complete", "/v1/systemone", "/v1/voice/speech-to-text", "/v1/voice/voices"];
    for (const path of included) expect(routes).toContain(`pathname === "${path}"`);
    for (const path of [...included, "/v1/voice/text-to-speech/abc123"]) {
      expect(ruleMatches(r4.expression, { host: "cloud.later.dog", method: "POST", path }), path).toBe(false);
    }
    const computers = readFileSync(new URL("../server/laterdog/cloud-computers.ts", import.meta.url), "utf8");
    for (const call of ['this.#send("/computers"', "/computers/${computerPath(id)}/exec", "/computers/${computerPath(id)}/screenshot", 'this.#send("/trial"', 'this.#send("/plan"']) {
      expect(computers).toContain(call);
    }
    expect(routes).toContain("const API_PATH = /^\\/v1\\/computers(?:\\/");
    for (const path of ["/v1/trial", "/v1/plan"]) expect(routes).toContain(`pathname === "${path}"`);
    const homeKeyed = ["/v1/computers", "/v1/computers/c_123", "/v1/computers/c_123/exec", "/v1/computers/c_123/screenshot", "/v1/computers/c_123/files", "/v1/computers/c_123/wake", "/v1/trial", "/v1/plan"];
    for (const path of homeKeyed) {
      for (const method of ["GET", "POST"]) {
        expect(ruleMatches(r4.expression, { host: "cloud.later.dog", method, path }), `${method} ${path}`).toBe(false);
      }
    }
    for (const path of ["/mcp", "/trial", "/v1/trials", "/v1/trials/start", "/v1/plan/checkout", "/plan/done", "/desktop/a/b", "/v1/nope"]) {
      expect(ruleMatches(r4.expression, { host: "cloud.later.dog", method: "POST", path }), path).toBe(true);
    }
    expect(ruleMatches(r4.expression, { host: "accounts.later.dog", method: "POST", path: "/mcp" })).toBe(false);
    expect(ruleMatches(r5.expression, { host: "jacob-home.later.dog", method: "GET", path: "/" })).toBe(true);
    expect(ruleMatches(r5.expression, { host: "cloud.later.dog", method: "GET", path: "/" })).toBe(false);
  });

  it("run the Cloudflare Managed Ruleset blocking on the site and only logging on the app hosts", () => {
    const [site, apps] = loadDesired(EDGE_DIR, {}).rulesets.http_request_firewall_managed;
    expect(site.action_parameters).toEqual({ id: MANAGED_RULESET });
    expect(site.expression).not.toContain("cloud.later.dog");
    expect(apps.action_parameters).toEqual({ id: MANAGED_RULESET, overrides: { action: "log" } });
    expect(apps.expression).toContain("accounts.later.dog");
    expect(apps.expression).toContain("*-home.later.dog");
  });

  it("keep the ElevenLabs spend rule out until its dollar amount is set, and refuse nonsense", () => {
    const rules = (env: Record<string, string>) => loadDesired(EDGE_DIR, env).gateway.spendLimits.rules.map((rule: { id: string; limit: number }) => [rule.id, rule.limit]);
    expect(rules({})).toEqual([["grok-daily", 40], ["anthropic-daily", 16], ["all-daily", 250]]);
    expect(rules({ LATERDOG_EDGE_ELEVENLABS_USD_PER_DAY: "12.5" })).toEqual([["grok-daily", 40], ["anthropic-daily", 16], ["elevenlabs-daily", 12.5], ["all-daily", 250]]);
    expect(() => loadDesired(EDGE_DIR, { LATERDOG_EDGE_ELEVENLABS_USD_PER_DAY: "lots" })).toThrow("positive number");
  });
});

describe("planning against the zone", () => {
  it("reads the state without secrets and plans every step in order", async () => {
    const { desired, state } = await liveState();
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(state.dns.map((record: { id: string }) => record.id)).toEqual(["apex", "www", "mx", "cloud"]);
    const steps = plan(desired, state, { origins: [] });
    expect(steps.map((step: { id: string }) => step.id)).toEqual(STEP_ORDER);
    expect(Object.fromEntries(steps.map((step: { id: string; status: string }) => [step.id, step.status]))).toEqual({
      "rate-limits": "change",
      "managed-rules": "change",
      bots: "ok",
      "ai-gateway": "change",
      dns: "change",
      "zone-settings": "change",
      "ssl-strict": "change",
      "workers-dev": "report",
      turnstile: "waiting",
    });
    expect(byId(steps, "rate-limits").calls).toEqual([{ method: "PUT", path: `/zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`, body: { rules: desired.rulesets.http_ratelimit } }]);
    expect(byId(steps, "ai-gateway").calls[0]).toMatchObject({ method: "POST", path: `/accounts/${ACCOUNT}/ai-gateway/gateways`, body: { id: "laterdog", byok_only: false, cache_ttl: 0, rate_limiting_interval: null } });
    expect(byId(steps, "dns").calls.map((call) => `${call.method} ${call.path} ${call.body?.type}`)).toEqual([`PUT /zones/${ZONE}/dns_records/apex AAAA`, `PUT /zones/${ZONE}/dns_records/www AAAA`]);
    expect(byId(steps, "zone-settings").calls.map((call) => call.path.split("/").pop())).toEqual(["always_use_https", "min_tls_version", "security_header", "brotli", "http3"]);
    expect(byId(steps, "workers-dev").calls).toEqual([]);
  });

  it("reads ok everywhere once the zone matches the files", async () => {
    const { desired, state } = await liveState();
    const steps = plan(desired, appliedState(desired, state), { origins: [] });
    expect(steps.filter((step: { status: string }) => step.status !== "ok").map((step: { id: string }) => step.id)).toEqual([]);
  });

  it("refuses to drop rules someone added in the dashboard unless told to prune", async () => {
    const { desired, state } = await liveState();
    const applied = appliedState(desired, state);
    const stray = { id: "x", ref: "hand-made", description: "added by hand", expression: "true", action: "block" };
    const crowded = { ...applied, rulesets: { ...applied.rulesets, http_ratelimit: [...applied.rulesets.http_ratelimit, stray] } };
    expect(byId(plan(desired, crowded), "rate-limits")).toMatchObject({ status: "blocked", lines: ["- hand-made  added by hand (not in code)"] });
    const pruned = byId(plan(desired, crowded, { prune: true }), "rate-limits");
    expect(pruned.status).toBe("change");
    expect(pruned.calls[0].body.rules.map((rule: { ref: string }) => rule.ref)).not.toContain("hand-made");
  });

  it("refuses to delete extra apex or www records unless told to prune", async () => {
    const { desired, state } = await liveState();
    const applied = appliedState(desired, state);
    const extra = { id: "extra", type: "CNAME", name: "www.later.dog", content: "elsewhere.example.com", proxied: true, ttl: 1, comment: null };
    const crowded = { ...applied, dns: [...applied.dns, extra] };
    expect(byId(plan(desired, crowded), "dns")).toMatchObject({ status: "blocked", lines: ["- www.later.dog CNAME elsewhere.example.com (proxied)"] });
    expect(byId(plan(desired, crowded, { prune: true }), "dns")).toMatchObject({ status: "change", calls: [{ method: "DELETE", path: `/zones/${ZONE}/dns_records/extra` }] });
    expect(effectiveRecords(desired, crowded, true)).toEqual(crowded.dns);
    expect(effectiveRecords(desired, crowded, true, { prune: true }).map((record: { name: string; content: string }) => `${record.name} ${record.content}`)).not.toContain("www.later.dog elsewhere.example.com");
  });

  it("holds Full (strict) back while a proxied origin has no valid certificate", async () => {
    const { desired, state } = await liveState();
    const failing = [{ name: "later.dog", content: "162.255.119.236", ok: false, reason: "ERR_TLS_CERT_ALTNAME_INVALID" }];
    expect(byId(plan(desired, state, { origins: failing }), "ssl-strict")).toMatchObject({ status: "blocked", calls: [] });
    const passing = [{ name: "later.dog", content: "203.0.113.9", ok: true }];
    expect(byId(plan(desired, state, { origins: passing }), "ssl-strict").calls).toEqual([{ method: "PATCH", path: `/zones/${ZONE}/settings/ssl`, body: { value: "strict" } }]);
  });

  it("turns byok_only on only when keys for every required provider are stored", async () => {
    const { desired, state } = await liveState();
    expect(byokOnly(desired.gateway, [])).toEqual({ on: false, missing: ["grok", "anthropic"] });
    expect(byokOnly(desired.gateway, ["xai"])).toEqual({ on: false, missing: ["anthropic"] });
    expect(byokOnly(desired.gateway, ["xai", "anthropic"])).toEqual({ on: true, missing: [] });
    const keyed = { ...appliedState(desired, state), providerKeys: ["grok", "anthropic"] };
    const gateway = byId(plan(desired, keyed), "ai-gateway");
    expect(gateway.lines).toEqual(["~ byok_only: false -> true"]);
    expect(gateway.calls[0]).toMatchObject({ method: "PUT", path: `/accounts/${ACCOUNT}/ai-gateway/gateways/laterdog`, body: { byok_only: true, log_management: 10000000 } });
  });

  it("drops the workers.dev host from Turnstile once the computers Worker's workers.dev is off", async () => {
    const { desired, state } = await liveState();
    const off = { ...state, subdomains: { ...state.subdomains, "laterdog-computers": { enabled: false, previews_enabled: false } } };
    const turnstile = byId(plan(desired, off), "turnstile");
    expect(turnstile.status).toBe("change");
    expect(turnstile.calls).toEqual([{ method: "PUT", path: `/accounts/${ACCOUNT}/challenges/widgets/0x4AAAAAAFToUIA2DvjWJrmf`, body: { name: "later.dog trial", domains: ["later.dog"], mode: "managed" } }]);
  });

  it("plans a rollback that puts back the rules, settings, records and widget it found", async () => {
    const { desired, state } = await liveState();
    const back = plan(rollbackDesired(desired, state), appliedState(desired, state), { origins: [] });
    expect(byId(back, "rate-limits").calls[0].body).toEqual({ rules: [] });
    expect(byId(back, "zone-settings").calls.map((call) => call.body.value)).toEqual(["off", "1.0", state.settings.security_header, "off", "off"]);
    expect(byId(back, "ssl-strict").calls[0].body).toEqual({ value: "full" });
    expect(byId(back, "dns").calls.map((call) => `${call.method} ${call.body?.type ?? ""} ${call.body?.content ?? ""}`.trim())).toEqual([
      "PUT A 162.255.119.236",
      "PUT CNAME parkingpage.namecheap.com",
    ]);
    expect(byId(back, "ai-gateway")).toMatchObject({ status: "report", calls: [] });
    expect(byId(back, "turnstile").calls[0].body.domains).toEqual(state.widget.domains);
  });

  it("compares lists of plain values regardless of order and treats a missing field as null", () => {
    expect(matches({ characteristics: ["ip.src", "cf.colo.id"] }, { characteristics: ["cf.colo.id", "ip.src"], extra: 1 })).toBe(true);
    expect(matches({ spend_limits: null }, {})).toBe(true);
    expect(matches({ rules: [{ id: "a" }] }, { rules: [] })).toBe(false);
  });
});

describe("running edge-apply", () => {
  function run(argv: string[], options: { failOn?: string } = {}) {
    const snapshotDir = mkdtempSync(join(tmpdir(), "laterdog-edge-"));
    directories.push(snapshotDir);
    const writes: string[] = [];
    const output: string[] = [];
    const exit = main(argv, {
      env: { CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl: fakeFetch(liveLike(), writes, options) as unknown as typeof fetch,
      write: (text: string) => output.push(text),
      origin: async () => ({ ok: true }),
      now: () => new Date("2026-10-19T12:00:00Z"),
      snapshotDir,
    });
    return exit.then((code: number) => ({ code, writes, text: output.join("\n"), snapshots: readdirSync(snapshotDir) }));
  }

  it("only reads without --apply", async () => {
    const result = await run([]);
    expect(result.code).toBe(0);
    expect(result.writes).toEqual([]);
    expect(result.snapshots).toEqual([]);
    expect(result.text).toContain("dry run: nothing is written");
    expect(result.text).toContain(`PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`);
    expect(result.text).not.toContain(TOKEN);
  });

  it("writes the selected steps in order after saving a snapshot to roll back to", async () => {
    const result = await run(["--apply", "--only=zone-settings,rate-limits"]);
    expect(result.code).toBe(0);
    expect(result.writes).toEqual([
      `PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`,
      ...["always_use_https", "min_tls_version", "security_header", "brotli", "http3"].map((id) => `PATCH /zones/${ZONE}/settings/${id}`),
    ]);
    expect(result.snapshots).toEqual(["2026-10-19T12-00-00.000Z.json"]);
    expect(result.text).toContain("--rollback=");
  });

  it("stops at the first refused call and never prints the token, even when an error echoes it", async () => {
    const result = await run(["--apply"], { failOn: "/rulesets/phases/http_request_firewall_managed/entrypoint" });
    expect(result.code).toBe(1);
    expect(result.writes).toEqual([`PUT /zones/${ZONE}/rulesets/phases/http_ratelimit/entrypoint`, `PUT /zones/${ZONE}/rulesets/phases/http_request_firewall_managed/entrypoint`]);
    expect(result.text).toContain("edge-apply stopped");
    expect(result.text).toContain("[token]");
    expect(result.text).not.toContain(TOKEN);
  });

  it("asks for a token instead of guessing one", async () => {
    const output: string[] = [];
    expect(await main([], { env: {}, write: (text: string) => output.push(text) })).toBe(1);
    expect(output.join("\n")).toContain("set CLOUDFLARE_API_TOKEN");
  });

  it("keeps a replay read-only and rejects unknown steps", async () => {
    expect(() => parseArgs(["--apply", "--replay=reads.json"])).toThrow("read-only");
    expect(() => parseArgs(["--only=dns,firewall"])).toThrow("unknown step firewall");
    expect(() => parseArgs(["--apply=false"])).toThrow("--apply takes no value");
    expect(() => parseArgs(["--prune="])).toThrow("--prune takes no value");
    expect(parseArgs(["--apply", "--prune"])).toMatchObject({ apply: true, prune: true });
    await expect(createReplayApi({}).request("PUT", "/zones/x", { body: {} })).rejects.toThrow("read-only");
  });
});
