import { describe, expect, it } from "vitest";
import { removalCandidateOf, replacementAccount, selectionMovedTo, type RemovalCandidate } from "./account-removal.ts";

const account = (instanceId: string, driverKind: string, signedIn = true, available = true): RemovalCandidate =>
  ({ instanceId, driverKind, available, signedIn, models: ["claude-fable-5-1", "claude-opus-5-5"], defaultModel: "claude-opus-5-5" });

describe("removing an account the dogs use", () => {
  const leaving = account("claude-anthony-copy", "claudeAgent", false);
  const accounts = [leaving, account("claude", "claudeAgent", false), account("claude-anthony", "claudeAgent"), account("codex", "codex")];

  it("moves them to a signed-in account of the same engine first", () => {
    expect(replacementAccount(leaving, accounts)?.instanceId).toBe("claude-anthony");
  });

  it("falls back to any signed-in account, and to none when nothing else is signed in", () => {
    expect(replacementAccount(leaving, [leaving, account("codex", "codex")])?.instanceId).toBe("codex");
    expect(replacementAccount(leaving, [leaving, account("claude", "claudeAgent", false)])).toBeUndefined();
  });

  it("keeps the model and effort on the same engine, and takes the other engine's default across engines", () => {
    const selection = { instanceId: "claude-anthony-copy", model: "claude-fable-5-1", effort: "xhigh" as const };
    expect(selectionMovedTo(selection, "claudeAgent", account("claude-anthony", "claudeAgent")))
      .toEqual({ instanceId: "claude-anthony", model: "claude-fable-5-1", effort: "xhigh" });
    expect(selectionMovedTo({ ...selection, model: "claude-retired" }, "claudeAgent", account("claude-anthony", "claudeAgent")).model).toBe("claude-opus-5-5");
    expect(selectionMovedTo(selection, "claudeAgent", { ...account("codex", "codex"), models: ["gpt-6-astra"], defaultModel: "gpt-6-astra" }))
      .toEqual({ instanceId: "codex", model: "gpt-6-astra" });
  });

  it("reads an account from what the server describes", () => {
    expect(removalCandidateOf({ instanceId: "claude-2", driverKind: "claudeAgent", snapshot: { state: "available", authenticated: false }, models: { default: "claude-opus-5-5", options: [{ id: "claude-opus-5-5" }] } }))
      .toEqual({ instanceId: "claude-2", driverKind: "claudeAgent", available: true, signedIn: false, models: ["claude-opus-5-5"], defaultModel: "claude-opus-5-5" });
  });
});
