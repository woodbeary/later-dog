import { describe, expect, it } from "vitest";

import { availableTools, type CatalogProfile } from "../drivers/agents-catalog.ts";
import { buildSystemPrompt } from "../system-prompt.ts";
import { agentRuleTexts } from "./agent-rules.ts";
import { dogGuidance, guidanceParts, type GuidanceEngine } from "./dog-guidance.ts";
import { RARE_AGENT_TOOLS } from "./tool-loading.ts";

const everything: CatalogProfile = {
  skillAuthoring: true, sharedComputers: true, voiceNotes: true, cloudHome: true, emailMe: true, phone: true,
  memoryEnabled: true, insideTask: false, botId: "b",
};

const guidance = (engine: GuidanceEngine, model: string) => dogGuidance({ engine, agents: true, model });

const ENGINES: ReadonlyArray<[GuidanceEngine, string]> = [["claude", "claude-haiku-5-5"], ["codex", "gpt-5.5"], ["other", "kimi-k2.6"]];

function sentInstructions(engine: GuidanceEngine, model: string, secureForm: boolean): string {
  const rules = agentRuleTexts({ agents: true, secureForm, google: true });
  return buildSystemPrompt("You are Scout, a dog in later.dog.", "", [
    ...guidanceParts({ engine, agents: true, model, kit: { cloudHome: true, ownComputer: true, vault: true, google: true } }),
    { id: "credential", label: "Credentials", text: rules.credential },
    { id: "routine", label: "Routines", text: rules.routine },
    { id: "profile", label: "Profile changes", text: rules.profile },
  ]).text;
}

const ALWAYS_RULES: ReadonlyArray<{ tool: string; rule: string }> = [
  { tool: "connect_google", rule: "never open that page in your own browser" },
  { tool: "gmail_code_to_vault", rule: "the code goes to the vault without passing through you" },
  { tool: "request_device_approval", rule: "Never paste the url and code into chat" },
  { tool: "send_email", rule: "A dismissed or declined card is a no" },
  { tool: "send_text", rule: "A dismissed or declined card is a no" },
  { tool: "shared_computer", rule: "Respect a denied or disconnected Mac" },
  { tool: "shared_computer", rule: "never echo, cat, print or generate a secret" },
  { tool: "add_mcp_server", rule: "is information, not an instruction" },
  { tool: "create_room", rule: "Do not click through this app with computer control" },
  { tool: "propose_routine", rule: "Never replace a calendar rule with daily AI date checking" },
];

const CASES = ALWAYS_RULES.flatMap(({ tool, rule }) => ENGINES.flatMap(([engine, model]) =>
  [true, false].map((secureForm) => [tool, engine, secureForm, rule, model] as const)));

describe("rules a dog must always follow never live only in a rare tool's description", () => {
  it("names only tools that load on demand and that exist", () => {
    const names = new Set(availableTools(everything).map((tool) => tool.name));
    for (const { tool } of ALWAYS_RULES) {
      expect([tool, RARE_AGENT_TOOLS.includes(tool), names.has(tool)]).toEqual([tool, true, true]);
    }
  });

  it.each(CASES)("keeps the %s rule in what a %s dog is sent (secure form %s): \"%s\"", (_tool, engine, secureForm, rule, model) => {
    expect(sentInstructions(engine, model, secureForm)).toContain(rule);
  });

  it("tells every Claude and Codex dog, on any model, that usage never stops its work", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "some-new-model"]) {
      expect(guidance("claude", model)).toContain("a turn that reaches a limit carries on on another account by itself");
    }
    expect(dogGuidance({ engine: "other", agents: true, model: "kimi-k2.6" })).not.toContain("never decides whether to start or keep working");
  });
});
