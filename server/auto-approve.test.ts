import { describe, expect, it, vi } from "vitest";

import englishCatalog from "../src/locales/en.json" with { type: "json" };

import {
  HELD_NOTE,
  approvalHeldNote,
  approvalHeldReason,
  approvalModeForOrigin,
  autoVerdict,
  deliverFullAccessApproval,
} from "./auto-approve.ts";

describe("Full access delivery", () => {
  it.each(["allowed-once", "rejected", "unavailable"] as const)("preserves %s without interrupting or inventing an approval", async outcome => {
    const adapter = { respondToRequest: vi.fn().mockResolvedValue(outcome), interruptTurn: vi.fn() };
    expect(await deliverFullAccessApproval(adapter, "thread", "request", "turn")).toBe(outcome);
    expect(adapter.respondToRequest).toHaveBeenCalledWith("thread", "request", { behavior: "allow" });
    expect(adapter.interruptTurn).not.toHaveBeenCalled();
  });
  it("reports transport failure and interrupts only the failed turn", async () => {
    const adapter = { respondToRequest: vi.fn().mockRejectedValue(new Error("connection lost")), interruptTurn: vi.fn().mockResolvedValue(undefined) };
    expect(await deliverFullAccessApproval(adapter, "thread", "request", "original-turn", () => true)).toBe("failed");
    expect(adapter.interruptTurn).toHaveBeenCalledWith("thread", "original-turn");
    adapter.interruptTurn.mockClear();
    expect(await deliverFullAccessApproval(adapter, "thread", "request")).toBe("failed");
    expect(adapter.interruptTurn).not.toHaveBeenCalled();
    expect(await deliverFullAccessApproval(adapter, "thread", "request", "old-turn", () => false)).toBe("failed");
    expect(adapter.interruptTurn).not.toHaveBeenCalled();
    expect(await deliverFullAccessApproval(undefined, "thread", "request")).toBe("failed");
  });
});

describe("autoVerdict", () => {
  it("never uses a saved command grant to silently send on the person's behalf", () => {
    for (const mode of ["ask", "edits", "auto", "custom"] as const) {
      expect(autoVerdict(mode, "mcp__composio__GMAIL_SEND_DRAFT", { commandAllowed: true })).toEqual({ approve: null, source: "outbound-guard" });
    }
    expect(autoVerdict("full", "GMAIL_SEND_EMAIL").source).toBe("full-access");
  });
  it("applies an explicit exact command grant without changing Full or answering questions/elevations", () => {
    for (const mode of ["ask", "edits", "auto", "custom"] as const) {
      expect(autoVerdict(mode, "Bash", { commandAllowed: true }).source).toBe("command-allowlist");
      expect(autoVerdict(mode, "Bash", { commandAllowed: true }).approve).toBeTruthy();
      expect(autoVerdict(mode, "Bash", { commandAllowed: true, requiresExplicitApproval: true }).approve).toBeNull();
      expect(autoVerdict(mode, "AskUserQuestion", { commandAllowed: true }).approve).toBeNull();
    }
    expect(autoVerdict("full", "Bash", { commandAllowed: true, requiresExplicitApproval: true }).source).toBe("full-access");
  });
  it("answers only for Full access, and then answers everything", () => {
    expect(autoVerdict("full", "Bash")).toEqual({ approve: "approved Bash (full access)", source: "full-access" });
    expect(autoVerdict("full", "Bash", { requiresExplicitApproval: true })).toEqual({
      approve: "approved Bash (full access)",
      source: "full-access",
    });
  });

  it("leaves an Auto or Custom request with the person as the provider's own reviewer did", () => {
    expect(autoVerdict("auto", "Bash")).toEqual({ approve: null, source: "native-approval" });
    expect(autoVerdict("custom", "Bash")).toEqual({ approve: null, source: "native-approval" });
  });

  it("never judges the action itself: Ask and Edits card everything the provider asks about", () => {
    for (const summary of ["wc -l notes.md", "rm -rf build", "cat ~/.ssh/id_rsa"]) {
      expect(autoVerdict("ask", summary)).toEqual({ approve: null, source: "no-grant" });
      expect(autoVerdict("edits", summary)).toEqual({ approve: null, source: "no-grant" });
    }
  });

  it("holds a sandbox widening for the person in every mode but Full", () => {
    for (const mode of ["ask", "edits", "auto", "custom"] as const) {
      expect(autoVerdict(mode, "shell", { requiresExplicitApproval: true }))
        .toEqual({ approve: null, source: "explicit-approval-block" });
    }
  });

  it("allows a web search under Approve for me, by the tool's bare name", () => {
    for (const tool of ["WebSearch", "web_search", "mcp__claude__WebSearch", "search_web"]) {
      expect(autoVerdict("auto", tool), tool).toEqual({
        approve: `approved ${tool} (web search)`,
        source: "web-search",
      });
    }
  });

  it("still cards a fetch, a bare search, and a command under Approve for me", () => {
    for (const tool of ["WebFetch", "web_fetch", "fetch", "search", "Bash"]) {
      expect(autoVerdict("auto", tool), tool).toEqual({ approve: null, source: "native-approval" });
    }
  });

  it("does not grant a web search in Ask, Edits, or Custom", () => {
    expect(autoVerdict("ask", "WebSearch")).toEqual({ approve: null, source: "no-grant" });
    expect(autoVerdict("edits", "WebSearch")).toEqual({ approve: null, source: "no-grant" });
    expect(autoVerdict("custom", "WebSearch")).toEqual({ approve: null, source: "native-approval" });
  });

  it("lets Full access, a sandbox block, and a saved command beat the web-search grant", () => {
    expect(autoVerdict("full", "WebSearch")).toEqual({
      approve: "approved WebSearch (full access)",
      source: "full-access",
    });
    expect(autoVerdict("auto", "WebSearch", { requiresExplicitApproval: true })).toEqual({
      approve: null,
      source: "explicit-approval-block",
    });
    expect(autoVerdict("auto", "WebSearch", { commandAllowed: true })).toEqual({
      approve: "approved WebSearch (saved command)",
      source: "command-allowlist",
    });
  });
});

describe("approvalModeForOrigin", () => {
  it("runs peer-started Custom turns as Auto and leaves every other mode alone", () => {
    expect(approvalModeForOrigin("custom", { peerInitiated: true })).toBe("auto");
    expect(approvalModeForOrigin("custom", { peerInitiated: false })).toBe("custom");
    for (const mode of ["ask", "edits", "auto", "full"] as const) {
      expect(approvalModeForOrigin(mode, { peerInitiated: true })).toBe(mode);
    }
  });
});

describe("held notes", () => {
  it("explains a provider's own request and a sandbox change, and nothing else", () => {
    expect(approvalHeldNote({ source: "native-approval", permission: true })).toBe("approval.held.native");
    expect(approvalHeldNote({ source: "explicit-approval-block", permission: true })).toBe("approval.held.sandbox");
    expect(approvalHeldNote({ source: "web-search", permission: true })).toBeUndefined();
    expect(approvalHeldNote({ source: "no-grant", permission: true })).toBeUndefined();
    expect(approvalHeldNote({ source: undefined, permission: true })).toBeUndefined();
    expect(approvalHeldNote({ source: "native-approval", permission: false })).toBeUndefined();
    expect(approvalHeldReason({ source: "native-approval", permission: true }))
      .toBe("This always asks you first.");
  });

  it("the catalog's held notes are exactly the ones the server sends", () => {
    const catalog = Object.fromEntries(Object.entries(englishCatalog).filter(([key]) => key.startsWith("approval.held.")));
    expect(catalog).toEqual(HELD_NOTE);
  });
});

describe("tools that ask a person", () => {
  const modes = ["ask", "edits", "auto", "custom", "full"] as const;

  it("never answers AskUserQuestion for the person, even under Full access", () => {
    for (const mode of modes) {
      expect(autoVerdict(mode, "AskUserQuestion"), mode).toEqual({ approve: null, source: "no-grant" });
    }
  });

  it("never answers ask_user, bare or MCP-prefixed", () => {
    for (const mode of modes) {
      expect(autoVerdict(mode, "ask_user").approve, mode).toBeNull();
      expect(autoVerdict(mode, "mcp__dog__ask_user").approve, mode).toBeNull();
    }
  });

  it("still answers an ordinary tool under Full access", () => {
    expect(autoVerdict("full", "Read").approve).toBeTruthy();
  });
});
