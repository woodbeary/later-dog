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

describe("waiting on a run on the cloud computer", () => {
  it("tells a dog to check back within 4 minutes, before its computer sleeps and ends the run, and that one check already waits", async () => {
    const { availableTools } = await import("./agents-catalog.ts");
    const run = availableTools({ cloudHome: true } as never).find((tool) => tool.name === "run_on_computer")?.description ?? "";
    expect(run).toContain("nothing wakes you when it ends");
    expect(run).toContain("goes to sleep after 5 minutes without a call, which ends the run");
    expect(run).toContain("call again with only run_id within 4 minutes");
    expect(run).not.toContain("do your other work first");
    expect(run).toContain("never sleep or loop before it");
  });
});
