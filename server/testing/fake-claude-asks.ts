import { spawn } from "node:child_process";

interface McpServer { command?: string; args?: string[]; env?: Record<string, string> }

export function dogServer(mcpConfig: unknown): McpServer | null {
  const server = (mcpConfig as { mcpServers?: Record<string, McpServer> } | null)?.mcpServers?.dog;
  return server?.command ? server : null;
}

export function callDogTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(server.command!, server.args ?? [], { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const done = (text: string) => { child.kill(); resolve(text); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let reply: { id?: number; result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
        try { reply = JSON.parse(line); } catch { continue; }
        if (reply.id === 1) send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
        if (reply.id === 2) done(reply.result?.content?.map((part) => part.text ?? "").join("") ?? reply.error?.message ?? "");
      }
    });
    child.on("exit", () => resolve(""));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } } });
  });
}

export const ASKS_COMMAND = "pnpm install && pnpm test";

export const ASKS_QUESTION = {
  questions: [{
    question: "Which color should the report header be?",
    header: "Header",
    multiSelect: false,
    options: [
      { label: "Black", description: "Clean and easy to read on any background." },
      { label: "Gold", description: "Warm, and draws the eye to the top of the page." },
      { label: "Green", description: "Fresh, and pairs with growth themes." },
    ],
  }],
};
