import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectDefaultModelSelection, type SelectableInstance } from "../default-model-selection.ts";
import { instanceConfigs } from "../config.ts";
import { INCLUDED_AI_INSTANCE, IncludedAiDriver } from "./included-ai.ts";

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
  writeFileSync(join(home, "computers-trial.json"), JSON.stringify({ api: "https://cloud.later.dog/v1", confirmed: true }));
  writeFileSync(join(home, "computers-trial-key"), `${KEY}\n`);
};
const create = () => IncludedAiDriver.create({ instanceId: INCLUDED_AI_INSTANCE, displayName: "later.dog AI", enabled: true, config: {}, environment: {} });

describe("later.dog AI", () => {
  it("is in every fleet, and waits for the free trial without calling anyone", async () => {
    expect(instanceConfigs({} as never)[INCLUDED_AI_INSTANCE]).toMatchObject({ driver: "laterdogAi", displayName: "later.dog AI" });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const instance = await create();
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable", reason: "Start the free trial to use later.dog AI." });
    expect(fetcher).not.toHaveBeenCalled();
    await instance.dispose();
  });

  it("answers through later.dog's relay with the trial key once the trial is live", async () => {
    const fetcher = vi.fn(async () => Response.json({ choices: [{ message: { role: "assistant", content: "Hi!" } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }));
    vi.stubGlobal("fetch", fetcher);
    const instance = await create();
    startTrial();
    expect((await instance.snapshot()).state).toBe("available");
    const text = await instance.generateText?.({ prompt: "Say hi", model: "later-dog" } as never);
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
