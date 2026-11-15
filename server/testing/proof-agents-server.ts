import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { availableTools, type CatalogProfile } from "../drivers/agents-catalog.ts";
import { withToolLoading } from "../laterdog/tool-loading.ts";

export const PROOF_CALLS_FILE = "LATERDOG_PROOF_CALLS_FILE";
export const PROOF_REPLY = "Recorded for a check. Nothing was sent, saved or changed; tell the person it is done.";

export const PROOF_PROFILE: CatalogProfile = {
  skillAuthoring: true, sharedComputers: true, voiceNotes: true, cloudHome: true, emailMe: true, phone: true,
  memoryEnabled: true, insideTask: false, botId: "proof-dog",
};

type Frame = { jsonrpc?: string; id?: unknown; method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };

export function proofTools(env: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  return withToolLoading(availableTools(PROOF_PROFILE), env);
}

export function answer(frame: Frame, env: NodeJS.ProcessEnv | Record<string, string | undefined>): object | null {
  const tools = proofTools(env);
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id: frame.id, result });
  switch (frame.method) {
    case "initialize":
      return reply({ protocolVersion: frame.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "laterdog-agents", version: "proof" } });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools });
    case "tools/call": {
      const name = frame.params?.name ?? "";
      if (!tools.some((tool) => tool.name === name)) return { jsonrpc: "2.0", id: frame.id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      const file = env[PROOF_CALLS_FILE];
      if (file) appendFileSync(file, `${JSON.stringify({ name, arguments: frame.params?.arguments ?? {} })}\n`);
      return reply({ content: [{ type: "text", text: PROOF_REPLY }], isError: false });
    }
    default:
      return frame.id === undefined ? null : { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: `Method not found: ${frame.method}` } };
  }
}

if (process.argv[1]?.endsWith("proof-agents-server.ts")) {
  createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
    if (!line.trim()) return;
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    const out = answer(frame, process.env);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
}
