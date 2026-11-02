import { describe, expect, it } from "vitest";
import {
  asDataUrl, clefScreenChecks, confirmedQuestion, irreversibleQuestion, isPersonState, readState, readYes, SCREEN_CHECK_MAX_IMAGE_CHARS, stateQuestion,
} from "./computer-use-screen.ts";
import { LaterdogComputers } from "./laterdog-cloud.ts";

const jpeg = Buffer.from("\xff\xd8\xff\xe0fixture frame", "latin1");

describe("clef-flash questions about the screen", () => {
  it("asks which of the seven states a frame is in, with the frame as a data URL", () => {
    const body = stateQuestion(asDataUrl(jpeg)!);
    expect(body).toMatchObject({ model: "clef-flash", images: [`data:image/jpeg;base64,${jpeg.toString("base64")}`] });
    expect(Object.keys((body.questions as any).screen.criteria)).toEqual(["ready", "loading", "login", "two_factor", "captcha", "error", "dialog"]);
  });

  it("asks yes or no about an irreversible click and a confirmation, naming the action", () => {
    expect((irreversibleQuestion("data:x", "left_click at (640, 400)") as any).questions.irreversible.type).toBe("noul");
    expect((irreversibleQuestion("data:x", "left_click at (640, 400)") as any).state.action).toBe("left_click at (640, 400)");
    expect((confirmedQuestion("data:x", "left_click at (640, 400)") as any).questions.confirmed.type).toBe("noul");
  });

  it("leaves out a frame too large for the computers service", () => {
    expect(asDataUrl(Buffer.alloc(SCREEN_CHECK_MAX_IMAGE_CHARS))).toBeNull();
  });

  it("reads Clef's answers, and nothing it cannot read", () => {
    expect(readState({ answers: { screen: { choice: "login", probabilities: { login: 0.9345, ready: 0.0655 } } } })).toEqual({ screen: "login", probability: 0.935 });
    expect(readState({ answers: { screen: { choice: "spaceship", probabilities: { spaceship: 1 } } } })).toBeNull();
    expect(readState({ answers: { screen: { choice: "login" } } })).toBeNull();
    expect(readState(null)).toBeNull();
    expect(readYes({ answers: { irreversible: { noul: 0.81 } } }, "irreversible")).toBe(0.81);
    expect(readYes({ answers: { irreversible: { noul: 2 } } }, "irreversible")).toBeNull();
  });

  it("counts only a sure sign-in, code or CAPTCHA screen as one that needs the person", () => {
    expect(isPersonState({ screen: "two_factor", probability: 0.7 })).toBe(true);
    expect(isPersonState({ screen: "captcha", probability: 0.4 })).toBe(false);
    expect(isPersonState({ screen: "dialog", probability: 0.99 })).toBe(false);
    expect(isPersonState(null)).toBe(false);
  });

  it("treats a failed or unreadable check as no answer, but stops when the run is stopped", async () => {
    const failing = clefScreenChecks(async () => { throw new Error("later.dog's computers service refused this supervisor (403)"); });
    expect(await failing.state(jpeg, new AbortController().signal)).toBeNull();
    expect(await failing.irreversible(jpeg, "left_click", new AbortController().signal)).toBeNull();
    const asked: Array<Record<string, unknown>> = [];
    const answering = clefScreenChecks(async (body) => { asked.push(body); return { answers: { confirmed: { noul: 0.12 } } }; });
    expect(await answering.confirmed(jpeg, "left_click", new AbortController().signal)).toBe(0.12);
    expect(asked[0]!.model).toBe("clef-flash");
    const stopped = new AbortController();
    stopped.abort(new Error("The person ended this run."));
    await expect(clefScreenChecks(async () => { throw new Error("aborted"); }).state(jpeg, stopped.signal)).rejects.toThrow("aborted");
  });

  it("asks the computers service's supervisor-only route with the owner key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const computers = new LaterdogComputers({ api: "https://computers.fixture.test/v1", key: "ldc_fixtureComputersKey000" },
      (async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json({ answers: { screen: { choice: "captcha", probabilities: { captcha: 0.88 } } } }); }) as typeof fetch);
    const checks = clefScreenChecks((body) => computers.screenCheck(body));
    expect(await checks.state(jpeg, new AbortController().signal)).toEqual({ screen: "captcha", probability: 0.88 });
    expect(calls[0]!.url).toBe("https://computers.fixture.test/v1/screen-checks");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer ldc_fixtureComputersKey000");
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("clef-flash");
  });
});
