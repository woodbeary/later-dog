import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { createDecider, deciderImagesReady } from "../decider/index.ts";
import { createBreaker } from "./clef-breaker.ts";
import { chosen, fastDecide, yes } from "./clef-fast-decide.ts";
import { choiceAnswer, fakeDecider, yesAnswer } from "./clef-fake-decider.ts";

const KEY = "tsk_unit_secret_key_0123456789abcdef";
const CLEF: AppConfig = { decider: { enabled: true, key: KEY, model: "clef-flash", baseUrl: "https://decider.example.test", jobs: { screenCheck: true } } };
const QUESTIONS = { ok: { type: "yesno" as const, instructions: "Is it fine?" } };
const jpeg = Buffer.from("jpeg-bytes").toString("base64");

afterEach(() => vi.restoreAllMocks());

describe("fastDecide", () => {
  it("returns the answers and how long the decision took", async () => {
    const decider = fakeDecider(() => ({ answers: { ok: yesAnswer(0.9) }, delayMs: 3 }));
    const result = await fastDecide(decider, "turnEnd", { task: "x" }, QUESTIONS);
    expect(result).toMatchObject({ decided: true, answers: { ok: { p: 0.9 } } });
    expect(decider.calls[0]!.options.timeoutMs).toBeGreaterThan(1_400);
    expect(decider.calls[0]!.options.timeoutMs).toBeLessThanOrEqual(1_500);
  });

  it("falls back on every failure the decider can name, and never throws", async () => {
    for (const fail of ["timeout", "unreachable", "rate_limited", "disabled", "no_key", "malformed"] as const) {
      const result = await fastDecide(fakeDecider(() => ({ fail })), "turnEnd", {}, QUESTIONS);
      expect(result).toMatchObject({ decided: false, reason: fail });
    }
    const exploding = { ask: () => { throw new Error("boom"); } } as unknown as Parameters<typeof fastDecide>[0];
    await expect(fastDecide(exploding, "turnEnd", {}, QUESTIONS)).resolves.toEqual({ decided: false, reason: "malformed" });
    await expect(fastDecide(undefined, "turnEnd", {}, QUESTIONS)).resolves.toEqual({ decided: false, reason: "no_decider" });
  });

  it("gives up at the budget instead of waiting for a slow decider", async () => {
    const decider = fakeDecider(() => ({ hang: true }));
    const started = Date.now();
    const result = await fastDecide(decider, "turnEnd", {}, QUESTIONS, { budgetMs: 60 });
    expect(result).toMatchObject({ decided: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(decider.calls[0]!.options.timeoutMs).toBeLessThanOrEqual(60);
  });

  it("sends prepared images and refuses before asking when an image is not usable", async () => {
    const decider = fakeDecider(() => ({ answers: { ok: yesAnswer(0.5) } }));
    await fastDecide(decider, "screenCheck", {}, QUESTIONS, { images: [{ data: jpeg, format: "jpeg" }], model: "clef-flash" });
    expect(decider.calls[0]!.options.images).toEqual([`data:image/jpeg;base64,${jpeg}`]);
    expect(decider.calls[0]!.options.model).toBe("clef-flash");
    const refused = await fastDecide(decider, "screenCheck", {}, QUESTIONS, { images: [{ data: jpeg, format: "bmp" }] });
    expect(refused).toEqual({ decided: false, reason: "unsupported_type" });
    expect(decider.calls).toHaveLength(1);
  });

  it("reads thresholds from answers", () => {
    expect(yes(yesAnswer(0.8), 0.8)).toBe(true);
    expect(yes(yesAnswer(0.79), 0.8)).toBe(false);
    expect(yes(undefined, 0.1)).toBe(false);
    expect(chosen(choiceAnswer("a", 0.9, ["a", "b"]), 0.8)).toBe("a");
    expect(chosen(choiceAnswer("a", 0.6, ["a", "b"]), 0.8)).toBeNull();
  });
});

describe("one deadline for the whole decision", () => {
  it("counts slow image preparation against the budget", async () => {
    const decider = fakeDecider(() => ({ answers: { ok: yesAnswer(0.5) } }));
    const slowShrink = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), 400));
    const big = Buffer.alloc(200_000, 1).toString("base64");
    const started = Date.now();
    const result = await fastDecide(decider, "screenCheck", {}, QUESTIONS, { budgetMs: 80, images: [{ data: big, format: "jpeg" }], shrink: slowShrink });
    expect(result).toMatchObject({ decided: false });
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("shares what is left of the budget with the ask", async () => {
    const decider = fakeDecider(() => ({ answers: { ok: yesAnswer(0.5) } }));
    const slowShrink = async (bytes: Buffer) => { await new Promise((resolve) => setTimeout(resolve, 100)); return { bytes: bytes.subarray(0, 10), mime: "image/jpeg" }; };
    const big = Buffer.alloc(200_000, 1).toString("base64");
    await fastDecide(decider, "screenCheck", {}, QUESTIONS, { budgetMs: 1_000, images: [{ data: big, format: "jpeg" }], shrink: slowShrink });
    expect(decider.calls[0]!.options.timeoutMs).toBeLessThan(950);
  });
});

describe("the circuit breaker in fastDecide", () => {
  it("skips a job for a minute after three failures in a row, then tries again", async () => {
    let clock = 0;
    const breaker = createBreaker({ now: () => clock });
    const decider = fakeDecider(() => ({ fail: "timeout" }));
    for (let index = 0; index < 3; index++) expect(await fastDecide(decider, "turnEnd", {}, QUESTIONS, { breaker })).toMatchObject({ reason: "timeout" });
    expect(await fastDecide(decider, "turnEnd", {}, QUESTIONS, { breaker })).toEqual({ decided: false, reason: "circuit_open" });
    expect(decider.calls).toHaveLength(3);
    expect(await fastDecide(decider, "screenCheck", {}, QUESTIONS, { breaker })).toMatchObject({ reason: "timeout" });
    clock += 61_000;
    expect(await fastDecide(decider, "turnEnd", {}, QUESTIONS, { breaker })).toMatchObject({ reason: "timeout" });
    expect(decider.calls).toHaveLength(5);
  });

  it("a success resets the count, and settings problems never open it", async () => {
    const breaker = createBreaker();
    let fail = true;
    const decider = fakeDecider(() => (fail ? { fail: "unreachable" } : { answers: { ok: yesAnswer(0.5) } }));
    await fastDecide(decider, "turnEnd", {}, QUESTIONS, { breaker });
    await fastDecide(decider, "turnEnd", {}, QUESTIONS, { breaker });
    fail = false;
    await fastDecide(decider, "turnEnd", {}, QUESTIONS, { breaker });
    fail = true;
    await fastDecide(decider, "turnEnd", {}, QUESTIONS, { breaker });
    await fastDecide(decider, "turnEnd", {}, QUESTIONS, { breaker });
    expect(breaker.isOpen("turnEnd")).toBe(false);
    const quiet = createBreaker();
    const off = fakeDecider(() => ({ fail: "disabled" }));
    for (let index = 0; index < 6; index++) await fastDecide(off, "turnEnd", {}, QUESTIONS, { breaker: quiet });
    expect(quiet.isOpen("turnEnd")).toBe(false);
  });
});

describe("the decider client carries images and a model", () => {
  const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

  it("sends images and the chosen model only when asked to", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => body({ answers: { answer: { noul: 0.7 } } }));
    const decider = createDecider({ config: () => CLEF, fetch: fetchImpl as unknown as typeof fetch });
    await decider.yesNo("screenCheck", { note: "x" }, "Is it loading?", { images: [`data:image/jpeg;base64,${jpeg}`] });
    await decider.yesNo("screenCheck", { note: "x" }, "Is it loading?");
    const first = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    const second = JSON.parse(String(fetchImpl.mock.calls[1]![1]!.body));
    expect(first.model).toBe("clef-flash");
    expect(first.images).toEqual([`data:image/jpeg;base64,${jpeg}`]);
    expect(second.model).toBe("clef-flash");
    expect(second).not.toHaveProperty("images");
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://decider.example.test/v1/systemone");
  });

  it("keeps the Jev model name when no model is chosen, so older servers see today's request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => body({ answers: { answer: { noul: 0.7 } } }));
    const decider = createDecider({ config: () => ({ decider: { enabled: true, key: KEY, jobs: { turnEnd: true } } }), fetch: fetchImpl as unknown as typeof fetch });
    await decider.yesNo("turnEnd", {}, "Is it?");
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(sent.model).toBe("jev-latest");
    expect(sent).not.toHaveProperty("images");
  });

  it("defaults each job's model on a Clef endpoint and leaves the Typesafe endpoint alone", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => body({ answers: { answer: { noul: 0.7 } } }));
    const on = { enabled: true, key: KEY, baseUrl: "https://clef.example.test", jobs: { turnEnd: true, autoReview: true } };
    const decider = createDecider({ config: () => ({ decider: on }), fetch: fetchImpl as unknown as typeof fetch });
    await decider.yesNo("turnEnd", {}, "Is it?");
    await decider.yesNo("autoReview", {}, "Is it?");
    const named = createDecider({ config: () => ({ decider: { ...on, models: { turnEnd: "clef" } } }), fetch: fetchImpl as unknown as typeof fetch });
    await named.yesNo("turnEnd", {}, "Is it?");
    const sent = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]!.body)).model);
    expect(sent).toEqual(["clef-flash", "clef", "clef"]);
  });

  it("knows when the configured decider can read images", () => {
    expect(deciderImagesReady(CLEF, "screenCheck")).toBe(true);
    expect(deciderImagesReady({ decider: { enabled: true, key: KEY } }, "screenCheck")).toBe(false);
    expect(deciderImagesReady({ decider: { ...CLEF.decider, jobs: { screenCheck: false } } }, "screenCheck")).toBe(false);
    expect(deciderImagesReady({ decider: { ...CLEF.decider, jobs: {} } }, "screenCheck")).toBe(false);
  });
});
