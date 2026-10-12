import { z } from "zod";
import { assertionSchema, stepSchema } from "../types.ts";

export const liveBotSchema = z.object({
  key: z.string(),
  name: z.string(),
  section: z.string().optional(),
  chiefOfStaff: z.boolean().optional(),
  managedSections: z.array(z.string()).optional(),
});

export const liveInvariantSchema = z.union([
  assertionSchema,
  z.object({ kind: z.literal("botReplied"), bot: z.string(), thread: z.enum(["active", "node"]) }),
]);

export const liveScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  behavior: z.string(),
  bots: z.array(liveBotSchema),
  steps: z.array(stepSchema),
  invariants: z.array(liveInvariantSchema),
  judged: z.object({ prompt: z.string() }).optional(),
});

export type LiveBot = z.infer<typeof liveBotSchema>;
export type LiveInvariant = z.infer<typeof liveInvariantSchema>;
export type LiveScenario = z.infer<typeof liveScenarioSchema>;

export const liveConfigSchema = z.object({
  minScore: z.number().min(0).max(1),
  maxDrift: z.number().min(0).max(1),
  turnTimeoutMs: z.number().int().min(10_000),
  judgeTimeoutMs: z.number().int().min(10_000),
  maxJudgeRetries: z.number().int().min(0).max(3),
});

export type LiveConfig = z.infer<typeof liveConfigSchema>;

export const liveInstanceSchema = z.object({
  instanceId: z.string().min(1),
  driver: z.string().min(1),
  displayName: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  environmentFrom: z.array(z.string()).optional(),
  model: z.string().min(1),
});

export type LiveInstance = z.infer<typeof liveInstanceSchema>;

export interface LiveCheckResult {
  kind: string;
  pass: boolean;
  detail: string;
}

export interface LiveScenarioOutcome {
  id: string;
  title: string;
  behavior: string;
  checks: LiveCheckResult[];
  score: number;
  error?: string;
}
