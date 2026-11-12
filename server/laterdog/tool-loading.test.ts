import { describe, expect, it } from "vitest";

import { availableTools, type CatalogProfile } from "../drivers/agents-catalog.ts";
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import {
  AGENTS_DEFER_RARE_ENV,
  ALWAYS_LOAD_META,
  CORE_AGENT_TOOLS,
  RARE_AGENT_TOOLS,
  agentsServerLaunch,
  deferRareToolsEnabled,
  withToolLoading,
} from "./tool-loading.ts";

const everything: CatalogProfile = {
  skillAuthoring: true, sharedComputers: true, voiceNotes: true, cloudHome: true, emailMe: true, phone: true,
  memoryEnabled: true, insideTask: false, botId: WATCHER_OPTIONS_CARD_BOT_ID,
};
const plain: CatalogProfile = { skillAuthoring: false, sharedComputers: false, voiceNotes: false, cloudHome: false, memoryEnabled: true, insideTask: true, botId: "b" };

describe("tool loading", () => {
  it("puts every later.dog tool in exactly one group and names no tool that does not exist", () => {
    const names = availableTools(everything).map((tool) => tool.name);
    const grouped = [...CORE_AGENT_TOOLS, ...RARE_AGENT_TOOLS];
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...names].sort()).toEqual([...grouped].sort());
  });

  it("is on unless the setting turns it off, and changes nothing when off", () => {
    const tools = availableTools(everything);
    expect(withToolLoading(tools, {})).toEqual(tools);
    expect(deferRareToolsEnabled({})).toBe(true);
    expect(deferRareToolsEnabled({ LATERDOG_DEFER_RARE_TOOLS: "0" })).toBe(false);
    const server = { command: "node", args: ["proxy.js"], env: { LATERDOG_BOT_ID: "b" } };
    expect(agentsServerLaunch(server, false)).toEqual({ ...server, alwaysLoad: true });
  });

  it("marks only the rare tools for loading on demand, the same way every turn", () => {
    const env = { [AGENTS_DEFER_RARE_ENV]: "1" };
    for (const profile of [everything, plain]) {
      const tools = availableTools(profile);
      const first = withToolLoading(tools, env);
      expect(JSON.stringify(withToolLoading(availableTools(profile), env))).toBe(JSON.stringify(first));
      for (const tool of first) {
        const meta = (tool as { _meta?: Record<string, unknown> })._meta;
        if (RARE_AGENT_TOOLS.includes(tool.name)) expect(meta).toEqual({ [ALWAYS_LOAD_META]: false });
        else expect(tool).toEqual(tools.find((original) => original.name === tool.name));
      }
    }
    expect(deferRareToolsEnabled({ LATERDOG_DEFER_RARE_TOOLS: "1" })).toBe(true);
    expect(agentsServerLaunch({ command: "node", args: [], env: { A: "1" } }, true)).toEqual({
      command: "node", args: [], env: { A: "1", [AGENTS_DEFER_RARE_ENV]: "1" }, alwaysLoad: true,
    });
  });
});
