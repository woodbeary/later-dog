import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/auth";
import {
  COMPLETE_DEFAULT_MODEL,
  COMPLETE_MAX_OUTPUT_TOKENS,
  COMPLETE_TEMPERATURE,
  COMPLETIONS_PER_DAY,
  completeInput,
  completeRequest,
  completionFrom,
  finishCompletion,
} from "../src/complete";
import { route } from "../src/routes";
import { DAY } from "../src/trial";
import { apiRequest, body, siteverify, startTrial, trialKey, world, viaGateway } from "./fakes";

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

async function included(answer: unknown = { response: " the failing tests first" }, vars: Record<string, string> = {}) {
  const run = vi.fn(async () => answer);
  const w = await world({ AI: { run, gateway: vi.fn() }, ...vars } as unknown as Record<string, string>);
  siteverify();
  const key = trialKey("k");
  expect((await startTrial(w, key)).status).toBe(200);
  return { w, run, key };
}

const complete = (key: string, payload: unknown, headers: Record<string, string> = {}) =>
  apiRequest("POST", "/v1/complete", key, { body: payload, headers });

describe("the completion route", () => {
  it("answers on POST only", () => {
    expect(route("POST", "/v1/complete")).toEqual({ kind: "complete" });
    expect(route("GET", "/v1/complete")).toEqual({ kind: "method_not_allowed", allow: ["POST"] });
    expect(route("POST", "/v1/complete/")).toEqual({ kind: "not_found", api: true });
  });
});

describe("what the Worker asks the model", () => {
  it("sends a small chat with few output tokens, low temperature and no secrets beyond what the app chose to send", () => {
    const parsed = completeRequest({
      prefix: "Please fix ",
      dog: "Rex",
      messages: [{ role: "dog", text: "I found two failing tests." }, { role: "person", text: "ok" }],
      phrasing: ["Can you take a look at"],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const input = completeInput(parsed.request);
    expect(input.max_tokens).toBe(COMPLETE_MAX_OUTPUT_TOKENS);
    expect(COMPLETE_MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(24);
    expect(input.temperature).toBe(COMPLETE_TEMPERATURE);
    expect(input.temperature).toBeLessThanOrEqual(0.3);
    expect(input.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(input.messages[0]!.content).toContain("a dog named Rex");
    const user = input.messages[1]!.content;
    expect(user).toContain("Rex: I found two failing tests.");
    expect(user).toContain("Person: ok");
    expect(user).toContain("- Can you take a look at");
    expect(user.endsWith("Please fix ")).toBe(true);
  });

  it("refuses empty, oversized and malformed requests", () => {
    for (const bad of [null, [], {}, { prefix: "   " }, { prefix: 3 }, { prefix: "x".repeat(1_501) }, { prefix: "a", messages: "no" }, { prefix: "a", messages: Array.from({ length: 7 }, () => ({ role: "dog", text: "x" })) }, { prefix: "a", messages: [{ role: "robot", text: "x" }] }, { prefix: "a", phrasing: [1] }, { prefix: "a", phrasing: ["1", "2", "3", "4"] }]) {
      const parsed = completeRequest(bad);
      expect(parsed.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("clips long messages and drops empty ones", () => {
    const parsed = completeRequest({ prefix: "a", messages: [{ role: "person", text: `${"w ".repeat(500)}` }, { role: "dog", text: "   " }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.messages).toHaveLength(1);
    expect(parsed.request.messages[0]!.text.length).toBeLessThanOrEqual(400);
  });
});

describe("what comes back from the model", () => {
  it("keeps the first line, drops quotes and an echo of the typed text, and caps the length", () => {
    expect(finishCompletion("Please fix ", "the failing tests")).toBe("the failing tests");
    expect(finishCompletion("Please fix", " the failing tests")).toBe(" the failing tests");
    expect(finishCompletion("Please fix", "Please fix the failing tests")).toBe(" the failing tests");
    expect(finishCompletion("Can you fi", "x the build\nand more")).toBe("x the build");
    expect(finishCompletion("Hi", "\"there, how are you\"")).toBe("there, how are you");
    expect(finishCompletion("Done.", "Thanks")).toBe(" Thanks");
    expect(finishCompletion("a", "w ".repeat(40)).split(" ").length).toBeLessThanOrEqual(12);
    expect(finishCompletion("a", "x".repeat(400)).length).toBeLessThanOrEqual(120);
    expect(finishCompletion("hello ", "   ")).toBe("");
    expect(finishCompletion("hello ", "\n\nsecond line")).toBe("");
  });

  it("reads Workers AI's plain and OpenAI-shaped answers, and nothing else", () => {
    expect(completionFrom("a ", { response: "b" })).toBe("b");
    expect(completionFrom("a ", { result: { response: "b" } })).toBe("b");
    expect(completionFrom("a ", { choices: [{ message: { content: "b c" } }] })).toBe("b c");
    expect(completionFrom("a ", { response: 3 })).toBeNull();
    expect(completionFrom("a ", "b")).toBeNull();
    expect(completionFrom("a ", null)).toBeNull();
  });
});

describe("included completions", () => {
  it("finishes a sentence with a small Workers AI model through the AI Gateway, logging no content", async () => {
    const { w, run, key, } = await included();
    const response = await w.fetch(complete(key, { prefix: "Please fix", dog: "Rex", messages: [{ role: "dog", text: "Two tests fail." }] }));
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ completion: " the failing tests first", model: COMPLETE_DEFAULT_MODEL });
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input, options] = (run.mock.calls as unknown[][])[0] as unknown as [string, { max_tokens: number; temperature: number; messages: unknown[] }, unknown];
    expect(model).toBe(COMPLETE_DEFAULT_MODEL);
    expect(input.max_tokens).toBe(COMPLETE_MAX_OUTPUT_TOKENS);
    expect(input.temperature).toBe(COMPLETE_TEMPERATURE);
    expect(options).toEqual(await viaGateway(key));
    const logged = [...w.logs.mock.calls, ...w.errors.mock.calls].flat().join(" ");
    expect(logged).not.toContain("Please fix");
    expect(logged).not.toContain("Two tests fail");
  });

  it("uses the model named in TYPING_AI_MODEL", async () => {
    const { w, run, key } = await included(undefined, { TYPING_AI_MODEL: " @cf/meta/llama-3.1-8b-instruct-fast " });
    expect((await w.fetch(complete(key, { prefix: "Please fix" }))).status).toBe(200);
    expect((run.mock.calls as unknown[][])[0]![0]).toBe("@cf/meta/llama-3.1-8b-instruct-fast");
  });

  it("answers an empty completion when the model has nothing to add", async () => {
    const { w, key } = await included({ response: "" });
    const response = await w.fetch(complete(key, { prefix: "Please fix" }));
    expect(response.status).toBe(200);
    expect((await body(response)).completion).toBe("");
  });

  it("refuses a bad request before any model call", async () => {
    const { w, run, key } = await included();
    for (const bad of [{}, { prefix: "" }, { prefix: "a", messages: [{ role: "x", text: "y" }] }]) {
      const response = await w.fetch(complete(key, bad));
      expect(response.status).toBe(422);
      expect((await body(response)).error.code).toBe("invalid_request");
    }
    const big = await w.fetch(complete(key, { prefix: "a", messages: [{ role: "person", text: "z".repeat(40_000) }] }));
    expect(big.status).toBe(413);
    const notJson = await w.fetch(new Request("https://computers.example/v1/complete", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: "nope" }));
    expect(notJson.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it("serves only live free trials, never a browser, and stops when the trial window ends", async () => {
    const { w, run, key } = await included();
    expect((await w.fetch(complete(trialKey("z"), { prefix: "Please fix" }))).status).toBe(401);
    expect((await w.fetch(new Request("https://computers.example/v1/complete", { method: "POST", body: "{}" }))).status).toBe(401);
    expect((await w.fetch(complete(key, { prefix: "Please fix" }, { origin: "https://evil.example" }))).status).toBe(403);
    await w.advance(8 * DAY);
    expect((await w.fetch(complete(key, { prefix: "Please fix" }))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("counts each completion against the installation's day and starts again tomorrow", async () => {
    const { w, run, key } = await included();
    expect((await w.fetch(complete(key, { prefix: "Please fix" }))).status).toBe(200);
    const registry = w.trials.named("trials");
    const keySha256 = await sha256Hex(key);
    expect(await registry.allowUsage({ keySha256, kind: "completions", amount: COMPLETIONS_PER_DAY - 2, perKey: COMPLETIONS_PER_DAY, total: 100_000_000 })).toEqual({ ok: true, tier: "trial" });
    expect((await w.fetch(complete(key, { prefix: "Please fix" }))).status).toBe(200);
    const spent = await w.fetch(complete(key, { prefix: "Please fix" }));
    expect(spent.status).toBe(429);
    expect((await body(spent)).error.code).toBe("daily_limit");
    expect(run).toHaveBeenCalledTimes(2);
    await w.advance(DAY);
    expect((await w.fetch(complete(key, { prefix: "Please fix" }))).status).toBe(200);
  });

  it("says the service failed when the model throws or answers without text", async () => {
    const { w, run, key } = await included();
    run.mockRejectedValueOnce(new Error("3010: bad input"));
    const thrown = await w.fetch(complete(key, { prefix: "Please fix" }));
    expect(thrown.status).toBe(502);
    expect((await body(thrown)).error.code).toBe("upstream_failed");
    run.mockResolvedValueOnce({ usage: {} });
    expect((await w.fetch(complete(key, { prefix: "Please fix" }))).status).toBe(502);
  });

  it("says included services are not set up when there is no AI binding", async () => {
    const w = await world();
    siteverify();
    const key = trialKey("k");
    expect((await startTrial(w, key)).status).toBe(200);
    const response = await w.fetch(complete(key, { prefix: "Please fix" }));
    expect(response.status).toBe(503);
    expect((await body(response)).error.code).toBe("not_included");
  });
});
