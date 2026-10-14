import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../config.ts";
import { TYPING_MAX_OUTPUT_TOKENS } from "./typing-context.ts";
import {
  TYPING_BACKOFF_MS,
  TYPING_DEFAULT_MODEL,
  TYPING_MAX_IN_FLIGHT,
  createTypingService,
  describeTyping,
  includedCompletion,
  pickBackend,
} from "./typing-suggestions.ts";

const KEY = `ldt_${"c".repeat(43)}`;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
let home: string;
let before: string | undefined;

beforeEach(() => {
  before = process.env.LATERDOG_HOME;
  home = mkdtempSync(join(tmpdir(), "ld-typing-"));
  process.env.LATERDOG_HOME = home;
});
afterEach(() => {
  if (before === undefined) delete process.env.LATERDOG_HOME;
  else process.env.LATERDOG_HOME = before;
  rmSync(home, { recursive: true, force: true });
});

const startTrial = (included: string[] = ["decisions", "voice", "ai"]) => {
  writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true, included }));
  writeFileSync(join(home, "computers-trial-key"), `${KEY}\n`);
};

const SMART = { features: { smarterSuggestions: true } } as AppConfig;

const request = { prefix: "Please fix", dog: "Rex", messages: [{ role: "dog" as const, text: "Two tests fail." }], phrasing: [] as string[] };

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function service(cfg: AppConfig, fetcher: typeof fetch, clock = { now: 1_000 }) {
  return createTypingService({ config: () => cfg, fetch: fetcher, now: () => clock.now });
}

describe("which service finishes the sentence", () => {
  it("is later.dog's own for a live trial or plan, at /v1/complete next to the other included services", () => {
    expect(includedCompletion()).toBeNull();
    startTrial();
    expect(includedCompletion()).toEqual({ url: "https://cloud.later.dog/v1/complete", token: KEY });
  });

  it("is not offered when the trial does not include the AI", () => {
    startTrial(["decisions", "voice"]);
    expect(includedCompletion()).toBeNull();
  });

  it("is the person's own Cloudflare account when one is saved, ahead of the included service", () => {
    startTrial();
    const cfg = { typing: { accountId: ACCOUNT, token: "cf-token" } } as AppConfig;
    expect(pickBackend(cfg, includedCompletion())).toEqual({
      kind: "cloudflare",
      url: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${TYPING_DEFAULT_MODEL}`,
      token: "cf-token",
      model: TYPING_DEFAULT_MODEL,
    });
    expect(pickBackend({} as AppConfig, includedCompletion())).toMatchObject({ kind: "cloud" });
    expect(pickBackend({} as AppConfig, null)).toBeNull();
  });

  it("ignores a Cloudflare account that is incomplete or not an account id", () => {
    for (const typing of [{ accountId: ACCOUNT }, { token: "t" }, { accountId: "nope", token: "t" }]) {
      expect(pickBackend({ typing } as AppConfig, null)).toBeNull();
    }
  });

  it("uses the model the person names", () => {
    const cfg = { typing: { accountId: ACCOUNT, token: "t", model: "@cf/meta/llama-3.1-8b-instruct-fast" } } as AppConfig;
    expect(pickBackend(cfg, null)).toMatchObject({ model: "@cf/meta/llama-3.1-8b-instruct-fast" });
  });

  it("tells Settings what is set up without ever returning the token", () => {
    startTrial();
    const cfg = { typing: { accountId: ACCOUNT, token: "secret-token" } } as AppConfig;
    const described = describeTyping(cfg, includedCompletion(), true);
    expect(described).toEqual({ enabled: true, smarter: false, included: true, cloudflare: { configured: true, accountId: ACCOUNT, model: TYPING_DEFAULT_MODEL }, ranking: true });
    expect(JSON.stringify(described)).not.toContain("secret-token");
    expect(describeTyping({ features: { typingSuggestions: false } } as AppConfig, null, false)).toMatchObject({ enabled: false, included: false });
  });
});

describe("the included service path", () => {
  it("sends the chat context with the installation's key and nothing else", async () => {
    startTrial();
    const fetcher = vi.fn(async () => reply({ completion: " the failing tests", model: "m" }));
    const result = await service(SMART, fetcher as unknown as typeof fetch).complete(request);
    expect(result).toMatchObject({ ok: true, completion: " the failing tests", source: "cloud" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.later.dog/v1/complete");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body))).toEqual({ prefix: "Please fix", dog: "Rex", messages: request.messages, phrasing: [] });
  });

  it("shows nothing when the model adds nothing", async () => {
    startTrial();
    const result = await service(SMART, (async () => reply({ completion: "" })) as unknown as typeof fetch).complete(request);
    expect(result).toMatchObject({ ok: true, completion: "" });
  });

  it("stops asking for five minutes after the service says it is not there or refuses the key", async () => {
    startTrial();
    const clock = { now: 1_000 };
    const fetcher = vi.fn(async () => reply({ error: {} }, 404));
    const svc = service(SMART, fetcher as unknown as typeof fetch, clock);
    expect(await svc.complete(request)).toEqual({ ok: false, reason: "unavailable" });
    expect(await svc.complete({ ...request, prefix: "Please fix it" })).toEqual({ ok: false, reason: "unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    clock.now += TYPING_BACKOFF_MS + 1;
    await svc.complete({ ...request, prefix: "Please fix it now" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not pause for a busy answer or a bad reply", async () => {
    startTrial();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(reply({}, 429))
      .mockResolvedValueOnce(new Response("not json", { status: 200 }))
      .mockResolvedValueOnce(reply({ nothing: true }))
      .mockResolvedValueOnce(reply({ completion: " ok" }));
    const svc = service(SMART, fetcher as unknown as typeof fetch);
    expect(await svc.complete({ ...request, prefix: "a" })).toEqual({ ok: false, reason: "busy" });
    expect(await svc.complete({ ...request, prefix: "b" })).toEqual({ ok: false, reason: "failed" });
    expect(await svc.complete({ ...request, prefix: "c" })).toEqual({ ok: false, reason: "failed" });
    expect(await svc.complete({ ...request, prefix: "d" })).toMatchObject({ ok: true });
  });

  it("answers an identical question again from memory without calling anyone", async () => {
    startTrial();
    const fetcher = vi.fn(async () => reply({ completion: " the failing tests" }));
    const svc = service(SMART, fetcher as unknown as typeof fetch);
    await svc.complete(request);
    expect(await svc.complete(request)).toMatchObject({ ok: true, completion: " the failing tests", cached: true, ms: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gives up when the person stops waiting", async () => {
    startTrial();
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const controller = new AbortController();
    const pending = service(SMART, fetcher as unknown as typeof fetch).complete(request, controller.signal);
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "busy" });
  });

  it("limits how many questions are out at once", async () => {
    startTrial();
    const release: Array<() => void> = [];
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => release.push(() => resolve(reply({ completion: " x" })))));
    const svc = service(SMART, fetcher as unknown as typeof fetch);
    const open = Array.from({ length: TYPING_MAX_IN_FLIGHT }, (_, index) => svc.complete({ ...request, prefix: `q${index}` }));
    expect(await svc.complete({ ...request, prefix: "one too many" })).toEqual({ ok: false, reason: "busy" });
    release.forEach((go) => go());
    expect((await Promise.all(open)).every((result) => result.ok)).toBe(true);
  });
});

describe("the person's own Cloudflare account", () => {
  const cfg = { features: { smarterSuggestions: true }, typing: { accountId: ACCOUNT, token: "cf-token" } } as AppConfig;

  it("calls Workers AI directly with the person's token and a small chat", async () => {
    const fetcher = vi.fn(async () => reply({ result: { response: " the failing tests" }, success: true }));
    const result = await service(cfg, fetcher as unknown as typeof fetch).complete(request);
    expect(result).toMatchObject({ ok: true, completion: " the failing tests", source: "cloudflare" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/${TYPING_DEFAULT_MODEL}`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer cf-token");
    const sent = JSON.parse(String(init.body));
    expect(sent.max_tokens).toBe(TYPING_MAX_OUTPUT_TOKENS);
    expect(sent.temperature).toBeLessThanOrEqual(0.3);
    expect(sent.messages[1].content).toContain("Rex: Two tests fail.");
  });

  it("says the token is refused without pausing the other service", async () => {
    const svc = service(cfg, (async () => reply({ errors: [{ code: 10000 }] }, 401)) as unknown as typeof fetch);
    expect(await svc.complete(request)).toEqual({ ok: false, reason: "refused" });
  });

  it("checks a draft account and token before they are saved", async () => {
    const fetcher = vi.fn(async () => reply({ result: { response: "ok" } }));
    const svc = service(SMART, fetcher as unknown as typeof fetch);
    expect(await svc.test({ accountId: ACCOUNT, token: "draft-token" })).toMatchObject({ ok: true });
    expect(new Headers((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get("authorization")).toBe("Bearer draft-token");
    expect(await svc.test({ accountId: "short", token: "x" })).toEqual({ ok: false, reason: "failed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("smarter suggestions are opt-in", () => {
  const ownAccount = { typing: { accountId: ACCOUNT, token: "cf-token" } } as AppConfig;

  it("sends nothing by default, with a trial, a plan or the person's own Cloudflare account", async () => {
    startTrial();
    const fetcher = vi.fn();
    for (const cfg of [{} as AppConfig, ownAccount, { features: { typingSuggestions: true } } as AppConfig, { features: { smarterSuggestions: false } } as AppConfig]) {
      expect(await service(cfg, fetcher as unknown as typeof fetch).complete(request)).toEqual({ ok: false, reason: "not-allowed" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("says so in Settings, and an existing config without the switch stays off", () => {
    expect(describeTyping({} as AppConfig, null, false).smarter).toBe(false);
    expect(describeTyping({ features: { typingSuggestions: true, cloudDictation: true } } as AppConfig, null, false).smarter).toBe(false);
    expect(describeTyping(SMART, null, false).smarter).toBe(true);
  });

  it("calls out once the person turns it on, and stops again when they turn it off", async () => {
    startTrial();
    const fetcher = vi.fn(async () => reply({ completion: " the failing tests" }));
    const cfg = { features: { smarterSuggestions: false } } as AppConfig;
    const svc = createTypingService({ config: () => cfg, fetch: fetcher as unknown as typeof fetch });
    expect(await svc.complete(request)).toEqual({ ok: false, reason: "not-allowed" });
    cfg.features!.smarterSuggestions = true;
    expect(await svc.complete(request)).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    cfg.features!.smarterSuggestions = false;
    expect(await svc.complete({ ...request, prefix: "Please fix it" })).toEqual({ ok: false, reason: "not-allowed" });
    expect(await svc.complete(request)).toEqual({ ok: false, reason: "not-allowed" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("when nothing is sent", () => {
  it("is off after the person turns it off", async () => {
    startTrial();
    const fetcher = vi.fn();
    const result = await service({ features: { typingSuggestions: false, smarterSuggestions: true } } as AppConfig, fetcher as unknown as typeof fetch).complete(request);
    expect(result).toEqual({ ok: false, reason: "off" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("has no service for a self-hoster who has not set one up", async () => {
    const fetcher = vi.fn();
    expect(await service(SMART, fetcher as unknown as typeof fetch).complete(request)).toEqual({ ok: false, reason: "no-service" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not send text that looks like a secret", async () => {
    startTrial();
    const fetcher = vi.fn();
    const result = await service(SMART, fetcher as unknown as typeof fetch).complete({ ...request, prefix: `my key is sk-${"a1".repeat(16)}` });
    expect(result).toEqual({ ok: false, reason: "sensitive" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
