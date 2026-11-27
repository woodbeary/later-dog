import readline from "node:readline";

import { agentsMcpSession } from "../laterdog/agents-mcp-session.ts";

const session = agentsMcpSession(process.env, (msg) => process.stdout.write(JSON.stringify(msg) + "\n"));

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => session.line(line));
rl.on("close", () => process.exit(0));
