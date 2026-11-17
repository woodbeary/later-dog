import { agentBrowserIntegration, prepareBrowserSessionState } from "../../server/browser-engine.ts";
import { BrowserRuntime } from "../../server/browser-runtime.ts";
import { serveStdio, type CallResult } from "./stdio-mcp.ts";

const binary = process.env.LATERDOG_BROWSER_STEPS_ENGINE;
const home = process.env.LATERDOG_BROWSER_STEPS_HOME;
if (!binary || !home) throw new Error("LATERDOG_BROWSER_STEPS_ENGINE and LATERDOG_BROWSER_STEPS_HOME are required");

const session = "browser-steps";
const env = { HOME: home, PATH: process.env.PATH ?? "", ...(process.env.AGENT_BROWSER_EXECUTABLE_PATH ? { AGENT_BROWSER_EXECUTABLE_PATH: process.env.AGENT_BROWSER_EXECUTABLE_PATH } : {}) };
await prepareBrowserSessionState(binary, session, { env, persistent: false });
const spec = agentBrowserIntegration({ binaryPath: binary, session, encryptionKey: "0".repeat(64), persistent: false, env });
const runtime = new BrowserRuntime();

serveStdio("browser", {
  list: async () => ((await runtime.agentRpc(session, spec, "tools/list", {})) as { tools: unknown[] }).tools,
  call: async (tool, args) => (await runtime.agentRpc(session, spec, "tools/call", { name: tool, arguments: args })) as CallResult,
});
