import { expect, it } from "vitest";
import { assertToolScopeSupported, TOOL_SCOPE_SUPPORT } from "../../shared/tool-scope-support.ts";
import { BUILT_IN_DRIVERS } from "./builtIn.ts";

it("lets Antigravity narrow app tools the way Claude, Codex and Cursor do", () => {
  expect((TOOL_SCOPE_SUPPORT as Record<string, string>).antigravityAgent).toBe("mcp");
  expect(assertToolScopeSupported("antigravityAgent", { allow: ["native:*", "mcp:notes:read"] })).toEqual({ allow: ["native:*", "mcp:notes:read"] });
  expect(() => assertToolScopeSupported("antigravityAgent", { deny: ["native:read"] })).toThrow(/not supported/);
});

it("covers every registered adapter and refuses unsupported native restrictions", () => {
  expect(Object.keys(TOOL_SCOPE_SUPPORT).sort()).toEqual(BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort());
  for (const [engine, support] of Object.entries(TOOL_SCOPE_SUPPORT)) {
    expect(assertToolScopeSupported(engine, undefined)).toBeUndefined();
    expect(() => assertToolScopeSupported(engine, { allow: "all" })).toThrow();
    if (support === "native-and-mcp") {
      expect(assertToolScopeSupported(engine, { allow: [] })).toEqual({ allow: [] });
    } else {
      expect(() => assertToolScopeSupported(engine, { allow: [] })).toThrow(/not supported/);
      expect(() => assertToolScopeSupported(engine, { deny: ["native:read"] })).toThrow(/not supported/);
      if (support === "mcp") expect(assertToolScopeSupported(engine, { allow: ["native:*", "mcp:notes:read"] })).toEqual({ allow: ["native:*", "mcp:notes:read"] });
    }
  }
});
