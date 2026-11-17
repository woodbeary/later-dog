import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

import { imageTokens, jpegSize } from "./screen-commands.ts";

export type CallResult = { content: unknown[]; isError?: boolean };

export const CALL_LOG = "LATERDOG_BROWSER_STEPS_CALLS";

export function logCall(name: string, started: number, result: CallResult): void {
  const file = process.env[CALL_LOG];
  if (!file) return;
  const parts = Array.isArray(result.content) ? result.content as Array<{ type?: string; data?: string }> : [];
  const images = parts.filter((part) => part.type === "image");
  const imageBytes = images.reduce((sum, part) => sum + (part.data?.length ?? 0), 0);
  const imageTokenCount = images.reduce((sum, part) => {
    const size = jpegSize(Buffer.from(part.data ?? "", "base64"));
    return sum + (size ? imageTokens(size.width, size.height) : 0);
  }, 0);
  const textBytes = Buffer.byteLength(JSON.stringify(parts.filter((part) => part.type !== "image")));
  appendFileSync(file, `${JSON.stringify({ name, seconds: (performance.now() - started) / 1000, textBytes, imageBytes, imageTokens: imageTokenCount, isError: result.isError === true })}\n`);
}

export function serveStdio(name: string, handlers: { list(): Promise<unknown[]> | unknown[]; call(tool: string, args: Record<string, unknown>): Promise<CallResult> }): void {
  const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    const reply = (result: unknown) => write({ jsonrpc: "2.0", id: message.id, result });
    const fail = (error: unknown) => write({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
    if (message.method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name, version: "1" } });
    if (message.method === "tools/list") return void Promise.resolve(handlers.list()).then((tools) => reply({ tools }), fail);
    if (message.method === "tools/call") {
      const started = performance.now();
      const tool = String(message.params?.name ?? "");
      return void handlers.call(tool, message.params?.arguments ?? {}).then(
        (result) => { logCall(tool, started, result); reply(result); },
        (error) => {
          const result = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
          logCall(tool, started, result);
          reply(result);
        },
      );
    }
    reply({});
  });
  lines.on("close", () => process.exit(0));
}
