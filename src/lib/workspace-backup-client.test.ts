import { describe, expect, it } from "vitest";
import { applyWorkspaceClientState, collectWorkspaceClientState } from "./workspace-backup-client";

function memory(values: Record<string, string>) {
  const entries = new Map(Object.entries(values));
  return { entries, getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => { entries.set(key, value); }, removeItem: (key: string) => { entries.delete(key); } };
}

describe("full-backup browser state", () => {
  it("exports exact app drafts/preferences, never saved webhook credentials or auth/cache keys", () => {
    const storage = memory({ "laterdog-drafts": "draft", "laterdog-webhook-credentials": "private URL", "laterdog-skin": "daylight", "auth-token": "secret", "laterdog-connected-apps": "cached accounts", "laterdog-email-gate": "identity", "laterdog-pending-workspace-restore": "old" });
    expect(collectWorkspaceClientState(storage)).toEqual({ "laterdog-drafts": "draft", "laterdog-skin": "daylight" });
  });

  it("replaces only allowlisted keys and clears old drafts absent from the backup", () => {
    const storage = memory({ "laterdog-drafts": "old", "laterdog-draft-attachments": "old attachment", "auth-token": "keep", "laterdog-webhook-credentials": "destination URL" });
    applyWorkspaceClientState({ "laterdog-drafts": "restored", "laterdog-show-threads": "false" }, storage);
    expect(Object.fromEntries(storage.entries)).toEqual({ "laterdog-drafts": "restored", "laterdog-show-threads": "false", "auth-token": "keep", "laterdog-webhook-credentials": "destination URL" });
  });

  it("carries the run card visibility choice in a workspace backup", () => {
    const storage = memory({ "laterdog-show-run-card": "0" });
    expect(collectWorkspaceClientState(storage)).toEqual({ "laterdog-show-run-card": "0" });
    applyWorkspaceClientState({ "laterdog-show-run-card": "1" }, storage);
    expect(storage.getItem("laterdog-show-run-card")).toBe("1");
  });

  it.each([null, [], { "auth-token": "injected" }, { "laterdog-webhook-credentials": "source URL" }, { "laterdog-drafts": 1 }])("rejects invalid client state before clearing anything (%j)", (value) => {
    const storage = memory({ "laterdog-drafts": "old", "auth-token": "keep" });
    expect(() => applyWorkspaceClientState(value, storage)).toThrow("Invalid backup browser state");
    expect(Object.fromEntries(storage.entries)).toEqual({ "laterdog-drafts": "old", "auth-token": "keep" });
  });

  it("rolls browser state back if restored values exceed storage quota", () => {
    const storage = memory({ "laterdog-drafts": "old", "laterdog-skin": "daylight", "auth-token": "keep" });
    const original = storage.setItem;
    storage.setItem = (key, value) => { if (value === "too large") throw new Error("quota"); original(key, value); };
    expect(() => applyWorkspaceClientState({ "laterdog-drafts": "too large" }, storage)).toThrow("quota");
    expect(Object.fromEntries(storage.entries)).toEqual({ "laterdog-drafts": "old", "laterdog-skin": "daylight", "auth-token": "keep" });
  });
});
