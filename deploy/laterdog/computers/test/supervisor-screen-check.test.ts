import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputersApi } from "../src/index";
import { ORIGIN, OWNER_KEY, apiRequest, body, siteverify, startTrial, trialKey, world } from "./fakes";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
  WorkerEntrypoint: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown,
    ) {}
  },
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const frame = `data:image/jpeg;base64,${btoa("\xff\xd8\xff\xe0fixture frame")}`;
const question = {
  model: "clef-flash",
  images: [frame],
  state: { situation: "A screenshot of a Linux desktop that Claude is controlling for the person." },
  questions: { screen: { type: "choice", instructions: "Which best describes the screen now?", criteria: { ready: "Ready.", login: "A sign-in page." } } },
};
const answer = { model: "clef-flash", answers: { screen: { type: "choice", choice: "login", probabilities: { login: 0.93, ready: 0.07 } } } };

async function screenChecks() {
  const run = vi.fn(async () => answer);
  const w = await world({ AI: { run } } as unknown as Record<string, string>);
  return { w, run };
}

const post = (key: string, payload: unknown = question) => apiRequest("POST", "/v1/screen-checks", key, { body: payload });

describe("screen checks for later.dog's own supervisor", () => {
  it("answers the owner key with clef-flash, with the AI Gateway log off", async () => {
    const { w, run } = await screenChecks();
    const response = await w.fetch(post(OWNER_KEY));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual(answer);
    expect(run).toHaveBeenCalledWith("@cf/cloudflare/clef-flash", { model: "clef-flash", state: question.state, questions: question.questions, images: [frame] },
      { gateway: { id: "default", collectLog: false, metadata: { user: "supervisor", tier: "owner" } } });
  });

  it("answers the supervisor's service binding without a key", async () => {
    const { w, run } = await screenChecks();
    const api = new ComputersApi({} as ExecutionContext, w.env as unknown as Env);
    const response = await api.fetch(new Request(`${ORIGIN}/v1/screen-checks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(question) }));
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("refuses a trial key, a missing or wrong key, a browser, and any model but clef-flash", async () => {
    const { w, run } = await screenChecks();
    siteverify();
    const trial = trialKey("s");
    expect((await startTrial(w, trial)).status).toBe(200);
    const refusedTrial = await w.fetch(post(trial));
    expect(refusedTrial.status).toBe(403);
    expect((await body(refusedTrial)).error.code).toBe("supervisor_only");
    expect((await w.fetch(new Request(`${ORIGIN}/v1/screen-checks`, { method: "POST", body: JSON.stringify(question) }))).status).toBe(401);
    expect((await w.fetch(post("ldc_not-the-owner-key"))).status).toBe(401);
    expect((await w.fetch(apiRequest("POST", "/v1/screen-checks", OWNER_KEY, { body: question, headers: { origin: "https://evil.example" } }))).status).toBe(403);
    const wrongModel = await w.fetch(post(OWNER_KEY, { ...question, model: "clef" }));
    expect(wrongModel.status).toBe(422);
    expect((await w.fetch(apiRequest("GET", "/v1/screen-checks", OWNER_KEY))).status).toBe(405);
    expect(run).not.toHaveBeenCalled();
  });

  it("says plainly when Workers AI is not bound", async () => {
    const w = await world();
    const response = await w.fetch(post(OWNER_KEY));
    expect(response.status).toBe(503);
    expect((await body(response)).error.code).toBe("not_included");
  });
});
