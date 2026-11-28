import { availableTools, catalogProfileFromEnv } from "../drivers/agents-catalog.ts";
import { callTool, capResult, toolCallContextFromEnv, withToolUseId } from "../drivers/agents-call.ts";
import type { Json } from "../drivers/agents-client.ts";
import { withToolLoading } from "./tool-loading.ts";

export type AgentsMcpEnv = Record<string, string | undefined>;

export interface AgentsMcpSession {
  line(text: string): void;
  close(): void;
}

export function agentsMcpSession(env: AgentsMcpEnv, send: (msg: Json) => void): AgentsMcpSession {
  const tools = withToolLoading(availableTools(catalogProfileFromEnv(env)), env);
  const context = toolCallContextFromEnv(env);
  const running = new Map<unknown, AbortController>();
  let closed = false;
  const reply = (msg: Json) => { if (!closed) send(msg); };
  const ok = (id: unknown, result: unknown) => reply({ jsonrpc: "2.0", id, result });
  const rpcErr = (id: unknown, code: number, message: string) => reply({ jsonrpc: "2.0", id, error: { code, message } });
  const textResult = (id: unknown, text: string, isError = false) => ok(id, { content: [{ type: "text", text }], isError });

  async function handle(msg: Json) {
    const id = msg.id;
    const method = msg.method as string | undefined;
    if (!method) return;
    const params = (msg.params ?? {}) as Json;
    switch (method) {
      case "initialize":
        ok(id, {
          protocolVersion: (params.protocolVersion as string) ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "laterdog-agents", version: "0.1.0" },
        });
        return;
      case "notifications/cancelled":
        running.get(params.requestId)?.abort();
        return;
      case "notifications/initialized":
        return;
      case "ping":
        ok(id, {});
        return;
      case "tools/list":
        ok(id, { tools });
        return;
      case "tools/call": {
        const name = params.name as string;
        if (!tools.some((t) => t.name === name)) return rpcErr(id, -32602, `Unknown tool: ${name}`);
        const controller = new AbortController();
        running.set(id, controller);
        try {
          const { text, isError, passthrough } = await callTool(name, (params.arguments ?? {}) as Json, { ...withToolUseId(context, params._meta), signal: controller.signal });
          if (passthrough) ok(id, passthrough);
          else textResult(id, name === "tool_result_read" ? text : await capResult(text, context), isError);
        } catch (e) {
          textResult(id, await capResult((e as Error).message, context), true);
        } finally {
          running.delete(id);
        }
        return;
      }
      default:
        if (id !== undefined) rpcErr(id, -32601, `Method not found: ${method}`);
    }
  }

  return {
    line(text) {
      const t = text.trim();
      if (!t || closed) return;
      let msg: Json;
      try {
        msg = JSON.parse(t) as Json;
      } catch {
        return;
      }
      void handle(msg).catch((e) => {
        if (msg.id !== undefined) rpcErr(msg.id, -32603, (e as Error).message);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const controller of running.values()) controller.abort();
      running.clear();
    },
  };
}
