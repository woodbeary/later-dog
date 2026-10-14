import { describe, expect, it } from "vitest";
import { MIN_WAKE_DELAY_MS, parseActivity, signedActivityRequest, sleepDecision, WAKE_EARLY_MS } from "../src/activity.ts";

const NOW = 1_800_000_000_000;

describe("whether a home may sleep", () => {
  it("stays awake while a dog is working", () => {
    expect(sleepDecision({ busy: true, nextAt: null }, NOW)).toEqual({ stay: true });
    expect(sleepDecision({ busy: true, nextAt: NOW + 3_600_000 }, NOW)).toEqual({ stay: true });
  });

  it("sleeps, waking a minute before the next routine", () => {
    expect(sleepDecision({ busy: false, nextAt: NOW + 3_600_000 }, NOW)).toEqual({ stay: false, wakeAt: NOW + 3_600_000 - WAKE_EARLY_MS });
    expect(sleepDecision({ busy: false, nextAt: NOW + 10_000 }, NOW)).toEqual({ stay: false, wakeAt: NOW + MIN_WAKE_DELAY_MS });
  });

  it("sleeps with nothing scheduled when there are no routines or the home doesn't answer", () => {
    expect(sleepDecision({ busy: false, nextAt: null }, NOW)).toEqual({ stay: false, wakeAt: null });
    expect(sleepDecision(null, NOW)).toEqual({ stay: false, wakeAt: null });
  });

  it("trusts only a well-formed answer", () => {
    expect(parseActivity({ busy: false, nextAt: NOW })).toEqual({ busy: false, nextAt: NOW });
    expect(parseActivity({ busy: "no", nextAt: null })).toBeNull();
    expect(parseActivity({ busy: false, nextAt: -1 })).toBeNull();
    expect(parseActivity(null)).toBeNull();
  });

  it("asks with a signed GET", async () => {
    const request = await signedActivityRequest("https://h1-home.later.dog", "secret", NOW);
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/api/cloud/activity");
    expect(request.headers.get("x-laterdog-cloud-signature")).toMatch(/^v1=[A-Za-z0-9_-]{43}$/);
    expect(request.headers.get("x-laterdog-cloud-timestamp")).toBe(String(Math.floor(NOW / 1000)));
  });
});
