import { describe, expect, it } from "vitest";
import { botNames, dogActivityWords, teammateResultLabel } from "./activity-words.ts";

const store = {
  bots: [{ id: "b1", name: "Scout", hidden: false }, { id: "b2", name: "Rex", hidden: false }, { id: "b3", name: "Pip", hidden: false }, { id: "b4", name: "Ghost", hidden: true }],
  bot(id: string) { return this.bots.find((bot) => bot.id === id); },
};
const nameOf = botNames(store as never);

describe("what the working line says", () => {
  it("names the teammate a dog is checking with or handing work to", () => {
    expect(dogActivityWords("mcp__agents__coordinate_bots", JSON.stringify({ bot_ids: ["b1"], message: "x" }), nameOf)).toBe("checking with Scout");
    expect(dogActivityWords("mcp__agents__coordinate_bots", { bot_ids: ["b1", "rex"] }, nameOf)).toBe("checking with Scout and Rex");
    expect(dogActivityWords("coordinate_bots", { bot_ids: ["b1", "b2", "b3"] }, nameOf)).toBe("checking with 3 dogs");
    expect(dogActivityWords("mcp__agents__send_to_bot", { bot_id: "b2" }, nameOf)).toBe("handing Rex a task");
    expect(dogActivityWords("mcp__agents__ask_bot", { bot_id: "ghost" }, nameOf)).toBe("checking with a teammate");
    expect(dogActivityWords("mcp__agents__coordinate_bots", "not json", nameOf)).toBe("checking with a teammate");
  });

  it("says which dog is being made instead of the tool's name", () => {
    expect(dogActivityWords("mcp__agents__create_bot", { name: "Scout", role: "research" }, nameOf)).toBe("making Scout");
    expect(dogActivityWords("mcp__agents__create_bot", {}, nameOf)).toBe("making a new dog");
  });

  it("uses short human phrases for everyday tools and never a raw tool name", () => {
    expect(dogActivityWords("Bash", undefined, nameOf)).toBe("running a few commands");
    expect(dogActivityWords("Grep", undefined, nameOf)).toBe("sniffing around");
    expect(dogActivityWords("WebSearch", undefined, nameOf)).toBe("sniffing around the web");
    expect(dogActivityWords("mcp__computer__computer_batch", undefined, nameOf)).toBe("clicking around");
    expect(dogActivityWords("mcp__computer__request_secure_form", undefined, nameOf)).toBe("needs your input");
    expect(dogActivityWords("mcp__computer__fill_secure_field", undefined, nameOf)).toBe("signing in");
    expect(dogActivityWords("mcp__claude_ai_Gmail__search_threads", undefined, nameOf)).toBe("working in Gmail");
    expect(dogActivityWords("mcp__claude_ai_Google_Calendar__list_events", undefined, nameOf)).toBe("working in Google Calendar");
    expect(dogActivityWords("mcp__composio__GMAIL_SEND_EMAIL", undefined, nameOf)).toBe("working in Gmail");
    expect(dogActivityWords("mcp__cloudflare__workers_list", undefined, nameOf)).toBe("working in Cloudflare");
    expect(dogActivityWords("mcp__laterdog__delegate_cloud_job", undefined, nameOf)).toBe("starting a cloud task");
    expect(dogActivityWords("mcp__laterdog__laterdog_workspace", undefined, nameOf)).toBe("working on it");
    expect(dogActivityWords("npm test -- --run", undefined, nameOf, true)).toBe("running a few commands");
  });

  it("stays quiet for the harness's own approval and error chips", () => {
    expect(dogActivityWords("auto-approved: Bash", undefined, nameOf)).toBeNull();
    expect(dogActivityWords("error: something", undefined, nameOf)).toBeNull();
  });
});

describe("what a teammate's result chip says", () => {
  it("says who replied, and never shows a raw budget or routing error", () => {
    expect(teammateResultLabel("Scout", "completed", undefined)).toBe("Scout replied");
    expect(teammateResultLabel("Scout", "completed", undefined, "Launch")).toBe("Scout replied · Launch");
    expect(teammateResultLabel("Scout", "failed", undefined)).toBe("Scout couldn't finish");
    expect(teammateResultLabel("Scout", "cancelled", undefined)).toBe("Scout stopped");
    expect(teammateResultLabel("Scout", "cancelled", undefined, undefined, "person")).toBe("Scout stopped");
    expect(teammateResultLabel("Scout", "failed", undefined, undefined, "capped")).toBe("Scout ran out of time");
    expect(teammateResultLabel("Scout", "cancelled", undefined, undefined, "interrupted")).toBe("Scout was interrupted");
    expect(teammateResultLabel("Scout", "completed", "Destination bot task no longer exists")).toBe("Scout's reply was held back");
  });

  it("names a shell step by its description or justification instead of the generic phrase", () => {
    expect(dogActivityWords("Bash", { command: "ls -la", description: "List files in current directory" }, nameOf)).toBe("list files in current directory");
    expect(dogActivityWords("Bash", JSON.stringify({ description: "  Run   the\n tests " }), nameOf)).toBe("run the tests");
    expect(dogActivityWords("exec_command", { cmd: "ls", justification: "Check the build output" }, nameOf)).toBe("check the build output");
    expect(dogActivityWords("Bash", { description: "", justification: "Look around" }, nameOf)).toBe("look around");
    expect(dogActivityWords("Bash", { description: "SSH into the box" }, nameOf)).toBe("SSH into the box");
    const long = dogActivityWords("Bash", { description: "Install every dependency the project needs before running anything else" }, nameOf)!;
    expect(long).toHaveLength(60);
    expect(long.endsWith("\u2026")).toBe(true);
    expect(dogActivityWords("Bash", { command: "rm -rf build" }, nameOf)).toBe("running a few commands");
    expect(dogActivityWords("Bash", { command: "ls", description: 4 }, nameOf)).toBe("running a few commands");
  });
});
