import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectDefaultModelSelection, type SelectableInstance } from "../default-model-selection.ts";
import { instanceConfigs } from "../config.ts";
import { INCLUDED_AI_INSTANCE, IncludedAiDriver, IncludedGrokDriver, includedAiError } from "./included-ai.ts";

const KEY = `ldt_${"b".repeat(43)}`;
let home: string;
let before: string | undefined;

beforeEach(() => {
  before = process.env.LATERDOG_HOME;
  home = mkdtempSync(join(tmpdir(), "ld-included-ai-"));
  process.env.LATERDOG_HOME = home;
});
afterEach(() => {
  if (before === undefined) delete process.env.LATERDOG_HOME;
  else process.env.LATERDOG_HOME = before;
  rmSync(home, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

const startTrial = () => {
  writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true, included: ["decisions", "voice", "ai"] }));
  writeFileSync(join(home, "computers-trial-key"), `${KEY}\n`);
};
const create = () => IncludedAiDriver.create({ instanceId: INCLUDED_AI_INSTANCE, displayName: "later.dog AI", enabled: true, config: {}, environment: {} });

describe("later.dog AI", () => {
  it("is in every fleet, and waits for the free trial without calling anyone", async () => {
    expect(instanceConfigs({} as never)[INCLUDED_AI_INSTANCE]).toMatchObject({ driver: "laterdogAi", displayName: "Kimi" });
    expect(instanceConfigs({} as never).laterdogGrok).toMatchObject({ driver: "laterdogGrok", displayName: "Grok (free)" });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const instance = await create();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: "Start the free trial to use the free models." });
    expect(fetcher).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("keeps the free Grok's own name, so a signed-in Grok account is never taken for it", () => {
    const saved = instanceConfigs({ instances: { claude: { driver: "claudeAgent" }, grok: { driver: "grokAgent", displayName: "Grok" }, laterdogGrok: { driver: "laterdogGrok", displayName: "Grok" } } } as never);
    expect(saved.laterdogGrok).toMatchObject({ driver: "laterdogGrok", displayName: "Grok (free)" });
    expect(saved.grok).toMatchObject({ driver: "grokAgent", displayName: "Grok" });
  });

  it("answers through later.dog's relay with the trial key once the trial is live", async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { role: "assistant", content: "Hi!" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    vi.stubGlobal("fetch", fetcher);
    const instance = await create();
    startTrial();
    expect((await instance.snapshot()).state).toBe("available");
    const text = await instance.generateText?.({ prompt: "Say hi", model: "kimi-k2.6" } as never);
    expect(String(text)).toContain("Hi!");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.later.dog/v1/ai/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    await instance.dispose();
  });
});

describe("the engine a new dog gets", () => {
  const engine = (instanceId: string, driverKind: string): SelectableInstance => ({
    instanceId, driverKind, snapshot: { state: "available", authenticated: true } as never, models: { default: "m", options: [{ id: "m", label: "m" }] },
  });
  it("is later.dog AI only when nothing of the person's own can run", () => {
    expect(selectDefaultModelSelection([engine(INCLUDED_AI_INSTANCE, "laterdogAi"), engine("codex", "codex")]).instanceId).toBe("codex");
    expect(selectDefaultModelSelection([engine(INCLUDED_AI_INSTANCE, "laterdogAi"), engine("claude", "claudeAgent")]).instanceId).toBe("claude");
    expect(selectDefaultModelSelection([engine(INCLUDED_AI_INSTANCE, "laterdogAi")]).instanceId).toBe(INCLUDED_AI_INSTANCE);
  });
});

describe("when later.dog AI can't answer", () => {
  it("says what happened and what to do next, never a raw HTTP error", () => {
    expect(includedAiError(429, JSON.stringify({ error: { code: "daily_limit", message: "x" } }))).toContain("used today's free messages");
    expect(includedAiError(503, JSON.stringify({ error: { code: "busy_today", message: "x" } }))).toContain("at today's limit for everyone");
    expect(includedAiError(401, "{}")).toBe("Your free trial has ended. Sign in to Claude, ChatGPT, Grok or Cursor to keep going.");
    expect(includedAiError(503, "{}")).toContain("busy right now");
    expect(includedAiError(413, JSON.stringify({ error: { code: "too_large" } }))).toContain("too much for the free model");
    expect(includedAiError(413, JSON.stringify({ error: { code: "prompt_too_large" } }))).toBe("This chat is now too long for the free model. Start a new chat, or sign in to Claude, ChatGPT, Grok or Cursor to keep going here.");
    expect(includedAiError(400, "{}")).toBeUndefined();
  });

  it("never tells someone on a later.dog Cloud home that a free trial ended or needs starting", async () => {
    const role = process.env.LATERDOG_CLOUD_ROLE;
    process.env.LATERDOG_CLOUD_ROLE = "home";
    try {
      expect(includedAiError(401, "{}")).toBe("The free models on your later.dog Cloud are renewing. Try again a little later, or sign in to Claude, ChatGPT, Grok or Cursor.");
      const instance = await create();
      const { reason } = await instance.snapshot();
      expect(reason).toBe("The free models are still being set up on your later.dog Cloud. Try again in a minute, or sign in to Claude, ChatGPT, Grok or Cursor.");
      await instance.dispose();
    } finally {
      if (role === undefined) delete process.env.LATERDOG_CLOUD_ROLE;
      else process.env.LATERDOG_CLOUD_ROLE = role;
    }
  });

  it("names the free Grok without claiming a model version the service may not run", () => {
    expect(IncludedGrokDriver.models.options.map((option) => option.label)).toEqual(["Grok (free)"]);
  });

  it("says the trial has ended instead of offering one that's gone", async () => {
    writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true, ended: true }));
    const instance = await create();
    expect((await instance.snapshot()).reason).toContain("has ended");
    await instance.dispose();
  });
});
