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
  it("says one call waits until the run ends, that later.dog keeps a recorded run's computer awake, and never that it sleeps under one", async () => {
    const { availableTools } = await import("./agents-catalog.ts");
    const run = availableTools({ cloudHome: true } as never).find((tool) => tool.name === "run_on_computer")?.description ?? "";
    expect(run).toContain("Packages stay installed there between runs. One call waits until the command ends, up to wait_minutes (default 4, at most 60). A run still going then keeps going and gives you its run_id. later.dog checks it every 30 seconds, which keeps your computer awake while it runs, and may wake you when it ends. Do your other work first, then call again with only run_id when you need the result. That call itself waits up to its wait_minutes (default 4), so never sleep or loop before it.");
    expect(run).not.toMatch(/go to sleep|goes to sleep|within 4 minutes|4 more minutes|about 4 minutes/);
  });
});
