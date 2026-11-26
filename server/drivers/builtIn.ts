import type { AnyProviderDriver } from "../contracts.ts";
import { ClaudeDriver } from "./claude.ts";
import { CodexDriver } from "./codex.ts";
import { GrokDriver } from "./grok.ts";
import { GrokAgentDriver } from "./acp/grok.ts";
import { CursorAgentDriver } from "./acp/cursor.ts";
import { GeminiAgentDriver } from "./acp/gemini.ts";
import { AntigravityDriver } from "./antigravity.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";
import { IncludedAiDriver, IncludedGrokDriver } from "../laterdog/included-ai.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [
  ClaudeDriver,
  CodexDriver,
  GrokAgentDriver,
  CursorAgentDriver,
  GeminiAgentDriver,
  AntigravityDriver,
  IncludedAiDriver,
  IncludedGrokDriver,
  GrokDriver,
  OpenAICompatDriver,
];
