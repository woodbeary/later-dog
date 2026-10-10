import { afterEach, describe, expect, it, vi } from "vitest";
import { MINUTE } from "../src/idle";
import {
  DAY,
  SITEVERIFY_URL,
  TRIAL_CLAIM,
  TRIAL_TOKEN,
  allowedCountry,
  networkDigest,
  networkOf,
  parseTrialForm,
  trialListing,
  trialOffer,
  trialPolicy,
  trialView,
  turnstileVerdict,
  verifyTurnstile,
} from "../src/trial";
import { TURNSTILE_ORIGIN, trialPage, trialPageHeaders } from "../src/trial-page";

const READY = { TRIALS_ENABLED: "true", TURNSTILE_SITE_KEY: "site-key", TURNSTILE_SECRET_KEY: "secret-key", TRIAL_NETWORK_KEY: "network-key" };
const CLAIM = "07a573c35d0ffb69d891350234f1403ebda155093f0d86233c28b75c57767378";
const T0 = 1_800_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trialPolicy", () => {
  it("is off by default, with 30 minutes over 7 days, 20 trials a day and 5 idle minutes", () => {
    expect(trialPolicy({})).toEqual({ enabled: false, siteKey: "", limitMs: 30 * MINUTE, windowMs: 7 * DAY, perDay: 20, idleSleepMs: 5 * MINUTE, countries: [] });
  });

  it("turns on only when switched on with every key set", () => {
    expect(trialPolicy(READY).enabled).toBe(true);
    expect(trialPolicy({ ...READY, TRIALS_ENABLED: " true " }).enabled).toBe(true);
    for (const off of [
      { ...READY, TRIALS_ENABLED: "false" },
      { ...READY, TRIALS_ENABLED: "TRUE" },
      { ...READY, TRIALS_ENABLED: "1" },
      { ...READY, TRIALS_ENABLED: undefined },
      { ...READY, TURNSTILE_SITE_KEY: " " },
      { ...READY, TURNSTILE_SECRET_KEY: "" },
      { ...READY, TRIAL_NETWORK_KEY: undefined },
      { ...READY, TRIALS_PER_DAY: "0" },
    ]) {
      expect(trialPolicy(off).enabled, JSON.stringify(off)).toBe(false);
    }
  });

  it("keeps the numbers in bounds", () => {
    const least = trialPolicy({ TRIAL_MINUTES: "1", TRIAL_DAYS: "0", TRIALS_PER_DAY: "-5", TRIAL_IDLE_SLEEP_MINUTES: "0" });
    expect([least.limitMs, least.windowMs, least.perDay, least.idleSleepMs]).toEqual([5 * MINUTE, DAY, 0, MINUTE]);
    const most = trialPolicy({ TRIAL_MINUTES: "100000", TRIAL_DAYS: "1000", TRIALS_PER_DAY: "99999", TRIAL_IDLE_SLEEP_MINUTES: "500" });
    expect([most.limitMs, most.windowMs, most.perDay, most.idleSleepMs]).toEqual([600 * MINUTE, 90 * DAY, 10_000, 60 * MINUTE]);
    const odd = trialPolicy({ TRIAL_MINUTES: "7.4", TRIAL_DAYS: "soon", TRIALS_PER_DAY: "2.9", TRIAL_IDLE_SLEEP_MINUTES: " " });
    expect([odd.limitMs, odd.windowMs, odd.perDay, odd.idleSleepMs]).toEqual([7 * MINUTE, 7 * DAY, 2, 5 * MINUTE]);
  });

  it("reads the country list as two-letter codes", () => {
    expect(trialPolicy({ TRIAL_COUNTRIES: " us, CA,ca ,x,USA,,1a" }).countries).toEqual(["US", "CA"]);
  });

  it("trims the site key it hands the page", () => {
    expect(trialPolicy({ ...READY, TURNSTILE_SITE_KEY: " site-key\n" }).siteKey).toBe("site-key");
  });
});

describe("trialOffer", () => {
  it("says whether a trial is offered and how long it is", () => {
    expect(trialOffer(trialPolicy(READY))).toEqual({ offered: true, minutes: 30, days: 7 });
    expect(trialOffer(trialPolicy({ TRIAL_MINUTES: "45", TRIAL_DAYS: "3" }))).toEqual({ offered: false, minutes: 45, days: 3 });
  });
});

describe("trialView", () => {
  const trial = { id: "trl_aaaaaaaaaaaaaaaa", createdAt: T0, expiresAt: T0 + 7 * DAY, limitMs: 30 * MINUTE, usedMs: 0 };

  it("counts whole minutes left", () => {
    expect(trialView(trial)).toEqual({ state: "active", minutes: 30, minutesLeft: 30, expiresAt: new Date(T0 + 7 * DAY).toISOString() });
    expect(trialView({ ...trial, usedMs: 10 * MINUTE + 1 })).toMatchObject({ state: "active", minutesLeft: 19 });
    expect(trialView({ ...trial, usedMs: 29 * MINUTE })).toMatchObject({ state: "active", minutesLeft: 1 });
  });

  it("is used up once less than a minute is left", () => {
    expect(trialView({ ...trial, usedMs: 29 * MINUTE + 1 })).toMatchObject({ state: "used_up", minutesLeft: 0 });
    expect(trialView({ ...trial, usedMs: 45 * MINUTE })).toMatchObject({ state: "used_up", minutesLeft: 0 });
  });
});

describe("allowedCountry", () => {
  it("allows everyone when no countries are listed", () => {
    const policy = trialPolicy({});
    expect(allowedCountry(policy, "US")).toBe(true);
    expect(allowedCountry(policy, undefined)).toBe(true);
  });

  it("allows only the listed countries otherwise", () => {
    const policy = trialPolicy({ TRIAL_COUNTRIES: "US,CA" });
    expect(allowedCountry(policy, "us")).toBe(true);
    expect(allowedCountry(policy, "CA")).toBe(true);
    expect(allowedCountry(policy, "FR")).toBe(false);
    expect(allowedCountry(policy, undefined)).toBe(false);
  });
});

describe("parseTrialForm", () => {
  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

  it("reads the claim and the check's token", () => {
    expect(parseTrialForm(form({ claim: CLAIM, "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX" }))).toEqual({ ok: true, claim: CLAIM, token: "XXXX.DUMMY.TOKEN.XXXX" });
    expect(parseTrialForm(form({ claim: CLAIM, "cf-turnstile-response": "t".repeat(2048) })).ok).toBe(true);
  });

  it("refuses a missing or malformed claim before looking at the token", () => {
    for (const claim of ["", CLAIM.slice(1), CLAIM.toUpperCase(), `${CLAIM}0`, CLAIM.replace(/^./, "g")]) {
      expect(parseTrialForm(form({ claim, "cf-turnstile-response": "token" })), claim).toEqual({ ok: false, problem: "claim" });
    }
    expect(parseTrialForm("")).toEqual({ ok: false, problem: "claim" });
  });

  it("refuses a missing, empty or oversized token", () => {
    expect(parseTrialForm(form({ claim: CLAIM }))).toEqual({ ok: false, problem: "check" });
    expect(parseTrialForm(form({ claim: CLAIM, "cf-turnstile-response": "" }))).toEqual({ ok: false, problem: "check" });
    expect(parseTrialForm(form({ claim: CLAIM, "cf-turnstile-response": "t".repeat(2049) }))).toEqual({ ok: false, problem: "check" });
  });
});

describe("networkOf", () => {
  it("keeps a whole IPv4 address", () => {
    expect(networkOf("203.0.113.7")).toBe("4:203.0.113.7");
    expect(networkOf(" 198.51.100.255 ")).toBe("4:198.51.100.255");
  });

  it("keeps the /64 of an IPv6 address, however it is written", () => {
    expect(networkOf("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("6:2001:db8:85a3:8d3::/64");
    expect(networkOf("2001:0DB8:85A3:08D3::1")).toBe("6:2001:db8:85a3:8d3::/64");
    expect(networkOf("2001:db8::")).toBe("6:2001:db8:0:0::/64");
    expect(networkOf("::1")).toBe("6:0:0:0:0::/64");
    expect(networkOf("1:2:3:4:5:6:7::")).toBe("6:1:2:3:4::/64");
    expect(networkOf("64:ff9b::192.0.2.33")).toBe("6:64:ff9b:0:0::/64");
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(networkOf("::ffff:198.51.100.4")).toBe("4:198.51.100.4");
    expect(networkOf("::FFFF:c633:6404")).toBe("4:198.51.100.4");
    expect(networkOf("0:0:0:0:0:ffff:203.0.113.7")).toBe("4:203.0.113.7");
  });

  it("refuses anything else", () => {
    for (const raw of [
      null,
      undefined,
      "",
      "unknown",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "1.2.3.-4",
      "1::2::3",
      ":::",
      "12345::",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7::8",
      "2001:db8::1%en0",
      "::1.2.3.4:5",
      "::ffff:300.1.1.1",
    ]) {
      expect(networkOf(raw), String(raw)).toBeUndefined();
    }
  });
});

describe("networkDigest", () => {
  it("is the HMAC-SHA256 of the network under the key", async () => {
    expect(await networkDigest("key-one", "4:203.0.113.7")).toBe("e02354eb76d4b88f44467ff7d7c4dbb00cdbbbaa1c9659e5c8878e261e77448a");
  });

  it("changes with the key and with the network", async () => {
    const digest = await networkDigest("key-one", "4:203.0.113.7");
    expect(await networkDigest("key-two", "4:203.0.113.7")).not.toBe(digest);
    expect(await networkDigest("key-one", "4:203.0.113.8")).not.toBe(digest);
  });
});

describe("turnstileVerdict", () => {
  const expected = { hostname: "computers.example", cdata: CLAIM };
  const passed = { success: true, hostname: "computers.example", action: "trial", cdata: CLAIM, "error-codes": [] };

  it("passes only a successful check for this host, this action and this claim", () => {
    expect(turnstileVerdict(passed, expected)).toBe(true);
    for (const outcome of [
      { ...passed, success: false },
      { ...passed, success: "true" },
      { ...passed, hostname: "elsewhere.example" },
      { ...passed, action: "login" },
      { ...passed, cdata: "0".repeat(64) },
      { success: true },
      null,
      "success",
      [passed],
    ]) {
      expect(turnstileVerdict(outcome, expected), JSON.stringify(outcome)).toBe(false);
    }
  });
});

describe("verifyTurnstile", () => {
  const input = { secret: "secret-key", token: "XXXX.DUMMY.TOKEN.XXXX", ip: "203.0.113.7", hostname: "computers.example", cdata: CLAIM };
  const siteverify = (answer: Response | Error) => {
    const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    });
    vi.stubGlobal("fetch", fetcher);
    return fetcher;
  };

  it("posts the secret, the token and the visitor's address to siteverify", async () => {
    const fetcher = siteverify(Response.json({ success: true, hostname: "computers.example", action: "trial", cdata: CLAIM }));
    expect(await verifyTurnstile(input)).toBe("passed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(SITEVERIFY_URL);
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({ secret: "secret-key", response: "XXXX.DUMMY.TOKEN.XXXX", remoteip: "203.0.113.7" });
  });

  it("leaves the address out when there is none", async () => {
    const fetcher = siteverify(Response.json({ success: true, hostname: "computers.example", action: "trial", cdata: CLAIM }));
    expect(await verifyTurnstile({ secret: input.secret, token: input.token, hostname: input.hostname, cdata: input.cdata })).toBe("passed");
    expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]?.body)).has("remoteip")).toBe(false);
  });

  it("fails a check that did not pass or was made for something else", async () => {
    siteverify(Response.json({ success: false, "error-codes": ["invalid-input-response"] }));
    expect(await verifyTurnstile(input)).toBe("failed");
    siteverify(Response.json({ success: true, hostname: "computers.example", action: "trial", cdata: "0".repeat(64) }));
    expect(await verifyTurnstile(input)).toBe("failed");
  });

  it("is unavailable when siteverify errors, cannot be reached or answers garbage", async () => {
    siteverify(new Response("busy", { status: 500 }));
    expect(await verifyTurnstile(input)).toBe("unavailable");
    siteverify(new Error("network down"));
    expect(await verifyTurnstile(input)).toBe("unavailable");
    siteverify(new Response("not json"));
    expect(await verifyTurnstile(input)).toBe("unavailable");
  });
});

describe("trial keys", () => {
  it("recognises trial keys and claims", () => {
    expect(TRIAL_TOKEN.test(`ldt_${"A".repeat(43)}`)).toBe(true);
    expect(TRIAL_TOKEN.test(`ldt_${"aZ09-_".repeat(7)}a`)).toBe(true);
    for (const bad of [`ldc_${"A".repeat(43)}`, `ldt_${"A".repeat(42)}`, `ldt_${"A".repeat(44)}`, `ldt_${"A".repeat(42)}+`, `ldt_${"A".repeat(42)}=`, ` ldt_${"A".repeat(43)}`]) {
      expect(TRIAL_TOKEN.test(bad), bad).toBe(false);
    }
    expect(TRIAL_CLAIM.test(CLAIM)).toBe(true);
    expect(TRIAL_CLAIM.test(CLAIM.toUpperCase())).toBe(false);
  });

  it("lists each trial's computers under the trial's own name", () => {
    expect(trialListing("trl_aaaaaaaaaaaaaaaa")).toBe("trial:trl_aaaaaaaaaaaaaaaa");
  });
});

describe("the trial page", () => {
  it("carries the claim, the site key and the offer", () => {
    const html = trialPage({ claim: CLAIM, siteKey: "1x00000000000000000000AA", minutes: 30, days: 7, nonce: "n0nce" });
    expect(html).toContain(`<input type="hidden" name="claim" value="${CLAIM}">`);
    expect(html).toContain(`data-sitekey="1x00000000000000000000AA" data-action="trial" data-cdata="${CLAIM}"`);
    expect(html).toContain("30 minutes of use within 7 days. No card needed. One free trial per network.");
    expect(html).toContain('<form method="post" action="/trial">');
    expect(html).toContain('<button type="submit" id="start" disabled>Start free trial</button>');
    expect(html).toContain(`<script nonce="n0nce" src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js" async defer></script>`);
    expect(html.match(/<(script|style)(?![^>]*nonce="n0nce")[\s>]/g)).toBeNull();
  });

  it("escapes what it is given", () => {
    const html = trialPage({ claim: CLAIM, siteKey: '"><script>alert(1)</script>', minutes: 30, days: 7, nonce: "n0nce" });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&#34;&#62;&#60;script&#62;alert(1)");
  });

  it("allows only Turnstile and the page's own nonce, and keeps the origin on the form post", () => {
    const headers = trialPageHeaders("n0nce");
    expect(headers["referrer-policy"]).toBe("strict-origin");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]!.split("; ")).toEqual([
      "default-src 'none'",
      `script-src 'nonce-n0nce' ${TURNSTILE_ORIGIN}`,
      "style-src 'nonce-n0nce'",
      `frame-src ${TURNSTILE_ORIGIN}`,
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ]);
  });
});
