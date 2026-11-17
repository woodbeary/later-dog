import { availableTools, catalogProfileFromEnv } from "../drivers/agents-catalog.ts";
import { AGENTS_DEFER_RARE_ENV, ALWAYS_LOAD_META, withToolLoading } from "./tool-loading.ts";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const notLoaded = (tool: object) => (tool as { _meta?: Record<string, unknown> })._meta?.[ALWAYS_LOAD_META] === false;

export function homeToolSizes(agentsEnv: Record<string, string> | undefined, rareOnDemand = false): { loadedBytes: number; notLoadedBytes: number } | null {
  if (!agentsEnv) return null;
  const env = rareOnDemand ? { ...agentsEnv, [AGENTS_DEFER_RARE_ENV]: "1" } : agentsEnv;
  let marked: ReturnType<typeof availableTools>;
  try {
    marked = withToolLoading(availableTools(catalogProfileFromEnv(env)), env);
  } catch {
    return null;
  }
  let loadedBytes = 0;
  let notLoadedBytes = 0;
  for (const tool of marked) {
    if (notLoaded(tool)) {
      loadedBytes += Buffer.byteLength(`mcp__agents__${tool.name}\n`);
      notLoadedBytes += bytes(tool);
    } else {
      loadedBytes += bytes(tool);
    }
  }
  return { loadedBytes, notLoadedBytes };
}
