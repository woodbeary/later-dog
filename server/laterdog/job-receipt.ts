import type { CloudTaskRef } from "../../shared/cloud-task.ts";

export const JOB_STARTING_TOOLS = ["delegate_cloud_job", "correct_cloud_job", "review_cloud_job"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STARTS_JOB = new RegExp(`(?:^|__|[.:/])(?:${JOB_STARTING_TOOLS.join("|")})$`);

export function startsCloudJob(toolName: string | undefined): boolean {
  return typeof toolName === "string" && STARTS_JOB.test(toolName);
}

export function jobReceipt(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const job = result as Record<string, unknown>;
  if (typeof job.id !== "string" || typeof job.requestKey !== "string") return result;
  const pick = (key: string) => (job[key] === undefined ? {} : { [key]: job[key] });
  return {
    id: job.id,
    title: job.title,
    state: job.state,
    repository: job.repository,
    backend: job.backend,
    ...pick("kind"), ...pick("profileId"), ...pick("parentId"), ...pick("outputBranch"), ...pick("prUrl"), ...pick("writeScopes"), ...pick("dependencies"), ...pick("blocker"),
    note: "The person sees this job as a cloud task card in this conversation, with its live progress. Do not poll it: you are woken when it finishes or needs attention. inspect_cloud_job reads it in full.",
  };
}

function walk(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 6 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[[{]/.test(trimmed)) return null;
    try { return walk(JSON.parse(trimmed), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = walk(item, depth + 1); if (found) return found; }
    return null;
  }
  if (typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id === "string" && UUID.test(record.id) && typeof record.title === "string") return record;
  for (const key of ["text", "content", "result", "job"]) {
    const found = walk(record[key], depth + 1);
    if (found) return found;
  }
  return null;
}

export function cloudTaskRefFromToolOutput(toolName: string | undefined, output: unknown): CloudTaskRef | null {
  if (!startsCloudJob(toolName)) return null;
  const job = walk(output);
  if (!job) return null;
  const title = String(job.title).replace(/\s+/g, " ").trim().slice(0, 200);
  if (!title) return null;
  return {
    jobId: String(job.id),
    title,
    ...(typeof job.repository === "string" ? { repository: job.repository.slice(0, 200) } : {}),
    ...(typeof job.backend === "string" ? { backend: job.backend.slice(0, 40) } : {}),
  };
}
