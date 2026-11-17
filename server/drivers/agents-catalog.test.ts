import { describe, expect, it } from "vitest";

describe("fixing a stuck dog instead of duplicating it", () => {
  it("tells dogs to change another dog's engine or account rather than make a new dog", async () => {
    const { availableTools } = await import("./agents-catalog.ts");
    const tools = availableTools({} as never);
    const describe = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
    expect(describe("create_bot")).toContain("Never make a dog to stand in for an existing one whose engine or account is broken");
    expect(describe("propose_model")).toContain("or of another of the owner's dogs with bot_id");
    expect(describe("dog_accounts")).toContain("move it here instead of making a new dog");
    expect(JSON.stringify(tools.find((tool) => tool.name === "propose_model")?.inputSchema)).toContain("bot_id");
  });
});

describe("waiting for a cloud computer run", () => {
  it("says one call waits until the run ends, keeps the computer awake, and is repeated only when it comes back still running", async () => {
    const { availableTools } = await import("./agents-catalog.ts");
    const run = availableTools({ cloudHome: true } as never).find((tool) => tool.name === "run_on_computer")?.description ?? "";
    expect(run).toContain("One call waits until the command ends, up to wait_minutes (default 4, at most 60), and a waiting call keeps your computer awake.");
    expect(run).toContain("Only a call that comes back still running needs another: call again with only run_id within 4 minutes");
    expect(run).not.toMatch(/call again and again|nothing wakes you|One call waits up to about 4 minutes/);
  });
});
