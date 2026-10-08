import { describe, expect, it } from "vitest";
import { claudeUsageLimit, codexUsageLimit, limitKindFromWords, parseResetWords, rejectedRateLimit, resetInstant } from "./usage-limit.ts";

// Wednesday 7 October 2026, 11:30 AM in Los Angeles (PDT, UTC-7).
const NOW = Date.parse("2026-10-07T18:30:00Z");
const IN_TWO_HOURS = Math.floor(NOW / 1000) + 2 * 3600;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

/** The api-error frame Claude Code 2.1.x prints for a reached limit. */
const limitFrame = (text: string, info: Record<string, unknown> = { status: "rejected", rateLimitType: "five_hour", resetsAt: IN_TWO_HOURS }) => ({
  type: "assistant",
  message: { model: "<synthetic>", content: [{ type: "text", text }] },
  error: "rate_limit",
  is_api_error_message: true,
  api_error: "usage_limit_reached",
  api_error_params: { rate_limit_info: info },
});

describe("parseResetWords", () => {
  it("reads a reset later today in the zone it names", () => {
    expect(parseResetWords("You've hit your session limit · resets 3pm (America/Los_Angeles)", NOW)).toBe("2026-10-07T22:00:00.000Z");
    expect(parseResetWords("resets 11:45pm (Europe/London)", NOW)).toBe("2026-10-07T22:45:00.000Z");
    expect(parseResetWords("You've hit your session limit · resets 3pm (America/Los_Angeles) · progress saved", NOW)).toBe("2026-10-07T22:00:00.000Z");
  });

  it("moves a time already past to the next day", () => {
    expect(parseResetWords("resets 9am (America/Los_Angeles)", NOW)).toBe("2026-10-08T16:00:00.000Z");
  });

  it("reads a dated reset, across a daylight-saving change too", () => {
    expect(parseResetWords("You've hit your weekly limit · resets Oct 9, 5pm (America/Los_Angeles)", NOW)).toBe("2026-10-10T00:00:00.000Z");
    // US daylight saving ends on 1 November 2026: 9 AM on the 2nd is EST.
    expect(parseResetWords("resets Nov 2, 9am (America/New_York)", Date.parse("2026-10-31T20:00:00Z"))).toBe("2026-11-02T14:00:00.000Z");
    // a January date read in late December is next year's
    expect(parseResetWords("resets Jan 2, 5pm (UTC)", Date.parse("2026-12-30T12:00:00Z"))).toBe("2027-01-02T17:00:00.000Z");
  });

  it("falls back to this machine's zone for a missing or unknown one, and refuses what is not a time", () => {
    for (const words of ["resets 3pm", "resets 3pm (Mars/Olympus_Mons)"]) {
      const at = Date.parse(parseResetWords(words, NOW)!);
      expect(at).toBeGreaterThan(NOW);
      expect(at - NOW).toBeLessThanOrEqual(24 * 3600 * 1000);
    }
    expect(parseResetWords("resets 13pm (UTC)", NOW)).toBeUndefined();
    expect(parseResetWords("resets soon", NOW)).toBeUndefined();
    expect(parseResetWords("You've hit your session limit", NOW)).toBeUndefined();
  });
});

describe("resetInstant", () => {
  it("takes epoch seconds, milliseconds and ISO times, and only plausible resets", () => {
    expect(resetInstant(IN_TWO_HOURS, NOW)).toBe(iso(IN_TWO_HOURS));
    expect(resetInstant(IN_TWO_HOURS * 1000, NOW)).toBe(iso(IN_TWO_HOURS));
    expect(resetInstant(String(IN_TWO_HOURS), NOW)).toBe(iso(IN_TWO_HOURS));
    expect(resetInstant("2026-10-07T22:00:00Z", NOW)).toBe("2026-10-07T22:00:00.000Z");
    expect(resetInstant(Math.floor(NOW / 1000) - 3600, NOW)).toBeUndefined();
    expect(resetInstant(Math.floor(NOW / 1000) + 90 * 86400, NOW)).toBeUndefined();
    expect(resetInstant("not a time", NOW)).toBeUndefined();
    expect(resetInstant(undefined, NOW)).toBeUndefined();
  });
});

describe("rejectedRateLimit", () => {
  it("is only a rejection, read as the limit a person knows", () => {
    expect(rejectedRateLimit({ status: "allowed", resetsAt: IN_TWO_HOURS }, NOW)).toBeNull();
    expect(rejectedRateLimit({ status: "allowed_warning", rateLimitType: "seven_day" }, NOW)).toBeNull();
    expect(rejectedRateLimit(undefined, NOW)).toBeNull();
    expect(rejectedRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: IN_TWO_HOURS }, NOW))
      .toEqual({ resetsAt: iso(IN_TWO_HOURS), kind: "session" });
    expect(rejectedRateLimit({ status: "rejected", rateLimitType: "seven_day_opus" }, NOW)).toEqual({ kind: "opus" });
    expect(rejectedRateLimit({ status: "rejected", rateLimitType: "seven_day_sonnet" }, NOW)).toEqual({ kind: "sonnet" });
  });
});

describe("claudeUsageLimit", () => {
  it("reads the 2.1.x frame: the reset from rate_limit_info, the limit from rateLimitType", () => {
    const text = "You've hit your session limit · resets 3pm (America/Los_Angeles)";
    expect(claudeUsageLimit(limitFrame(text), text, NOW)).toEqual({ resetsAt: iso(IN_TWO_HOURS), kind: "session" });
  });

  it("reads the words when the frame carries no structure", () => {
    const weekly = "You've hit your weekly limit · resets Oct 9, 5pm (America/Los_Angeles)";
    expect(claudeUsageLimit({ error: "unknown", is_api_error_message: true }, weekly, NOW))
      .toEqual({ resetsAt: "2026-10-10T00:00:00.000Z", kind: "weekly" });
    const opus = "You've hit your Opus limit · resets 3pm (America/Los_Angeles)";
    expect(claudeUsageLimit({ is_api_error_message: true }, opus, NOW)).toEqual({ resetsAt: "2026-10-07T22:00:00.000Z", kind: "opus" });
    const legacy = `Claude AI usage limit reached|${IN_TWO_HOURS}`;
    expect(claudeUsageLimit({ error: "rate_limit", is_api_error_message: true }, legacy, NOW)).toEqual({ resetsAt: iso(IN_TWO_HOURS) });
  });

  it("fills a reset the error frame leaves out from the turn's rejected rate_limit_event", () => {
    const frame = limitFrame("You've hit your session limit", { status: "rejected" });
    expect(claudeUsageLimit(frame, "You've hit your session limit", NOW, { resetsAt: iso(IN_TWO_HOURS), kind: "session" }))
      .toEqual({ resetsAt: iso(IN_TWO_HOURS), kind: "session" });
    expect(claudeUsageLimit(frame, "You've hit your session limit", NOW)).toEqual({ kind: "session" });
  });

  it("is never a model reply, nor a passing rate limit the CLI retries itself", () => {
    const words = "You've hit your session limit · resets 3pm (America/Los_Angeles)";
    expect(claudeUsageLimit({}, words, NOW)).toBeNull();
    expect(claudeUsageLimit({ type: "assistant", message: { content: [{ type: "text", text: words }] } }, words, NOW)).toBeNull();
    expect(claudeUsageLimit({ error: "rate_limit", is_api_error_message: true }, "API Error: 429 rate_limit_error · Please try again", NOW)).toBeNull();
    expect(claudeUsageLimit({ error: "unknown", is_api_error_message: true }, "API Error: 529 Overloaded", NOW)).toBeNull();
  });

  it("names the limit from its words", () => {
    expect(limitKindFromWords("You've hit your Sonnet limit")).toBe("sonnet");
    expect(limitKindFromWords("You've reached your 5-hour limit")).toBe("session");
    expect(limitKindFromWords("You've hit your limit")).toBeUndefined();
  });
});

describe("codexUsageLimit", () => {
  // codex-cli 0.154 app-server: TurnError { message, codexErrorInfo }, and account/rateLimits/updated windows.
  const sentence = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:05 PM.";
  const IN_A_WEEK = Math.floor(NOW / 1000) + 6 * 86_400;

  it("takes the reset from the full window that resets last, and names it", () => {
    const windows = {
      primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: IN_TWO_HOURS },
      secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: IN_A_WEEK },
    };
    expect(codexUsageLimit({ message: sentence, codexErrorInfo: "usageLimitExceeded" }, windows, NOW)).toEqual({ resetsAt: iso(IN_A_WEEK), kind: "weekly" });
    expect(codexUsageLimit({ message: sentence, codexErrorInfo: "usageLimitExceeded" },
      { primary: windows.primary, secondary: { ...windows.secondary, usedPercent: 40 } }, NOW)).toEqual({ resetsAt: iso(IN_TWO_HOURS), kind: "session" });
  });

  it("reads Codex's own words when no window is full or reported", () => {
    // 3:05 PM today in this machine's zone; the fixture's zone is whatever the test host runs in.
    const at = codexUsageLimit({ message: sentence, codexErrorInfo: "usageLimitExceeded" }, undefined, NOW);
    expect(at?.resetsAt).toBe(parseResetWords("resets 3:05 pm", NOW));
    expect(codexUsageLimit({ message: "You've hit your usage limit. Try again on Oct 9th, 2026 5:00 PM (America/Los_Angeles)." }, undefined, NOW))
      .toEqual({ resetsAt: "2026-10-10T00:00:00.000Z" });
    expect(codexUsageLimit({ message: "You've hit your usage limit. Try again in 2 days 3 hours 5 minutes." }, undefined, NOW))
      .toEqual({ resetsAt: new Date(NOW + (2 * 24 * 60 + 3 * 60 + 5) * 60_000).toISOString() });
    expect(codexUsageLimit({ message: "You've hit your usage limit.", codexErrorInfo: "usageLimitExceeded" }, undefined, NOW)).toEqual({});
  });

  it("knows the ChatGPT plan's code, and nothing that is not a reached limit", () => {
    expect(codexUsageLimit({ message: "subscription_sharing_usage_limit_exceeded" }, undefined, NOW)).toEqual({});
    expect(codexUsageLimit({ message: "Rate limit reached for requests", codexErrorInfo: "rateLimitExceeded" }, undefined, NOW)).toBeNull();
    expect(codexUsageLimit({ message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } }, undefined, NOW)).toBeNull();
    expect(codexUsageLimit({ message: undefined, codexErrorInfo: null }, undefined, NOW)).toBeNull();
  });
});
