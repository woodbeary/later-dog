import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "./mcp.ts";
import { LATERDOG_PREALLOWED_TOOLS, isLaterdogMcp, laterdogPreallowedTools } from "./own-tools.ts";

describe("later.dog's own tools", () => {
  it("pre-allows only tools the later.dog MCP server really offers", () => {
    const offered = new Set(MCP_TOOLS.map((tool) => tool.name));
    for (const tool of LATERDOG_PREALLOWED_TOOLS) expect(offered.has(tool)).toBe(true);
  });

  it("keeps merging, verification recipes and local assistance behind the person's approval", () => {
    const preallowed = new Set<string>(LATERDOG_PREALLOWED_TOOLS);
    expect(preallowed.has("merge_cloud_job")).toBe(false);
    expect(preallowed.has("configure_verification_recipe")).toBe(false);
    expect(preallowed.has("request_local_assistance")).toBe(false);
  });

  it("recognises the server later.dog mounts in every launch shape", () => {
    expect(isLaterdogMcp({ command: "node", args: ["/repo/server/laterdog/mcp.ts"] })).toBe(true);
    expect(isLaterdogMcp({ command: "/bin/sh", args: ["-c", "x", "/app/later.dog", "/x/app.asar/dist-server/laterdog/mcp.js"] })).toBe(true);
    expect(isLaterdogMcp({ command: "cmd.exe", args: ["/d", "/s", "/c", "set X=1&& \"node\" \"C:\\x\\laterdog\\mcp.js\""] })).toBe(true);
    expect(isLaterdogMcp({ command: "node", args: ["/elsewhere/mcp.js"] })).toBe(false);
    expect(isLaterdogMcp({ type: "http", url: "https://example.com/laterdog/mcp.js" })).toBe(false);
  });

  it("names nothing when the server was not mounted", () => {
    const server = { command: "node", args: ["/repo/server/laterdog/mcp.ts"] };
    expect(laterdogPreallowedTools({ laterdog: server }, {})).toEqual([]);
    expect(laterdogPreallowedTools({ laterdog: server }, { laterdog: {} })).toContain("mcp__laterdog__delegate_cloud_job");
  });
});
