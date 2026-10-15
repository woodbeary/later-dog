import { describe, expect, it } from "vitest";
import { autoVerdict } from "../auto-approve.ts";
import {
  announcesApproval, approvalGrantName, autoReviewKept, engineApprovalMode, reviewedVerdict, reviewSkipped, type AutoReviewScope,
} from "./auto-review.ts";

const off: AutoReviewScope = { autoReview: false, cloudHome: true, driverKind: "claudeAgent", lastPersonVia: undefined };
const on: AutoReviewScope = { ...off, autoReview: true };

describe("the account's Auto-review switch", () => {
  it("is skipped only for Off-leash dogs in a Cloud home whose last message the person typed", () => {
    expect(autoReviewKept("auto", off)).toBeNull();
    expect(reviewSkipped("auto", { ...off, lastPersonVia: "call" })).toBe(true);
    expect(autoReviewKept("auto", on)).toBe("on");
    expect(autoReviewKept("auto", { ...off, cloudHome: false })).toBe("not-cloud");
    expect(autoReviewKept("auto", { ...off, lastPersonVia: "api" })).toBe("local-tool");
    expect(autoReviewKept("auto", { ...off, driverKind: "antigravityAgent" })).toBe("engine-shows-heel");
  });

  it("leaves every per-dog override alone", () => {
    for (const level of ["ask", "edits", "full", "custom"] as const) {
      expect(autoReviewKept(level, off)).toBe("not-off-leash");
      expect(engineApprovalMode(level, off)).toBe(level);
    }
  });

  it("starts engines that have their own reviewer without it, so later.dog answers their requests", () => {
    for (const driverKind of ["codex", "claudeAgent", "cursorAgent", "grokAgent", "qwenAgent"]) {
      expect(engineApprovalMode("auto", { ...off, driverKind })).toBe("ask");
      expect(engineApprovalMode("auto", { ...on, driverKind })).toBe("auto");
      expect(engineApprovalMode("auto", { ...off, driverKind, lastPersonVia: "api" })).toBe("auto");
    }
    for (const driverKind of ["openai-compat", "geminiAgent", "pi", undefined]) {
      expect(engineApprovalMode("auto", { ...off, driverKind })).toBe("auto");
    }
  });

  it("approves what the reviewer would have decided, and nothing the platform always asks about", () => {
    const decide = (tool: string, skipped: boolean, extra: { requiresExplicitApproval?: boolean; approvalScope?: string } = {}) =>
      reviewedVerdict(autoVerdict("auto", tool, { requiresExplicitApproval: extra.requiresExplicitApproval }), { tool, skipped, approvalScope: extra.approvalScope });
    expect(decide("Bash", true)).toEqual({ approve: "approved Bash (Auto-review off)", source: "auto-review-off" });
    expect(decide("mcp__cloudflare__dns_records_save", true).source).toBe("auto-review-off");
    expect(decide("Bash", false)).toEqual({ approve: null, source: "native-approval" });
    expect(decide("mcp__composio__GMAIL_SEND_EMAIL", true)).toEqual({ approve: null, source: "outbound-guard" });
    expect(decide("Bash", true, { requiresExplicitApproval: true })).toEqual({ approve: null, source: "explicit-approval-block" });
    expect(decide("AskUserQuestion", true)).toEqual({ approve: null, source: "no-grant" });
    expect(decide("mcp__computer__click", true, { approvalScope: "local-computer" })).toEqual({ approve: null, source: "native-approval" });
    expect(decide("WebSearch", true).source).toBe("web-search");
  });

  it("never turns a Heel or Full access verdict into an Auto-review one", () => {
    expect(reviewedVerdict(autoVerdict("ask", "Bash"), { tool: "Bash", skipped: true })).toEqual({ approve: null, source: "no-grant" });
    expect(reviewedVerdict(autoVerdict("full", "Bash"), { tool: "Bash", skipped: true }).source).toBe("full-access");
  });

  it("names the grant in plain words and keeps the chat free of a line per approved action", () => {
    expect(approvalGrantName("auto-review-off")).toBe("Auto-review being off");
    expect(approvalGrantName("command-allowlist")).toBe("the saved command permission");
    expect(approvalGrantName("full-access")).toBe("Full access");
    expect(announcesApproval("auto-review-off")).toBe(false);
    expect(announcesApproval("full-access")).toBe(true);
  });
});
