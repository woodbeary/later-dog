import { describe, expect, it } from "vitest";
import { LOCAL_TOOLS_REFUSED_ROUTES, SELF_APPROVAL_REFUSAL, localToolsBodyRefusal, localToolsRouteRefusal } from "./local-tools-scope.ts";

describe("local tools: routes that stay with the desktop app or a paired device", () => {
  it("names every card, grant and credential route it refuses, and lets ordinary work through", () => {
    expect(LOCAL_TOOLS_REFUSED_ROUTES.length).toBeGreaterThan(10);
    expect(localToolsRouteRefusal("POST", "/api/bots/b1/respond")).toBe(SELF_APPROVAL_REFUSAL);
    expect(localToolsRouteRefusal("post", "/api/threads/t1/respond")).toBe(SELF_APPROVAL_REFUSAL);
    expect(localToolsRouteRefusal("GET", "/api/bots/b1/connector-cards/c1/status")).toBe(SELF_APPROVAL_REFUSAL);
    expect(localToolsRouteRefusal("DELETE", "/api/bots/b1/command-allowlist/r1")).toBeNull();
    expect(localToolsRouteRefusal("POST", "/api/bots/b1/messages")).toBeNull();
    expect(localToolsRouteRefusal("GET", "/api/instances")).toBeNull();
    expect(localToolsRouteRefusal("PATCH", "/api/instances/claude")).toBe(SELF_APPROVAL_REFUSAL);
  });
  it("says it in plain words", () => {
    expect(SELF_APPROVAL_REFUSAL).toMatch(/approve its own work/);
    expect(SELF_APPROVAL_REFUSAL).not.toMatch(/\buser\b/i);
  });
});

describe("local tools: changes that stay with the desktop app or a paired device", () => {
  const refused = (method: string, path: string, body: unknown) => localToolsBodyRefusal(method, path, body);
  it("refuses any approval mode looser than Heel, Off-leash and Full access included, on a dog or a thread", () => {
    for (const body of [{ approvalMode: "auto" }, { approvalMode: "full" }, { approvalMode: "edits" }, { approvalMode: "custom" }, { autoApprove: true }]) {
      expect(refused("PATCH", "/api/bots/b1", body), JSON.stringify(body)).toBe(SELF_APPROVAL_REFUSAL);
      expect(refused("PATCH", "/api/bots/b1/tasks/t1", body)).toBe(SELF_APPROVAL_REFUSAL);
      expect(refused("POST", "/api/bots/b1/tasks", body)).toBe(SELF_APPROVAL_REFUSAL);
      expect(refused("POST", "/api/bots", body)).toBe(SELF_APPROVAL_REFUSAL);
    }
  });
  it("lets a tool tighten a dog back to Heel", () => {
    for (const body of [{ approvalMode: "ask" }, { autoApprove: false }, { approvalMode: "ask", autoApprove: false, alwaysAllow: [] }]) {
      expect(refused("PATCH", "/api/bots/b1", body)).toBeNull();
      expect(refused("PATCH", "/api/bots/b1/tasks/t1", body)).toBeNull();
    }
  });
  it("refuses permission grants, always-allow lists, tool scope, connector scope, computers and teammates' reach", () => {
    for (const body of [
      { alwaysAllow: ["Bash(ls)"] }, { toolScope: { mode: "all" } }, { connectorScopes: { apps: { gmail: "write" } } }, { outbound: { policy: "allow", dailyCap: 5 } },
      { mcpServers: ["x"] }, { peers: null }, { managedSections: ["Ops"] }, { chiefOfStaff: true }, { approvePeerComms: false },
      { computer: "local" }, { browser: true }, { acknowledgeLocalAuto: true }, { cwd: "/" },
    ]) {
      expect(refused("PATCH", "/api/bots/b1", body), JSON.stringify(body)).toBe(SELF_APPROVAL_REFUSAL);
    }
    expect(refused("PATCH", "/api/bots/b1/tasks/t1", { alwaysAllow: ["Bash(ls)"] })).toBe(SELF_APPROVAL_REFUSAL);
    expect(refused("PATCH", "/api/bots/b1/tasks/t1", { refreshPermissions: true })).toBe(SELF_APPROVAL_REFUSAL);
  });
  it("lets a tool create a dog with a name, role, model and folder, but not with grants", () => {
    expect(refused("POST", "/api/bots", { name: "Scout", title: "Researcher", modelSelection: { instanceId: "claude", model: "m" }, cwd: "/Users/me/work" })).toBeNull();
    expect(refused("POST", "/api/bots", { name: "Scout", computer: "local" })).toBe(SELF_APPROVAL_REFUSAL);
  });
  it("lets ordinary changes through", () => {
    expect(refused("PATCH", "/api/bots/b1", { name: "Scout", color: "blue", unread: false, modelSelection: { instanceId: "claude", model: "m" } })).toBeNull();
    expect(refused("PATCH", "/api/bots/b1/tasks/t1", { title: "New title", modelSelection: { instanceId: "claude", model: "m" } })).toBeNull();
    expect(refused("POST", "/api/bots/b1/messages", { text: "approvalMode: full" })).toBeNull();
    expect(refused("GET", "/api/bots/b1", { approvalMode: "full" })).toBeNull();
    expect(refused("PATCH", "/api/bots/b1", "not an object")).toBeNull();
  });
  it("refuses new-dog defaults that start dogs looser than Heel, and lets other settings through", () => {
    expect(refused("PUT", "/api/config", { newBotDefaults: { profile: { approvalMode: "full" } } })).toBe(SELF_APPROVAL_REFUSAL);
    expect(refused("PATCH", "/api/config", { newBotDefaults: { profile: { autoApprove: true } } })).toBe(SELF_APPROVAL_REFUSAL);
    expect(refused("PATCH", "/api/config", { newBotDefaults: { profile: { approvalMode: "ask" } } })).toBeNull();
    expect(refused("PATCH", "/api/config", { accountBattery: { enabled: true } })).toBeNull();
  });
});
