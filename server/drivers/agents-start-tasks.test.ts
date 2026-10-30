import { describe, expect, it, vi } from "vitest";

import { callTool, type ToolCallContext } from "./agents-call.ts";
import { availableTools, catalogProfileFromEnv, type CatalogProfile } from "./agents-catalog.ts";

function profile(overrides: Partial<CatalogProfile> = {}): CatalogProfile {
  return { skillAuthoring: false, sharedComputers: false, voiceNotes: false, cloudHome: false, botId: "dog-olive", ...overrides };
}

function context(apiResponse: ToolCallContext["client"]["apiResponse"]): ToolCallContext {
  return { botId: "dog-olive", threadId: "main", depth: 0, sharedComputers: false, client: { api: async () => ({}), apiResponse } };
}

describe("start_tasks for a dog", () => {
  it("is offered in a dog's own conversations but not inside a task it started", () => {
    expect(availableTools(profile()).map((tool) => tool.name)).toContain("start_tasks");
    expect(availableTools(profile({ insideTask: true })).map((tool) => tool.name)).not.toContain("start_tasks");
    expect(catalogProfileFromEnv({ LATERDOG_IN_TASK: "1" }).insideTask).toBe(true);
    expect(catalogProfileFromEnv({}).insideTask).toBe(false);
  });

  it("asks the home to start the tasks and hands the dog what it says", async () => {
    const apiResponse = vi.fn(async () => ({ ok: true, status: 200, body: { text: "Started a task: “Flights”." } }));
    const args = { tasks: [{ title: "Flights", instruction: "Find flights." }] };
    expect(await callTool("start_tasks", args, context(apiResponse))).toEqual({ text: "Started a task: “Flights”." });
    expect(apiResponse).toHaveBeenCalledWith("/api/internal/tasks/start", { method: "POST", body: JSON.stringify(args) });
    const refused = vi.fn(async () => ({ ok: false, status: 409, body: { error: "You're already working on a task." } }));
    expect(await callTool("start_tasks", args, context(refused))).toEqual({ text: "You're already working on a task.", isError: true });
  });
});
