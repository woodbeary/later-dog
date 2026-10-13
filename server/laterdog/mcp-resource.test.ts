import { describe, expect, it } from "vitest";

import { discoverMcpAuth } from "../mcp-oauth-discovery.ts";
import { protectedResourceFor } from "./mcp-resource.ts";

const TARGET = new URL("https://mcp.example.com/mcp");

describe("the resource a sign-in asks for", () => {
  it("uses the protected resource the server names when it covers the MCP address", () => {
    expect(protectedResourceFor(TARGET, "https://mcp.example.com")).toBe("https://mcp.example.com/");
    expect(protectedResourceFor(TARGET, "https://mcp.example.com/")).toBe("https://mcp.example.com/");
    expect(protectedResourceFor(TARGET, "https://mcp.example.com/mcp#tools")).toBe("https://mcp.example.com/mcp");
    expect(protectedResourceFor(new URL("https://api.example.com/mcp/mcp"), "https://api.example.com/mcp")).toBe("https://api.example.com/mcp");
    expect(protectedResourceFor(new URL("https://mcp.example.com/mcp/"), "https://mcp.example.com/mcp")).toBe("https://mcp.example.com/mcp");
  });

  it("keeps the MCP address when the named resource is elsewhere, narrower or unreadable", () => {
    const elsewhere = [
      undefined,
      42,
      "",
      "not a url",
      "https://other.example.com",
      "http://mcp.example.com",
      "https://mcp.example.com:8443",
      "https://mcp.example.com/m",
      "https://mcp.example.com/mcp-v2",
      "https://mcp.example.com/mcp/tools",
      "https://mcp.example.com/?tenant=a",
      "https://user:pw@mcp.example.com",
    ];
    for (const advertised of elsewhere) expect(protectedResourceFor(TARGET, advertised)).toBe("https://mcp.example.com/mcp");
  });

  it("drops a fragment from the MCP address", () => {
    expect(protectedResourceFor(new URL("https://mcp.example.com/mcp#frag"), undefined)).toBe("https://mcp.example.com/mcp");
  });

  it("is what discovery hands to the sign-in", async () => {
    const routes: Record<string, unknown> = {
      "https://mcp.example.com/.well-known/oauth-protected-resource/sse": { resource: "https://mcp.example.com", authorization_servers: ["https://auth.example.com"] },
      "https://auth.example.com/.well-known/oauth-authorization-server": {
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        code_challenge_methods_supported: ["S256"],
      },
    };
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      return url in routes ? Response.json(routes[url]) : new Response("not found", { status: 404 });
    }) as typeof fetch;
    const meta = await discoverMcpAuth("https://mcp.example.com/sse", null, { fetch: fetcher });
    expect(meta?.resource).toBe("https://mcp.example.com/");
  });
});
