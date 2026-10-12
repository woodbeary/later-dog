import { z } from "zod";

export const scriptedToolCallSchema = z.object({
  tool: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  expectError: z.boolean().optional(),
});

export const scriptedTurnSchema = z.object({
  steps: z.array(scriptedToolCallSchema).optional(),
  reply: z.string().optional(),
  gate: z.string().optional(),
  delayMs: z.number().optional(),
  fail: z.boolean().optional(),
});

export const fixtureSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  defaultEnabled: z.boolean().default(true),
  triggerTerms: z.array(z.string()).min(1),
  requiredCapabilities: z.array(z.string()).default([]),
  skillMd: z.string(),
});

export const scenarioBotSchema = z.object({
  key: z.string(),
  name: z.string(),
  section: z.string().optional(),
  chiefOfStaff: z.boolean().optional(),
  managedSections: z.array(z.string()).optional(),
  acknowledgePeerScope: z.boolean().optional(),
  computer: z.enum(["vm", "browser", "off"]).optional(),
  browser: z.boolean().optional(),
  turns: z.array(scriptedTurnSchema),
});

export const stepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), bot: z.string(), text: z.string() }),
  z.object({ kind: z.literal("waitForTurns"), bot: z.string(), count: z.number().int(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("waitForNodeStatus"), bot: z.string(), status: z.string(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("waitForBusy"), bot: z.string(), busy: z.boolean(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("waitForActivity"), bot: z.string(), namePrefix: z.string(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("createRoutine"), routine: z.string(), bot: z.string(), prompt: z.string() }),
  z.object({ kind: z.literal("runRoutine"), routine: z.string() }),
  z.object({ kind: z.literal("snapshotRoutineRun"), routine: z.string(), saveAs: z.string() }),
  z.object({ kind: z.literal("waitForRoutineRun"), routine: z.string(), status: z.string(), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("writeGate"), gate: z.string() }),
  z.object({ kind: z.literal("installSkill"), skill: fixtureSkillSchema }),
  z.object({ kind: z.literal("setConfig"), config: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("setSkillAssignment"), bot: z.string(), skills: z.array(z.string()) }),
  z.object({ kind: z.literal("setVmState"), state: z.record(z.string(), z.unknown()) }),
  z.object({ kind: z.literal("consumeDump"), timeoutMs: z.number().optional() }),
  z.object({ kind: z.literal("captureComputer"), bot: z.string() }),
  z.object({ kind: z.literal("pollComputerGate"), bot: z.string(), saveAs: z.string() }),
]);

export const assertionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sendNotQueued"), bot: z.string() }),
  z.object({ kind: z.literal("toolCalls"), bot: z.string(), equals: z.array(scriptedToolCallSchema) }),
  z.object({ kind: z.literal("toolNames"), bot: z.string(), equals: z.array(z.string()) }),
  z.object({ kind: z.literal("turnOrder"), bots: z.array(z.string()) }),
  z.object({ kind: z.literal("instructionsInclude"), bot: z.string(), turn: z.number().int(), includes: z.string() }),
  z.object({ kind: z.literal("systemPromptIncludes"), bot: z.string(), turn: z.number().int(), includes: z.string() }),
  z.object({ kind: z.literal("systemPromptOmits"), bot: z.string(), turn: z.number().int(), omits: z.string() }),
  z.object({ kind: z.literal("promptIncludes"), bot: z.string(), turn: z.number().int(), includes: z.string() }),
  z.object({
    kind: z.literal("handoffTree"),
    equals: z.array(z.object({ bot: z.string(), status: z.string(), hasParent: z.boolean().optional() })),
  }),
  z.object({ kind: z.literal("transcriptIncludes"), bot: z.string(), thread: z.enum(["active", "node"]), text: z.string() }),
  z.object({
    kind: z.literal("gateAnswer"),
    of: z.string(),
    held: z.boolean().optional(),
    blockedReasonIncludes: z.string().optional(),
    blockedReasonOmits: z.string().optional(),
    httpStatus: z.number().int().optional(),
  }),
  z.object({ kind: z.literal("routineRunSnapshot"), of: z.string(), status: z.string(), deferred: z.boolean() }),
  z.object({ kind: z.literal("activitySeen"), bot: z.string(), namePrefix: z.string() }),
  z.object({ kind: z.literal("noActivityPrefix"), bot: z.string(), prefix: z.string() }),
  z.object({ kind: z.literal("activityCount"), bot: z.string(), prefix: z.string(), count: z.number().int() }),
]);

export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  behavior: z.string(),
  issue: z.number().optional(),
  world: z.enum(["coordination", "localVm"]),
  gates: z.array(z.string()).default([]),
  librarySkills: z.array(z.object({ name: z.string(), instructions: z.string() })).default([]),
  bots: z.array(scenarioBotSchema),
  steps: z.array(stepSchema),
  assertions: z.array(assertionSchema),
  golden: z.object({ from: z.literal("redacted-thread"), redactor: z.number().int() }).optional(),
});

export type ScriptedToolCall = z.infer<typeof scriptedToolCallSchema>;
export type ScriptedTurn = z.infer<typeof scriptedTurnSchema>;
export type FixtureSkill = z.infer<typeof fixtureSkillSchema>;
export type ScenarioBot = z.infer<typeof scenarioBotSchema>;
export type Step = z.infer<typeof stepSchema>;
export type Assertion = z.infer<typeof assertionSchema>;
export type Scenario = z.infer<typeof scenarioSchema>;
