import { PROFILE_PROMPT, ROUTINE_PROMPT } from "../system-prompt.ts";
import { GOOGLE_PROMPT } from "./google.ts";
import { signInPassage } from "./sign-in-passage.ts";

export interface AgentRulesInput {
  agents: boolean;
  secureForm: boolean;
  google: boolean;
}

export function agentRuleTexts(input: AgentRulesInput): { credential: string; routine: string; profile: string } {
  if (!input.agents) return { credential: "", routine: "", profile: "" };
  return {
    credential: signInPassage({ secureForm: input.secureForm }) + (input.google ? `\n${GOOGLE_PROMPT.trim()}` : ""),
    routine: ROUTINE_PROMPT,
    profile: PROFILE_PROMPT,
  };
}
