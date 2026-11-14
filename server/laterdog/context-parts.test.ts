import { describe, expect, it } from "vitest";

import { CONTEXT_PART_IDS, type ContextBreakdown } from "../../shared/context-breakdown.ts";
import { breakdownFromEngine, ENGINE_CATEGORY_PARTS, ENGINE_DEFERRED_CATEGORIES, engineCategoryPart, estimatedBreakdown, estimateSizesOf } from "./context-parts.ts";

const ENGINE_IDS = ["system_prompt", "system_tools", "mcp_tools", "mcp_instructions", "mcp_tools_deferred", "system_tools_deferred", "custom_agents", "memory_files", "skills", "messages", "autocompact_buffer", "compact_buffer", "free_space"];

function engineAnswer(overrides: Record<string, unknown> = {}) {
  return {
    categories: [
      { id: "system_prompt", name: "System prompt", tokens: 9_500, color: "promptBorder", kind: "used" },
      { id: "system_tools", name: "System tools", tokens: 21_000, color: "inactive", kind: "used" },
      { id: "mcp_tools", name: "MCP tools", tokens: 16_200, color: "cyan", kind: "used" },
      { id: "mcp_instructions", name: "MCP server instructions", tokens: 3_000, color: "green", kind: "used" },
      { id: "mcp_tools_deferred", name: "MCP tools (deferred)", tokens: 451_500, color: "inactive", isDeferred: true, kind: "deferred" },
      { id: "memory_files", name: "Memory files", tokens: 9_600, color: "claude", kind: "used" },
      { id: "skills", name: "Skills", tokens: 10_000, color: "warning", kind: "used" },
      { id: "messages", name: "Messages", tokens: 128_800, color: "purple", kind: "used" },
      { id: "autocompact_buffer", name: "Autocompact buffer", tokens: 33_000, color: "inactive", kind: "buffer" },
      { id: "free_space", name: "Free space", tokens: 768_900, color: "promptBorder", kind: "free" },
    ],
    totalTokens: 198_100,
    maxTokens: 1_000_000,
    rawMaxTokens: 1_000_000,
    autocompactSource: "model-default",
    percentage: 20,
    autoCompactThreshold: 967_000,
    isAutoCompactEnabled: true,
    memoryFiles: [{ path: "/Users/someone/project/CLAUDE.md", type: "Project", tokens: 9_600 }],
    mcpTools: [{ name: "mcp__agents__secret_tool_name", serverName: "agents", tokens: 200 }],
    messageBreakdown: { toolCallsByType: [{ name: "Bash", callTokens: 1, resultTokens: 2 }] },
    ...overrides,
  };
}

const sum = (breakdown: ContextBreakdown, pick: (part: ContextBreakdown["parts"][number]) => boolean) =>
  breakdown.parts.filter(pick).reduce((total, part) => total + part.tokens, 0);
const used = (part: ContextBreakdown["parts"][number]) => !part.deferred && part.id !== "reserve" && part.id !== "free";
const inWindow = (part: ContextBreakdown["parts"][number]) => !part.deferred;

describe("the engine's categories become later.dog's parts", () => {
  it("places every category the engine can send", () => {
    expect(ENGINE_IDS.every((id) => Object.hasOwn(ENGINE_CATEGORY_PARTS, id) || ENGINE_DEFERRED_CATEGORIES.has(id))).toBe(true);
    expect(ENGINE_IDS.map((id) => [id, engineCategoryPart({ id })])).toEqual([
      ["system_prompt", { id: "instructions", deferred: false }],
      ["system_tools", { id: "tools", deferred: false }],
      ["mcp_tools", { id: "tools", deferred: false }],
      ["mcp_instructions", { id: "instructions", deferred: false }],
      ["mcp_tools_deferred", { id: "tools", deferred: true }],
      ["system_tools_deferred", { id: "tools", deferred: true }],
      ["custom_agents", { id: "helpers", deferred: false }],
      ["memory_files", { id: "memory", deferred: false }],
      ["skills", { id: "skills", deferred: false }],
      ["messages", { id: "conversation", deferred: false }],
      ["autocompact_buffer", { id: "reserve", deferred: false }],
      ["compact_buffer", { id: "reserve", deferred: false }],
      ["free_space", { id: "free", deferred: false }],
    ]);
  });

  it("puts a category it does not know into everything else by its kind, never dropping it", () => {
    expect(engineCategoryPart({ id: "brand_new", name: "Brand new", kind: "used" })).toEqual({ id: "other", deferred: false });
    expect(engineCategoryPart({ id: "brand_new", kind: "buffer" })).toEqual({ id: "reserve", deferred: false });
    expect(engineCategoryPart({ id: "brand_new", kind: "free" })).toEqual({ id: "free", deferred: false });
    expect(engineCategoryPart({ id: "brand_new", kind: "deferred" })).toEqual({ id: "tools", deferred: true });
    expect(engineCategoryPart({ name: "Something else" })).toEqual({ id: "other", deferred: false });
  });

  it("falls back to the engine's names only when there is no id or kind", () => {
    expect(engineCategoryPart({ name: "Messages" })).toEqual({ id: "conversation", deferred: false });
    expect(engineCategoryPart({ name: "Free space" })).toEqual({ id: "free", deferred: false });
    expect(engineCategoryPart({ name: "Autocompact buffer" })).toEqual({ id: "reserve", deferred: false });
    expect(engineCategoryPart({ name: "Plugin tools (deferred)" })).toEqual({ id: "tools", deferred: true });
    expect(engineCategoryPart({ id: "messages", name: "Free space" })).toEqual({ id: "conversation", deferred: false });
  });

  it("keeps the engine's sizes and nothing else", () => {
    const breakdown = breakdownFromEngine(engineAnswer(), 1_700_000_000_000)!;
    expect(breakdown).toEqual({
      at: 1_700_000_000_000,
      source: "engine",
      total: 198_100,
      window: 1_000_000,
      compactsAt: 967_000,
      parts: [
        { id: "conversation", tokens: 128_800 },
        { id: "tools", tokens: 37_200 },
        { id: "instructions", tokens: 12_500 },
        { id: "skills", tokens: 10_000 },
        { id: "memory", tokens: 9_600 },
        { id: "reserve", tokens: 33_000 },
        { id: "free", tokens: 768_900 },
        { id: "tools", tokens: 451_500, deferred: true },
      ],
    });
    const text = JSON.stringify(breakdown);
    for (const leak of ["CLAUDE.md", "/Users", "secret_tool_name", "Bash", "Messages", "System prompt", "agents"]) expect(text).not.toContain(leak);
    expect(breakdown.parts.every((part) => (CONTEXT_PART_IDS as readonly string[]).includes(part.id))).toBe(true);
  });

  it("makes the parts add up to the engine's total and the window", () => {
    const breakdown = breakdownFromEngine(engineAnswer(), 1)!;
    expect(sum(breakdown, used)).toBe(breakdown.total);
    expect(sum(breakdown, inWindow)).toBe(breakdown.window);
  });

  it("still adds up when the engine's total and its own rows disagree", () => {
    const higher = breakdownFromEngine(engineAnswer({ totalTokens: 200_000 }), 1)!;
    expect(sum(higher, used)).toBe(200_000);
    expect(higher.parts.find((part) => part.id === "conversation")!.tokens).toBe(130_700);
    expect(sum(higher, inWindow)).toBe(1_000_000);
    const lower = breakdownFromEngine(engineAnswer({ totalTokens: 60_000 }), 1)!;
    expect(sum(lower, used)).toBe(60_000);
    expect(sum(lower, inWindow)).toBe(1_000_000);
    const unknown = breakdownFromEngine(engineAnswer({ categories: [...engineAnswer().categories, { id: "brand_new", name: "Brand new", tokens: 4_000, kind: "used" }], totalTokens: 202_100 }), 1)!;
    expect(unknown.parts).toContainEqual({ id: "other", tokens: 4_000 });
    expect(sum(unknown, used)).toBe(202_100);
    expect(sum(unknown, inWindow)).toBe(1_000_000);
  });

  it("gives no compaction point when the engine will not compact on its own", () => {
    expect(breakdownFromEngine(engineAnswer({ isAutoCompactEnabled: false }), 1)!.compactsAt).toBeUndefined();
    expect(breakdownFromEngine(engineAnswer({ autoCompactThreshold: undefined }), 1)!.compactsAt).toBeUndefined();
  });

  it("refuses an answer it cannot read", () => {
    expect(breakdownFromEngine(null, 1)).toBeNull();
    expect(breakdownFromEngine({ categories: [] }, 1)).toBeNull();
    expect(breakdownFromEngine({ maxTokens: 1000 }, 1)).toBeNull();
    expect(breakdownFromEngine([], 1)).toBeNull();
  });
});

describe("the home's own estimate", () => {
  const sizes = estimateSizesOf([
    { id: "persona", bytes: 4_000 },
    { id: "soul", bytes: 6_000 },
    { id: "memory", bytes: 8_000 },
    { id: "skills", bytes: 2_000 },
    { id: "skill-instructions", bytes: 2_000 },
  ], { loadedBytes: 40_000, notLoadedBytes: 12_000 });

  it("counts four bytes to a token, as the measuring scripts do", () => {
    expect(sizes).toEqual({ instructions: 2_500, memory: 2_000, skills: 1_000, tools: 10_000, toolsNotLoaded: 3_000 });
  });

  it("calls the rest of the engine's total the conversation and marks it all an estimate", () => {
    const breakdown = estimatedBreakdown(sizes, { tokens: 40_000, window: 200_000 }, 5)!;
    expect(breakdown).toEqual({
      at: 5,
      source: "estimate",
      total: 40_000,
      window: 200_000,
      parts: [
        { id: "conversation", tokens: 24_500 },
        { id: "tools", tokens: 10_000 },
        { id: "instructions", tokens: 2_500 },
        { id: "skills", tokens: 1_000 },
        { id: "memory", tokens: 2_000 },
        { id: "free", tokens: 160_000 },
        { id: "tools", tokens: 3_000, deferred: true },
      ],
    });
    expect(sum(breakdown, used)).toBe(40_000);
    expect(sum(breakdown, inWindow)).toBe(200_000);
  });

  it("shows the total alone when its parts would come to more than the total", () => {
    expect(estimatedBreakdown(sizes, { tokens: 9_000, window: 200_000 }, 5)).toEqual({ at: 5, source: "estimate", total: 9_000, window: 200_000, parts: [] });
  });

  it("has nothing to say without a total and a window", () => {
    expect(estimatedBreakdown(sizes, {}, 5)).toBeNull();
    expect(estimatedBreakdown(sizes, { tokens: 1_000 }, 5)).toBeNull();
    expect(estimatedBreakdown(sizes, { tokens: 0, window: 1_000 }, 5)).toBeNull();
  });
});
