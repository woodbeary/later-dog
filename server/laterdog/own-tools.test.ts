import { describe, expect, it } from "vitest";
import { MCP_TOOLS, mcpTools } from "./mcp.ts";
import { LATERDOG_DOG_TOOLS, isLaterdogMcp, laterdogPreallowedTools } from "./own-tools.ts";

describe("later.dog's own tools", () => {
  it("offers a dog only delegate, inspect and publish, and pre-allows exactly those", () => {
    expect(mcpTools({ LATERDOG_BOT_ID: "dog-a" }).map((tool) => tool.name)).toEqual([...LATERDOG_DOG_TOOLS]);
    expect(laterdogPreallowedTools({ laterdog: { command: "node", args: ["/repo/server/laterdog/mcp.ts"] } }, { laterdog: {} }))
      .toEqual(LATERDOG_DOG_TOOLS.map((tool) => `mcp__laterdog__${tool}`));
  });

  it("keeps the whole supervisor for the person's own MCP client, without local assistance", () => {
    const offered = MCP_TOOLS.map((tool) => tool.name);
    expect(offered).toEqual(expect.arrayContaining(["laterdog_workspace", "merge_cloud_job", "configure_verification_recipe", ...LATERDOG_DOG_TOOLS]));
    expect(offered).not.toContain("request_local_assistance");
    expect(offered).not.toContain("inspect_local_assistance");
  });

  it("names the connected repositories to a dog instead of a workspace tool it does not have", () => {
    const delegate = mcpTools({ LATERDOG_BOT_ID: "dog-a", LATERDOG_REPOSITORIES: "acme/web,acme/api" }).find((tool) => tool.name === "delegate_cloud_job");
    expect(delegate?.description).toContain("acme/web, acme/api");
    expect(delegate?.description).not.toContain("laterdog_workspace");
    expect(MCP_TOOLS.find((tool) => tool.name === "delegate_cloud_job")?.description).toContain("laterdog_workspace");
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
