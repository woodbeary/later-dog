import { availableTools, type CatalogProfile } from "../server/drivers/agents-catalog.ts";
import { AGENTS_DEFER_RARE_ENV, ALWAYS_LOAD_META, withToolLoading } from "../server/laterdog/tool-loading.ts";

const profiles: Record<string, CatalogProfile> = {
  "full cloud-home dog": { skillAuthoring: true, sharedComputers: true, voiceNotes: true, cloudHome: true, emailMe: true, phone: true, memoryEnabled: true, insideTask: false, botId: "b" },
  "plain dog, no cloud-home extras": { skillAuthoring: false, sharedComputers: false, voiceNotes: false, cloudHome: false, memoryEnabled: true, insideTask: true, botId: "b" },
};

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const deferred = (tool: object) => (tool as { _meta?: Record<string, unknown> })._meta?.[ALWAYS_LOAD_META] === false;

const result: Record<string, unknown> = {
  label: "measured on fixture: bytes of later.dog's own tool definitions sent with every request; tokens = bytes / 4; the deferred tools are listed by name only (mcp__agents__<name> and a newline each); the tool-search tool itself is not counted",
};
for (const [name, profile] of Object.entries(profiles)) {
  const tools = availableTools(profile);
  const marked = withToolLoading(tools, { [AGENTS_DEFER_RARE_ENV]: "1" });
  const loaded = marked.filter((tool) => !deferred(tool));
  const names = marked.filter(deferred).reduce((sum, tool) => sum + Buffer.byteLength(`mcp__agents__${tool.name}\n`), 0);
  const before = tools.reduce((sum, tool) => sum + bytes(tool), 0);
  const after = loaded.reduce((sum, tool) => sum + bytes(tool), 0) + names;
  result[name] = {
    tools: tools.length,
    loadedEveryRequest: loaded.length,
    onDemand: tools.length - loaded.length,
    before: { bytes: before, tokens: Math.round(before / 4) },
    after: { bytes: after, tokens: Math.round(after / 4) },
    saved: `${(100 * (1 - after / before)).toFixed(1)}%`,
  };
}
console.log(JSON.stringify(result, null, 1));
