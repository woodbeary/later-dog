import { z } from "zod";

export const repoSlug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/)
  .refine((s) => ![".",".."].includes(s.split("/")[1]), "Invalid repository name");
export const gitRef = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/)
  .refine((s) => !s.includes("..") && !s.endsWith(".lock") && !s.endsWith("/") && !s.includes("//"), "Invalid Git ref");
export const scopePath = z.string().min(1).max(300).refine((s) => s === "*" ||
  (!s.startsWith("/") && !s.includes("\\") && !s.split("/").some((p) => ["..", ".git", ""].includes(p))), "Use a relative path prefix or *");
export const commandSchema = z.array(z.string().min(1).max(2000)).min(1).max(30);
export const BACKENDS = ["codex-cloud", "claude-cloud"] as const;
export type BackendId = typeof BACKENDS[number];
export const repositorySchema = z.object({
  slug: repoSlug,
  /** The published Codex Cloud environment ID; kept as the primary field for existing records and the Workspace form. */
  environmentId: z.string().trim().min(1).max(200),
  /** Per-backend environment identities beyond Codex (for claude-cloud: the routine ID whose API trigger starts sessions for this repository). */
  environments: z.partialRecord(z.enum(BACKENDS), z.string().trim().min(1).max(200)).default({}),
  generation: z.enum(["current", "legacy", "unqualified"]).default("unqualified"),
  baseRef: gitRef.default("main"),
  publish: z.boolean().default(true),
  merge: z.boolean().default(false),
  behavioralChecks: z.array(z.string().min(1).max(200)).max(100).default([]),
  verification: z.array(commandSchema).max(20).default([]),
}).strict();
export type Repository = z.infer<typeof repositorySchema>;

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
}
export interface JobEvent { sequence: number; jobId: string; at: string; type: string; detail: string }
export interface Profile {
  id: string;
  label: string;
  /** Which execution backend this account profile submits to; defaults to native Codex Cloud. */
  backend?: BackendId;
  codexHome?: string;
  cli?: string;
  /** claude-cloud: the default routine (`trig_…`) when a repository does not name one. */
  routineId?: string;
  /** claude-cloud: the environment variable holding that routine's API-trigger token; the value never enters config files. */
  routineTokenEnv?: string;
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

/** One message the supervisor holds for the conversation that delegated a job, until a desktop hands it over (or gives up on it). */
export interface Wakeup { id: number; botId: string; threadId: string; sendId: string; text: string }
/** How a desktop settles a wake-up: handed to the conversation, or dropped because that conversation is gone (the reason lands on the job). */
export type WakeupSettlement = { outcome: "delivered" } | { outcome: "dropped"; reason: string };

export function scopesOverlap(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => x === "*" || y === "*" || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)));
}
export function pathInScopes(path: string, scopes: readonly string[]): boolean {
  return !path.split("/").includes(".git") && !path.startsWith("/") && !path.split("/").includes("..") &&
    scopes.some((prefix) => prefix === "*" || path === prefix || path.startsWith(`${prefix}/`));
}
export function activeJob(job: Job): boolean { return (ACTIVE_STATES as readonly string[]).includes(job.state); }
