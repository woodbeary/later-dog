import { describe, expect, it } from "vitest";
import { parseActivity, signedActivityRequest } from "../../deploy/laterdog/home/src/activity.ts";
import { createHomeActivity, homeActivityFrom, type HomeWorkSignals } from "./home-activity.ts";

const SECRET = "a-bootstrap-secret-long-enough-for-the-home-0123456789";
const NOW = 1_800_000_000_000;
const QUIET: HomeWorkSignals = { routines: { hold: false }, turns: false, queued: false, cloudJobs: false, upkeep: false };

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
    const activity = createHomeActivity({ secret: SECRET, now: () => NOW, activity: () => ({ busy: false, nextAt: NOW + 60_000, work: [] }) });
    const signed = await headersFrom(SECRET);
    expect(activity.handle(signed)).toEqual({ status: 200, body: { busy: false, nextAt: NOW + 60_000, work: [] } });
    expect(activity.handle(signed)).toEqual({ status: 401, body: { error: "replayed_request" } });
  });

  it("refuses anyone without the secret, and stale questions", async () => {
    const activity = createHomeActivity({ secret: SECRET, now: () => NOW, activity: () => ({ busy: true, nextAt: null, work: ["turn"] }) });
    expect(activity.handle(await headersFrom("someone-else"))).toMatchObject({ status: 401 });
    expect(activity.handle({ timestamp: undefined, nonce: undefined, signature: undefined })).toMatchObject({ status: 401 });
    expect(activity.handle(await headersFrom(SECRET, NOW - 10 * 60_000))).toEqual({ status: 401, body: { error: "stale_request" } });
  });

  it("is busy while any dog works or a routine runs, and names the next routine otherwise", () => {
    expect(homeActivityFrom({ ...QUIET, turns: true })).toEqual({ busy: true, nextAt: null, work: ["turn"] });
    expect(homeActivityFrom({ ...QUIET, routines: { hold: true, reason: "running" } })).toEqual({ busy: true, nextAt: null, work: ["routine"] });
    expect(homeActivityFrom({ ...QUIET, routines: { hold: true, reason: "due", at: NOW + 5 } })).toEqual({ busy: false, nextAt: NOW + 5, work: [] });
    expect(homeActivityFrom(QUIET)).toEqual({ busy: false, nextAt: null, work: [] });
  });

  it("is busy for queued messages, a cloud job still going and workspace upkeep, naming each", () => {
    expect(homeActivityFrom({ ...QUIET, queued: true })).toEqual({ busy: true, nextAt: null, work: ["queued"] });
    expect(homeActivityFrom({ ...QUIET, cloudJobs: true })).toEqual({ busy: true, nextAt: null, work: ["cloud_job"] });
    expect(homeActivityFrom({ ...QUIET, upkeep: true })).toEqual({ busy: true, nextAt: null, work: ["upkeep"] });
    expect(homeActivityFrom({ routines: { hold: true, reason: "due", at: NOW + 5 }, turns: true, queued: true, cloudJobs: true, upkeep: true }))
      .toEqual({ busy: true, nextAt: NOW + 5, work: ["turn", "queued", "cloud_job", "upkeep"] });
  });

  it("answers in the shape the home's Worker reads", async () => {
    const answer = homeActivityFrom({ ...QUIET, routines: { hold: true, reason: "due", at: NOW + 5 }, cloudJobs: true, turns: true });
    const activity = createHomeActivity({ secret: SECRET, now: () => NOW, activity: () => answer });
    const { body } = activity.handle(await headersFrom(SECRET));
    expect(parseActivity(JSON.parse(JSON.stringify(body)))).toEqual(answer);
  });
});
