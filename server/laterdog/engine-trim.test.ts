import { rmSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

import { SHOWN_ENGINES } from "../../shared/account-engines.ts";
import { DATA_DIR, instanceConfigs, persistableInstanceConfigs, type AppConfig } from "../config.ts";
import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { Store } from "../store.ts";
import { MAC_RELAY_INSTANCE_ID } from "./mac-relay.ts";
import { OFFERED_DRIVERS, RETIRED_DRIVERS, retiredEngineMoveText, retiredInstanceIds, withoutRetiredEngines } from "./engine-trim.ts";

describe("the engines later.dog offers", () => {
  it("registers exactly Claude, ChatGPT, Grok, Cursor, the included AI, the two API-key drivers and the Mac relay", () => {
    const registered = BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort();
    expect(registered).toEqual([...OFFERED_DRIVERS, MAC_RELAY_INSTANCE_ID].sort());
    expect(OFFERED_DRIVERS.has(MAC_RELAY_INSTANCE_ID)).toBe(false);
    for (const engine of SHOWN_ENGINES) expect(registered).toContain(engine);
    for (const driver of RETIRED_DRIVERS) expect(registered).not.toContain(driver);
  });

  it("builds no fleet entry for a retired engine, fresh or saved", () => {
    const saved: AppConfig = {
      instances: {
        claude: { driver: "claudeAgent" },
        gemini: { driver: "geminiAgent" },
        kimi: { driver: "kimiAgent" },
        myPi: { driver: "piAgent", displayName: "My Pi" },
        openrouter: { driver: "openai-compat", config: { url: "https://openrouter.ai/api/v1" } },
        groq: { driver: "openai-compat", config: { url: "https://api.groq.com/openai/v1" } },
        future: { driver: "fixture-future-driver" },
      },
    };
    for (const map of [instanceConfigs({}), instanceConfigs(saved), persistableInstanceConfigs(saved)]) {
      expect(Object.values(map).map((entry) => entry.driver).filter((driver) => RETIRED_DRIVERS.has(driver))).toEqual([]);
      for (const id of ["gemini", "kimi", "myPi", "openrouter", "openaiCompat", "mistral", "qwen", "hermes", "pi", "opencodeGo"]) {
        expect(map, id).not.toHaveProperty(id);
      }
    }
    expect(instanceConfigs(saved)).toHaveProperty("groq");
    expect(instanceConfigs(saved)).toHaveProperty("future");
    expect(saved.instances).toHaveProperty("gemini");
  });
});

describe("which saved ids are retired", () => {
  it("names the old built-in ids and every saved id on a retired driver", () => {
    const fresh = retiredInstanceIds(undefined);
    for (const id of ["kimi", "droid", "antigravity", "opencodeGo", "openaiCompat", "openrouter", "mistral", "cerebras", "qwen", "hermes", "pi"]) {
      expect(fresh.has(id), id).toBe(true);
    }
    expect([...retiredInstanceIds({ claude: { driver: "claudeAgent" }, work: { driver: "geminiAgent" } })]).toContain("work");
  });

  it("keeps an old built-in id the person reused for an offered engine, and never names an offered one", () => {
    const ids = retiredInstanceIds({
      kimi: { driver: "claudeAgent" },
      openrouter: { driver: "grok" },
      openaiCompat: { driver: "openai-compat" },
      claude: { driver: "claudeAgent" },
      codex: { driver: "codex" },
      cursor: { driver: "cursorAgent" },
      grok: { driver: "grokAgent" },
    });
    expect(ids.has("kimi")).toBe(false);
    expect(ids.has("openrouter")).toBe(false);
    expect(ids.has("openaiCompat")).toBe(true);
    for (const id of ["claude", "codex", "cursor", "grok", "laterdogAi", "laterdogGrok", "openai", "xaiApi", "claudeApi"]) {
      expect(ids.has(id), id).toBe(false);
    }
  });

  it("leaves the Computer engine to its own move", () => {
    expect(retiredInstanceIds({ computer: { driver: "boxAgent" } }).has("computer")).toBe(false);
    expect(withoutRetiredEngines({ claude: { driver: "claudeAgent" }, hermes: { driver: "hermesAgent" } }, undefined)).toEqual({
      claude: { driver: "claudeAgent" },
    });
  });
});

describe("moving saved dogs off a retired engine", () => {
  beforeEach(() => { rmSync(DATA_DIR, { recursive: true, force: true }); });
  const newBotDefault = () => ({ instanceId: "claude", model: "claude-model" });
  const included = { instanceId: "laterdogAi", model: "kimi-k2.6" };
  const chatOnly = { driverKind: "laterdogAi", canWorkOnCloud: false, keepCloud: () => false };

  it("moves a dog saved on Gemini onto the included AI, keeps its history, and leaves a Claude dog alone", () => {
    const store = new Store(newBotDefault);
    const gemini = store.createBot({ modelSelection: { instanceId: "gemini", model: "gemini-3-pro" } }, { seedMessages: false });
    store.appendMessage(gemini.threadId, { role: "user", kind: "text", text: "REMEMBER_BEFORE_TRIM" });
    store.patchBot(gemini.id, { fallback: [{ instanceId: "openrouter", model: "x" }, { instanceId: "claude", model: "claude-model" }] });
    const claude = store.createBot({ modelSelection: { instanceId: "claude", model: "claude-model" } }, { seedMessages: false });
    const retired = retiredInstanceIds({ claude: { driver: "claudeAgent" }, gemini: { driver: "geminiAgent" } });

    const moves = store.retireInstances(retired, included, chatOnly);
    expect(moves).toEqual([{ botId: gemini.id, threadId: gemini.threadId, scope: "bot", cloud: false, noComputer: false, askNow: false }]);

    const reloaded = new Store(newBotDefault);
    expect(reloaded.bot(gemini.id)?.modelSelection).toEqual(included);
    expect(reloaded.taskByThread(gemini.id, gemini.threadId)?.modelSelection ?? included).toEqual(included);
    expect(reloaded.bot(gemini.id)?.fallback).toEqual([{ instanceId: "claude", model: "claude-model" }]);
    expect(reloaded.messagesFor(gemini.threadId).some((message) => message.text === "REMEMBER_BEFORE_TRIM")).toBe(true);
    expect(reloaded.bot(claude.id)?.modelSelection).toEqual({ instanceId: "claude", model: "claude-model" });
    expect(reloaded.retireInstances(retired, included, chatOnly)).toEqual([]);
  });

  it("moves dogs on the old default-fleet ids even when nothing was ever saved", () => {
    const store = new Store(newBotDefault);
    const kimi = store.createBot({ modelSelection: { instanceId: "kimi", model: "kimi-code" } }, { seedMessages: false });
    const pi = store.createBot({ modelSelection: { instanceId: "pi", model: "pi-model" } }, { seedMessages: false });
    expect(store.retireInstances(retiredInstanceIds(undefined), included, chatOnly).map((move) => move.botId).sort())
      .toEqual([kimi.id, pi.id].sort());
    const reloaded = new Store(newBotDefault);
    expect(reloaded.bot(kimi.id)?.modelSelection).toEqual(included);
    expect(reloaded.bot(pi.id)?.modelSelection).toEqual(included);
  });

  it("says plainly what changed", () => {
    expect(retiredEngineMoveText({ scope: "bot", cloud: false, askNow: false }, "Scout", "Kimi"))
      .toBe("Scout now uses Kimi. The model it used before is no longer offered.");
    expect(retiredEngineMoveText({ scope: "bot", cloud: true, askNow: true }, "Scout", "Kimi"))
      .toBe("Scout now uses Kimi. The model it used before is no longer offered. Scout still works on its cloud computer. Its permissions are now Ask.");
  });
});
