import { describe, expect, it } from "vitest";

import { toolDetailPreview } from "../tool-summary.ts";
import { cloudTaskRefFromToolOutput, jobReceipt, startsCloudJob } from "./job-receipt.ts";

const JOB = {
  requestKey: "request-key-1", repository: "owner/repo", title: "Fix the  login\nbutton", brief: "x".repeat(40_000), standingInstructions: "",
  writeScopes: ["src"], dependencies: [], profileId: "cloud", kind: "implementation", id: "6a1f8f2e-1111-4222-8333-944444444444",
  state: "queued", backend: "laterdog-cloud", attempt: 1, createdAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-10T00:00:00.000Z", outputBranch: "laterdog/x",
};

describe("job receipts", () => {
  it("names the tools that start a job, under any engine's naming", () => {
    for (const name of ["delegate_cloud_job", "mcp__laterdog__delegate_cloud_job", "laterdog.correct_cloud_job", "mcp__laterdog__review_cloud_job"]) expect(startsCloudJob(name)).toBe(true);
    for (const name of ["mcp__laterdog__inspect_cloud_job", "mcp__laterdog__laterdog_workspace", "delegate_cloud_job_extra", undefined]) expect(startsCloudJob(name)).toBe(false);
  });

  it("gives a dog a short receipt with the job's identity first and without its own brief", () => {
    const receipt = jobReceipt(JOB) as Record<string, unknown>;
    expect(Object.keys(receipt).slice(0, 5)).toEqual(["id", "title", "state", "repository", "backend"]);
    expect(receipt).not.toHaveProperty("brief");
    expect(receipt).toMatchObject({ kind: "implementation", outputBranch: "laterdog/x", writeScopes: ["src"] });
    expect(jobReceipt({ error: "x" })).toEqual({ error: "x" });
  });

  it("reads the job from a tool result in every shape the engines report", () => {
    const text = JSON.stringify(jobReceipt(JOB));
    const expected = { jobId: JOB.id, title: "Fix the login button", repository: "owner/repo", backend: "laterdog-cloud" };
    const mcpContent = [{ type: "text", text }];
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__delegate_cloud_job", toolDetailPreview(mcpContent))).toEqual(expected);
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__delegate_cloud_job", JSON.stringify(mcpContent))).toEqual(expected);
    expect(cloudTaskRefFromToolOutput("delegate_cloud_job", { content: mcpContent })).toEqual(expected);
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__delegate_cloud_job", text)).toEqual(expected);
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__delegate_cloud_job", toolDetailPreview([{ type: "text", text: JSON.stringify({ ...JOB, brief: "short" }) }]))).toEqual(expected);
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__delegate_cloud_job", toolDetailPreview([{ type: "text", text: JSON.stringify(JOB) }]))).toBeNull();
  });

  it("ignores other tools, errors and results without a job", () => {
    const text = JSON.stringify(jobReceipt(JOB));
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__inspect_cloud_job", text)).toBeNull();
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__delegate_cloud_job", "requestKey already belongs to a different request")).toBeNull();
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__delegate_cloud_job", JSON.stringify({ id: "not-a-uuid", title: "x" }))).toBeNull();
    expect(cloudTaskRefFromToolOutput("mcp__laterdog__delegate_cloud_job", undefined)).toBeNull();
  });
});
