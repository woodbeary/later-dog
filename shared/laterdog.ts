import { z } from "zod";

export const repoSlug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((s) => ![".",".."].includes(s.split("/")[1]), "Invalid repository name");
export const gitRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/)
  .refine((s) => !s.includes("..") && !s.endsWith(".lock") && !s.endsWith("/") && !s.includes("//"), "Invalid Git ref");
export const scopePath = z.string().min(1).max(300).refine((s) => s === "*" ||
  (!s.startsWith("/") && !s.includes("\\") && !s.split("/").some((p) => ["..", ".git", ""].includes(p))), "Use a relative path prefix or *");
export const commandSchema = z.array(z.string().min(1).max(2000)).min(1).max(30);
export const BACKENDS = ["codex-cloud", "claude-cloud", "laterdog-cloud"] as const;
export type BackendId = typeof BACKENDS[number];
export const repositorySchema = z.object({
  slug: repoSlug,
  environmentId: z.string().trim().min(1).max(200),
  environments: z.partialRecord(z.enum(BACKENDS), z.string().trim().min(1).max(200)).default({}),
  generation: z.enum(["current", "legacy", "unqualified"]).default("unqualified"),
  baseRef: gitRef.default("main"),
  publish: z.boolean().default(true),
  merge: z.boolean().default(false),
  behavioralChecks: z.array(z.string().min(1).max(200)).max(100).default([]),
  verification: z.array(commandSchema).max(20).default([]),
}).strict();
export type Repository = z.infer<typeof repositorySchema>;

export const JOB_COMPUTER_SIZES = ["small", "standard", "large", "xlarge"] as const;
export type JobComputerSize = typeof JOB_COMPUTER_SIZES[number];
export const DEFAULT_JOB_COMPUTER_SIZE: JobComputerSize = "small";
export const JOB_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type JobEffort = typeof JOB_EFFORTS[number];
export const jobModel = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, "Use a model id such as claude-opus-5-5");
export const jobAccount = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);

export const createJobSchema = z.object({
  requestKey: z.string().min(8).max(200),
  repository: repoSlug,
  title: z.string().trim().min(1).max(200),
  brief: z.string().trim().min(1).max(100_000),
  standingInstructions: z.string().max(50_000).default(""),
  writeScopes: z.array(scopePath).min(1).max(40).default(["*"]),
  dependencies: z.array(z.string().uuid()).max(100).default([]),
  profileId: z.string().regex(/^[a-zA-Z0-9_-]+$/).default("default"),
  kind: z.enum(["implementation", "review", "repair"]).default("implementation"),
  conversationId: z.string().max(200).optional(),
  botId: z.string().regex(/^[\w-]+$/).max(100).optional(),
  parentId: z.string().uuid().optional(),
  model: jobModel.optional(),
  effort: z.enum(JOB_EFFORTS).optional(),
  account: jobAccount.optional(),
  computerSize: z.enum(JOB_COMPUTER_SIZES).optional(),
}).strict();
export type CreateJob = z.infer<typeof createJobSchema>;
export const ACTIVE_STATES = ["preparing", "submitting", "submission_unknown", "running", "collecting", "publishing", "verifying"] as const;
export type JobState = "queued" | typeof ACTIVE_STATES[number] | "ready" | "needs_attention" | "cancelled" | "merged";

export interface Verification {
  headSha: string;
  verdict: "passed" | "failed" | "blocked";
  commands: string[][];
  evidence: string;
  at: string;
}
export interface JobTrace {
  where: "r2" | "local";
  bytes: number;
  storedAt: string;
  expiresAt: string;
  truncated: boolean;
}
export interface Job extends CreateJob {
  id: string;
  state: JobState;
  backend: BackendId;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  sourceRef?: string;
  baseSha?: string;
  taskId?: string;
  taskUrl?: string;
  outputBranch: string;
  headSha?: string;
  prUrl?: string;
  prNumber?: number;
  patchArtifact?: string;
  blocker?: string;
  cancelRequested?: boolean;
  verification?: Verification;
  review?: { headSha: string; reviewerJobId: string; verdict: "pass" | "changes_requested"; summary: string; at: string };
  startedAt?: string;
  finishedAt?: string;
  stage?: string;
  lastStep?: import("./cloud-task.ts").CloudTaskStep;
  changes?: import("./cloud-task.ts").CloudTaskChanges;
  activityArtifact?: string;
  trace?: JobTrace;
}
export interface JobEvent { sequence: number; jobId: string; at: string; type: string; detail: string }
export interface Profile {
  id: string;
  label: string;
  backend?: BackendId;
  codexHome?: string;
  cli?: string;
  routineId?: string;
  routineTokenEnv?: string;
  computerSize?: JobComputerSize;
  maxComputerSize?: JobComputerSize;
  claudeTokenEnv?: string;
  account?: string;
}
export interface BackendCapabilities {
  id: string;
  label: string;
  enabled: boolean;
  submission: boolean;
  continuation: boolean;
  cancellation: boolean;
  activity: "polled" | "streamed";
  billing: "subscription" | "api-and-compute";
  limitation?: string;
}
export interface WorkspaceSnapshot {
  jobs: Job[];
  repositories: Repository[];
  profiles: { id: string; label: string }[];
  backends: BackendCapabilities[];
  concurrency: number;
  active: number;
  metrics: { prOpened: number; verified: number; merged: number; needsAttention: number; repairs: number };
  publishingHost: "local" | "remote";
  wakeupsConfigured: boolean;
  measurements?: { interventions: number; regressions: number; reportedTokens: number | null; reportedModelCostUsd: number | null; reportedComputeCostUsd: number | null; averageObservedCompletionMs: number | null; receipts: number; coverage: string };
}

export interface Wakeup { id: number; botId: string; threadId: string; sendId: string; text: string }
export type WakeupSettlement = { outcome: "delivered" } | { outcome: "dropped"; reason: string };

export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => x === "*" || y === "*" || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}
export function pathInScopes(path: string, scopes: readonly string[]): boolean {
  return !path.split("/").includes(".git") && !path.startsWith("/") && !path.split("/").includes("..") &&
    scopes.some((prefix) => prefix === "*" || path === prefix || path.startsWith(`${prefix}/`));
}
export function activeJob(job: Job): boolean { return (ACTIVE_STATES as readonly string[]).includes(job.state); }
