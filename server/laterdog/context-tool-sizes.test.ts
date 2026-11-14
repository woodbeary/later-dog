import { describe, expect, it } from "vitest";

import { availableTools, catalogProfileFromEnv } from "../drivers/agents-catalog.ts";
import { homeToolSizes } from "./context-tool-sizes.ts";
import { AGENTS_DEFER_RARE_ENV } from "./tool-loading.ts";

const ENV = { LATERDOG_BOT_ID: "b", LATERDOG_CLOUD_HOME: "1", LATERDOG_SKILL_AUTHORING_ENABLED: "1" };
const everyByte = availableTools(catalogProfileFromEnv(ENV)).reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)), 0);

describe("the size of the tools later.dog hands a dog", () => {
  it("counts every definition it sends when nothing waits to be loaded", () => {
    expect(homeToolSizes(ENV)).toEqual({ loadedBytes: everyByte, notLoadedBytes: 0 });
  });

  it("counts a tool that waits to be loaded by its name only, and keeps its full size apart", () => {
    const sizes = homeToolSizes({ ...ENV, [AGENTS_DEFER_RARE_ENV]: "1" })!;
    expect(sizes.notLoadedBytes).toBeGreaterThan(0);
    expect(sizes.loadedBytes).toBeLessThan(everyByte);
    expect(sizes.loadedBytes + sizes.notLoadedBytes).toBeGreaterThan(everyByte);
  });

  it("knows nothing when the dog has none of later.dog's tools", () => {
    expect(homeToolSizes(undefined)).toBeNull();
  });
});
