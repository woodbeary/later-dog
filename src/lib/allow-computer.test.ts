import { beforeEach, describe, expect, it, vi } from "vitest";
import { canUseMcpServer } from "../../shared/tool-scope";

const fixture = vi.hoisted(() => ({ api: vi.fn(async (..._args: unknown[]) => ({})) }));
vi.mock("@/state/store", () => ({ api: fixture.api }));
import { allowComputer, scopeAllowingServer } from "./allow-computer";

beforeEach(() => fixture.api.mockClear());

describe("scopeAllowingServer", () => {
  it("drops only the computer's denials and keeps every other choice", () => {
    expect(scopeAllowingServer({ deny: ["mcp:computer:*", "mcp:computer:screenshot", "native:bash"] }, "computer"))
      .toEqual({ deny: ["native:bash"] });
  });

  it("adds the computer to an allow list", () => {
    const next = scopeAllowingServer({ allow: ["native:read", "mcp:mail:*"] }, "computer");
    expect(next).toEqual({ allow: ["native:read", "mcp:mail:*", "mcp:computer:*"] });
    expect(canUseMcpServer(next, "computer")).toBe(true);
    expect(canUseMcpServer(next, "browser")).toBe(false);
  });

  it("returns to every tool when nothing else is left, or the saved selection cannot be read", () => {
    expect(scopeAllowingServer({ deny: ["mcp:computer:*"] }, "computer")).toBeNull();
    expect(scopeAllowingServer(undefined, "computer")).toBeNull();
    expect(scopeAllowingServer({ allow: "everything" }, "computer")).toBeNull();
  });
});

describe("allowComputer", () => {
  it("saves the widened selection on the dog", async () => {
    await allowComputer({ id: "scout", toolScope: { allow: [], deny: ["native:bash"] } });
    expect(fixture.api).toHaveBeenCalledWith("/api/bots/scout", {
      method: "PATCH",
      body: JSON.stringify({ toolScope: { allow: ["mcp:computer:*"], deny: ["native:bash"] } }),
    });
  });
});
