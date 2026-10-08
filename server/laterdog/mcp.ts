import { createInterface } from "node:readline";
import { z } from "zod";
import { createJobSchema, repositorySchema } from "../../shared/laterdog.ts";
import { observationSchema } from "./observations.ts";
import { assistanceSchema } from "./bridge-store.ts";
import { supervisorOrigin } from "./config.ts";
import { credentialHeaders, mcpCredential, type SupervisorCredential } from "./dog-access.ts";

const jobId = z.string().uuid();
const tools = [
  { name: "configure_verification_recipe", description: "Configure real behavioral CI check names and/or isolated command arrays for an already connected repository. Choose from its feature map and actual test workflow. This cannot grant merge authority or change provider access.", schema: z.object({ repository: repositorySchema.shape.slug, behavioralChecks: repositorySchema.shape.behavioralChecks, verification: repositorySchema.shape.verification }).strict(), method: "POST", path: () => "/verification-policy" },
  { name: "inspect_provider_access", description: "Read selected native profile authentication and CLI capabilities. Allowance and environment compatibility remain unknown until supported evidence establishes them.", schema: z.object({ profileId: z.string().regex(/^[a-zA-Z0-9_-]+$/) }).strict(), method: "GET", path: (a: Record<string,unknown>) => `/profiles/${a.profileId}/access` },
  { name: "list_provider_tasks", description: "List existing tasks under a selected profile to investigate an uncertain submission before attaching its identity; this never starts or resumes work.", schema: z.object({ profileId: z.string().regex(/^[a-zA-Z0-9_-]+$/) }).strict(), method: "GET", path: (a: Record<string,unknown>) => `/profiles/${a.profileId}/tasks` },
  { name: "record_job_observation", description: "Record a durable agent decision, human intervention, regression, or sourced usage/cost receipt. Reuse requestKey for retries; missing costs remain unknown.", schema: observationSchema, method: "POST", path: () => "/observations" },
  { name: "laterdog_workspace", description: "Inspect cloud jobs, configured repositories, account profiles, native limitations and measured PR outcomes.", schema: z.object({}).strict(), method: "GET", path: () => "/workspace" },
  { name: "delegate_cloud_job", description: "Delegate a scoped task to the selected profile's cloud backend (native Codex Cloud, or Claude Code cloud through a routine). Reuse requestKey on retries. Dependencies and standing instructions are durable; the starting ref is pinned separately from the output branch.", schema: createJobSchema, method: "POST", path: () => "/jobs" },
  { name: "inspect_cloud_job", description: "Read a job and its event receipts without resuming or duplicating the provider task.", schema: z.object({ jobId }).strict(), method: "GET", path: (a: Record<string,unknown>) => `/jobs/${a.jobId}` },
  { name: "collect_cloud_diff", description: "Read a previously collected provider diff. It is not a verification verdict.", schema: z.object({ jobId }).strict(), method: "GET", path: (a: Record<string,unknown>) => `/jobs/${a.jobId}/patch` },
  ...["publish", "verify", "merge", "cancel"].map((action) => ({
    name: `${action}_cloud_job`, description: action === "merge" ? "Merge only with repository authority, current-commit verification and independent review. GitHub protections remain in effect." : action === "publish" ? "Publish the collected diff as a draft PR on the remote supervisor. Existing PRs are updated on repair runs." : action === "verify" ? "Verify the exact current PR commit through GitHub checks and any configured isolated-container commands. No checks is blocked, never passed." : "Cancel queued work or record a cancellation request. The native CLI cannot cancel an already submitted cloud task.",
    schema: action === "publish" ? z.object({ jobId, summary: z.string().min(1).max(20_000).optional().describe("Public PR description, authored from the actual change; exclude private context and credentials") }).strict()
      : action === "cancel" ? z.object({ jobId, acknowledgeUnknown: z.boolean().optional().describe("Only after list_provider_tasks shows no task for this job: release an uncertain submission's execution slot") }).strict()
      : z.object({ jobId }).strict(), method: "POST", action, path: (a: Record<string,unknown>) => `/jobs/${a.jobId}/action`,
  })),
  { name: "review_cloud_job", description: "Launch a separate cloud review against the current published commit. Its review manifest is retained as evidence, without modifying the product branch.", schema: z.object({ jobId, requestKey: z.string().min(8), profileId: z.string().optional() }).strict(), method: "POST", action: "review", path: (a: Record<string,unknown>) => `/jobs/${a.jobId}/action` },
  { name: "correct_cloud_job", description: "Deliver a conversational correction as a new repair task against the result branch, updating the same PR. This is a new run, not native continuation. Pass writeScopes only when the evidence shows the fix lies outside the job's original paths; it replaces them for this repair.", schema: z.object({ jobId, requestKey: z.string().min(8), brief: z.string().min(1).max(100_000), writeScopes: z.array(z.string().min(1).max(300)).min(1).max(40).optional() }).strict(), method: "POST", action: "correct", path: (a: Record<string,unknown>) => `/jobs/${a.jobId}/action` },
  { name: "reconcile_cloud_task", description: "Attach a known provider task (a Codex task_… ID or a Claude session_… ID) to an uncertain submission after investigating it. Never blindly resubmit an uncertain job.", schema: z.object({ jobId, taskId: z.string().regex(/^(task|session)_[a-zA-Z0-9_-]+$/) }).strict(), method: "POST", action: "reconcile", path: (a: Record<string,unknown>) => `/jobs/${a.jobId}/action` },
  { name: "request_local_assistance", description: "Queue assistance on an explicitly paired device and repository root. inspect_repo returns bounded metadata, excluding credentials. assist delegates to its configured local bot under existing computer permissions.", schema: assistanceSchema, method: "POST", path: () => "/bridge/requests" },
  { name: "inspect_local_assistance", description: "Inspect paired-device availability and durable local request outcomes. Device credentials are never returned.", schema: z.object({}).strict(), method: "GET", path: () => "/bridge/devices" },
];
export const MCP_TOOLS = tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.schema),
  annotations: { readOnlyHint: tool.method === "GET", destructiveHint: tool.name === "merge_cloud_job", openWorldHint: tool.method !== "GET" } }));

/** `credential` is the admin token as a string, or a dog's derived token with its bot ID; by default, whatever this process was started with. */
export async function callTool(name: string, args: unknown, origin = supervisorOrigin(), credential: string | SupervisorCredential = mcpCredential()): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name); if (!tool) throw new Error("Unknown later.dog tool");
  const contextual = name === "delegate_cloud_job" && args && typeof args === "object"
    ? { ...args, ...(process.env.LATERDOG_BOT_ID ? { botId: process.env.LATERDOG_BOT_ID } : {}), ...(process.env.LATERDOG_CONVERSATION_ID ? { conversationId: process.env.LATERDOG_CONVERSATION_ID } : {}) }
    : args;
  const input = tool.schema.parse(contextual) as Record<string,unknown>; const { jobId: _id, ...body } = input;
  const action = "action" in tool ? tool.action : undefined;
  const payload = action ? { ...body, action } : input;
  const headers = { ...credentialHeaders(typeof credential === "string" ? { token: credential } : credential), "content-type": "application/json" };
  const response = await fetch(`${origin}/v1${tool.path(input)}`, { method: tool.method, headers,
    ...(tool.method !== "GET" ? { body: JSON.stringify(payload) } : {}), redirect: "error", signal: AbortSignal.timeout(660_000) });
  const result = await response.json() as { error?: string };
  if (!response.ok) throw new Error(result.error ?? `later.dog returned ${response.status}`);
  return result;
}

export function startMcp(): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line",(line) => {
    void (async () => {
      let request: { id?: string | number | null; method?: string; params?: { name?: string; arguments?: unknown } };
      try { request = JSON.parse(line); } catch { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } })}\n`); return; }
      if (request.id === undefined) return;
      const answer = (result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
      if (request.method === "initialize") return answer({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "laterdog", version: "0.1.0" } });
      if (request.method === "ping") return answer({});
      if (request.method === "tools/list") return answer({ tools: MCP_TOOLS });
      if (request.method === "tools/call") {
        try {
          const result = await callTool(String(request.params?.name),request.params?.arguments ?? {});
          const serialized = JSON.stringify(result);
          return answer({ content: [{ type: "text", text: serialized.length > 30_000 ? `${serialized.slice(0,30_000)}\n[Truncated. Inspect the job or artifact in the workspace for the full result.]` : serialized }] });
        } catch (error) { return answer({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Tool failed" }] }); }
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } })}\n`);
    })();
  });
}
if (process.argv[1]?.endsWith("/laterdog/mcp.ts") || process.argv[1]?.endsWith("/laterdog/mcp.js")) startMcp();
