import { describe, expect, it } from "vitest";
import { signedActivityRequest } from "../../deploy/laterdog/home/src/activity.ts";
import { createHomeActivity, homeActivityFrom } from "./home-activity.ts";

const SECRET = "a-bootstrap-secret-long-enough-for-the-home-0123456789";
const NOW = 1_800_000_000_000;

async function headersFrom(secret: string, at = NOW) {
  const request = await signedActivityRequest("https://h1-home.later.dog", secret, at);
  return {
    timestamp: request.headers.get("x-laterdog-cloud-timestamp") ?? undefined,
    nonce: request.headers.get("x-laterdog-cloud-nonce") ?? undefined,
    signature: request.headers.get("x-laterdog-cloud-signature") ?? undefined,
  };
}

describe("a home telling its host whether it may sleep", () => {
  it("answers the home Worker's signed question, once per nonce", async () => {
    const activity = createHomeActivity({ secret: SECRET, now: () => NOW, activity: () => ({ busy: false, nextAt: NOW + 60_000 }) });
    const signed = await headersFrom(SECRET);
    expect(activity.handle(signed)).toEqual({ status: 200, body: { busy: false, nextAt: NOW + 60_000 } });
    expect(activity.handle(signed)).toEqual({ status: 401, body: { error: "replayed_request" } });
  });

  it("refuses anyone without the secret, and stale questions", async () => {
    const activity = createHomeActivity({ secret: SECRET, now: () => NOW, activity: () => ({ busy: true, nextAt: null }) });
    expect(activity.handle(await headersFrom("someone-else"))).toMatchObject({ status: 401 });
    expect(activity.handle({ timestamp: undefined, nonce: undefined, signature: undefined })).toMatchObject({ status: 401 });
    expect(activity.handle(await headersFrom(SECRET, NOW - 10 * 60_000))).toEqual({ status: 401, body: { error: "stale_request" } });
  });

  it("is busy while any dog works or a routine runs, and names the next routine otherwise", () => {
    expect(homeActivityFrom({ hold: false }, true)).toEqual({ busy: true, nextAt: null });
    expect(homeActivityFrom({ hold: true, reason: "running" }, false)).toEqual({ busy: true, nextAt: null });
    expect(homeActivityFrom({ hold: true, reason: "due", at: NOW + 5 }, false)).toEqual({ busy: false, nextAt: NOW + 5 });
    expect(homeActivityFrom({ hold: false }, false)).toEqual({ busy: false, nextAt: null });
  });
});
