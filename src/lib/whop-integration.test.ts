import { describe, expect, it } from "vitest";
import { MCP_CONNECTORS, connectorServerName } from "./mcp-connectors";
import { isWhopServer, WHOP_MCP_URL } from "./whop-integration";

const whop = MCP_CONNECTORS.find((connector) => connector.id === "whop")!;

describe("Whop integration", () => {
  it("recognizes the official HTTP endpoint independently of its local name", () => {
    expect(isWhopServer({ type: "http", url: WHOP_MCP_URL })).toBe(true);
    expect(isWhopServer({ type: "http", url: `${WHOP_MCP_URL}/` })).toBe(true);
  });
  it("does not brand other servers, transports or modified URLs as Whop", () => {
    for (const url of ["http://mcp.whop.com/mcp", "https://mcp.whop.com.evil.test/mcp", "https://whop.com/mcp", `${WHOP_MCP_URL}?key=secret`, `${WHOP_MCP_URL}#hash`, "https://key@mcp.whop.com/mcp", "https://mcp.whop.com/docs", "invalid"]) {
      expect(isWhopServer({ type: "http", url }), url).toBe(false);
    }
    expect(isWhopServer({ type: "sse", url: WHOP_MCP_URL })).toBe(false);
    expect(isWhopServer({})).toBe(false);
  });
  it("is an ordinary payments app in the catalog, at the endpoint the server list recognizes", () => {
    expect(whop).toMatchObject({ name: "Whop", url: WHOP_MCP_URL, category: "payments", domain: "whop.com" });
    expect(whop.open).toBeUndefined();
    expect(isWhopServer({ type: whop.transport, url: whop.url })).toBe(true);
  });
  it("does not replace an existing server with the same name", () => {
    expect(connectorServerName(whop, [])).toBe("whop");
    expect(connectorServerName(whop, [{ name: "whop" }, { name: "whop-2" }])).toBe("whop-3");
    expect(connectorServerName(whop, [{ name: "whop-2" }])).toBe("whop");
  });
});
