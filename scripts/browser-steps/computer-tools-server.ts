import { computerToolsFor, runCloudComputerTool } from "../../server/cloud-computer-tools.ts";
import type { AppConfig } from "../../server/config.ts";
import { localExec } from "./no-vision.ts";
import { serveStdio } from "./stdio-mcp.ts";

export const LEFT_OUT: ReadonlySet<string> = new Set(["exec", "request_secure_form", "fill_secure_field"]);

export function servedTools(cfg: AppConfig) {
  return computerToolsFor(cfg).filter((tool) => !LEFT_OUT.has(tool.name));
}

if (import.meta.main) {
  const cfg = (process.env.LATERDOG_BROWSER_STEPS_PAGE_TOOLS === "1" ? { features: { pageTools: true } } : {}) as AppConfig;
  const exec = localExec({});
  serveStdio("computer", {
    list: () => servedTools(cfg),
    call: async (tool, args) => LEFT_OUT.has(tool)
      ? { isError: true, content: [{ type: "text", text: "Unknown cloud computer tool. Use one of the advertised computer tools." }] }
      : runCloudComputerTool(cfg, "fixture", tool, args, new AbortController().signal, undefined, undefined, exec),
  });
}
