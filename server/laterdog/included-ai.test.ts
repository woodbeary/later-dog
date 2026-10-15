import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectDefaultModelSelection, type SelectableInstance } from "../default-model-selection.ts";
import { instanceConfigs } from "../config.ts";
import { INCLUDED_AI_INSTANCE, INCLUDED_BACKGROUND_MODEL, INCLUDED_GROK_INSTANCE, IncludedAiDriver, IncludedGrokDriver, includedAiError, includedSelectionNow } from "./included-ai.ts";
import { moveRetiredIncludedDefault, moveRetiredIncludedModels } from "./included-ai-moves.ts";

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
    expect(instanceConfigs({} as never)[INCLUDED_AI_INSTANCE]).toMatchObject({ driver: "laterdogAi", displayName: "Claude", icon: { kind: "preset", preset: "anthropic" } });
    expect(instanceConfigs({} as never).laterdogGrok).toMatchObject({ driver: "laterdogGrok", displayName: "Grok", icon: { kind: "preset", preset: "xai" } });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const instance = await create();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: "Start the free trial to use the free models." });
    expect(fetcher).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("answers through later.dog's relay with the trial key once the trial is live", async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { role: "assistant", content: "Hi!" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    vi.stubGlobal("fetch", fetcher);
    const instance = await create();
    startTrial();
    expect((await instance.snapshot()).state).toBe("available");
    const text = await instance.generateText?.({ prompt: "Say hi" } as never);
    expect(String(text)).toContain("Hi!");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.later.dog/v1/ai/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init.body)).model).toBe(INCLUDED_BACKGROUND_MODEL);
    await instance.dispose();
  });
});

describe("the free models", () => {
  it("are Claude Sonnet 5, and Grok 4.7 and 4.6, each by its provider's name", () => {
    expect(IncludedAiDriver.metadata.displayName).toBe("Claude");
    expect(IncludedAiDriver.models).toEqual({ default: "claude-sonnet-5", options: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 256_000 }] });
    expect(IncludedGrokDriver.metadata.displayName).toBe("Grok");
    expect(IncludedGrokDriver.models.default).toBe("grok-4.7");
    expect(IncludedGrokDriver.models.options.map((option) => [option.id, option.label])).toEqual([["grok-4.7", "Grok 4.7"], ["grok-4.6", "Grok 4.6"]]);
  });

  it("move a dog on a retired free model to the current one, and leave everything else alone", () => {
    expect(includedSelectionNow({ instanceId: INCLUDED_AI_INSTANCE, model: "kimi-k2.6" })).toEqual({ instanceId: INCLUDED_AI_INSTANCE, model: "claude-sonnet-5" });
    expect(includedSelectionNow({ instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.3", effort: "high" })).toEqual({ instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.7", effort: "high" });
    const kept = { instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.6" };
    expect(includedSelectionNow(kept)).toBe(kept);
    const own = { instanceId: "claude", model: "kimi-k2.6" };
    expect(includedSelectionNow(own)).toBe(own);
  });

  it("move saved dogs, their threads, their fallbacks and the new-dog default once, at start", () => {
    const bots = [
      { id: "a", modelSelection: { instanceId: INCLUDED_AI_INSTANCE, model: "kimi-k2.6" }, fallback: [{ instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.3" }, { instanceId: "codex", model: "gpt" }],
        tasks: [{ threadId: "t1", modelSelection: { instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.3" } }, { threadId: "t2" }, { threadId: "t3", modelSelection: { instanceId: "claude", model: "opus" } }] },
      { id: "b", modelSelection: { instanceId: "claude", model: "sonnet" }, tasks: [] },
    ];
    const patchBot = vi.fn();
    const patchTask = vi.fn();
    const store = { bots, patchBot, patchTask } as never;
    expect(moveRetiredIncludedModels(store)).toBe(2);
    expect(patchBot).toHaveBeenCalledTimes(1);
    expect(patchBot).toHaveBeenCalledWith("a", {
      modelSelection: { instanceId: INCLUDED_AI_INSTANCE, model: "claude-sonnet-5" },
      fallback: [{ instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.7" }, { instanceId: "codex", model: "gpt" }],
    });
    expect(patchTask).toHaveBeenCalledWith("a", "t1", { modelSelection: { instanceId: INCLUDED_GROK_INSTANCE, model: "grok-4.7" } });
    expect(patchTask).toHaveBeenCalledTimes(1);

    const cfg = { defaultModelSelection: { instanceId: INCLUDED_AI_INSTANCE, model: "kimi-k2.6" }, newBotDefaults: { profile: { modelSelection: { instanceId: INCLUDED_AI_INSTANCE, model: "kimi-k2.6" } } } } as never as Parameters<typeof moveRetiredIncludedDefault>[0];
    const save = vi.fn();
    expect(moveRetiredIncludedDefault(cfg, save)).toBe(true);
    expect(save).toHaveBeenCalledWith({ defaultModelSelection: { instanceId: INCLUDED_AI_INSTANCE, model: "claude-sonnet-5" } });
    expect(cfg.defaultModelSelection).toEqual({ instanceId: INCLUDED_AI_INSTANCE, model: "claude-sonnet-5" });
    expect(cfg.newBotDefaults?.profile.modelSelection).toEqual({ instanceId: INCLUDED_AI_INSTANCE, model: "claude-sonnet-5" });
    expect(moveRetiredIncludedDefault(cfg, save)).toBe(false);
    expect(moveRetiredIncludedDefault({}, save)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
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

  it("is the free Claude before the free Grok, whatever order they are listed in", () => {
    const free = (instanceId: string, driverKind: string, models: SelectableInstance["models"]): SelectableInstance => ({ ...engine(instanceId, driverKind), models });
    const picked = selectDefaultModelSelection([free(INCLUDED_GROK_INSTANCE, "laterdogGrok", IncludedGrokDriver.models), free(INCLUDED_AI_INSTANCE, "laterdogAi", IncludedAiDriver.models)]);
    expect(picked).toEqual({ instanceId: INCLUDED_AI_INSTANCE, model: "claude-sonnet-5" });
  });
});

describe("when later.dog AI can't answer", () => {
  it("says what happened and what to do next, never a raw HTTP error", () => {
    expect(includedAiError(429, JSON.stringify({ error: { code: "daily_limit", message: "x" } }))).toContain("used today's free messages");
    expect(includedAiError(503, JSON.stringify({ error: { code: "busy_today", message: "x" } }))).toContain("at today's limit for everyone");
    expect(includedAiError(401, "{}")).toBe("Your free trial has ended. Sign in to Claude or ChatGPT to keep going.");
    expect(includedAiError(503, "{}")).toContain("busy right now");
    expect(includedAiError(413, JSON.stringify({ error: { code: "too_large" } }))).toContain("too much for the free model");
    expect(includedAiError(400, "{}")).toBeUndefined();
  });

  it("says the trial has ended instead of offering one that's gone", async () => {
    writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true, ended: true }));
    const instance = await create();
    expect((await instance.snapshot()).reason).toContain("has ended");
    await instance.dispose();
  });
});
