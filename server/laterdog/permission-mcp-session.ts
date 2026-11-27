import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { parseAskQuestions, questionAnswersByQuestion } from "../../shared/ask-question.ts";
import { allowsTool, parseToolScope } from "../../shared/tool-scope.ts";

export type PermissionMcpEnv = Record<string, string | undefined>;

export interface PermissionMcpSession {
  line(text: string): void;
  close(): void;
}

interface AllowPermissionResult {
  behavior: "allow";
  updatedInput: object;
  updatedPermissions?: object[];
}

const TOOLS = [
  {
    name: "approve",
    description: "Ask the later.dog user whether a tool use is allowed",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string" },
        input: { type: "object" },
        tool_use_id: { type: "string" },
        agent_id: { type: "string" },
      },
      required: ["tool_name", "input"],
    },
  },
  {
    name: "ask_user",
    description:
      "Ask the human who owns this bot a question and wait for their answer. Use whenever you need a decision, a preference, missing information, or sign-off before doing something consequential — do not guess on things the owner would want to decide. Returns their answer as text.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question, with enough context to answer at a glance" },
        choices: {
          type: "array",
          items: { type: "string" },
          description: "Optional 2-5 suggested answers, shown as one-tap buttons",
        },
      },
      required: ["question"],
    },
  },
];

export function permissionMcpSession(env: PermissionMcpEnv, socketPath: string, write: (msg: unknown) => void): PermissionMcpSession {
  const selection = parseToolScope(env.LATERDOG_PERMISSION_TOOL_SCOPE === undefined
    ? undefined : (() => { try { return JSON.parse(env.LATERDOG_PERMISSION_TOOL_SCOPE); } catch { return null; } })());
  if (!selection.ok) throw new Error(selection.error);
  const allowQuestion = allowsTool(selection.scope, { kind: "mcp", server: "dog", name: "ask_user" });
  let closed = false;
  const waiting = new Map<string, (msg: any) => void>();
  const conn = connect(socketPath);
  conn.setEncoding("utf8");
  const dead = () => {
    for (const resolve of waiting.values()) {
      resolve({ behavior: "deny", message: "later.dog: permission broker unavailable — skip this action" });
    }
    waiting.clear();
  };
  conn.on("error", dead);
  conn.on("close", dead);
  let connBuf = "";
  conn.on("data", (chunk) => {
    connBuf += chunk;
    let nl;
    while ((nl = connBuf.indexOf("\n")) !== -1) {
      const line = connBuf.slice(0, nl);
      connBuf = connBuf.slice(nl + 1);
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.t === "answer") {
        waiting.get(msg.id)?.(msg);
        waiting.delete(msg.id);
      }
    }
  });

  const send = (obj: unknown) => { if (!closed) write(obj); };

  function askBroker(ask: Record<string, unknown>): Promise<any> {
    return new Promise((resolve) => {
      waiting.set(String(ask.id), resolve);
      if (conn.destroyed) return dead();
      try {
        conn.write(JSON.stringify(ask) + "\n");
      } catch {
        dead();
      }
    });
  }

  const ASK_USER_QUESTION = "AskUserQuestion";

  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

  async function answerNativeQuestions(input: unknown, provenance: { tool_use_id?: string; agent_id?: string } = {}): Promise<string> {
    const questions = parseAskQuestions(input);
    if (!questions?.length) {
      return JSON.stringify({
        behavior: "deny",
        message:
          "later.dog: this AskUserQuestion call had no answerable question (each one needs question text), so nobody was shown it. Ask again with a well-formed call, or continue without it.",
      });
    }
    const answer = await askBroker({
      t: "ask",
      id: randomUUID(),
      kind: "question",
      tool: ASK_USER_QUESTION,
      input: { questions },
      ...provenance,
    });
    if (answer.behavior === "deny") {
      return JSON.stringify({ behavior: "deny", message: answer.message || "Denied from later.dog" });
    }
    const answers =
      answer.source === "user" && typeof answer.message === "string"
        ? questionAnswersByQuestion(answer.message, questions)
        : {};
    return JSON.stringify({ behavior: "allow", updatedInput: { ...asRecord(input), answers } });
  }

  async function handle(msg: any) {
    if (msg.method === "initialize") {
      return send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "laterdog-permissions", version: "1" },
        },
      });
    }
    if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS.filter((tool) => tool.name === "approve" || allowQuestion) } });
    if (msg.method === "tools/call") {
      const name = msg.params?.name;
      const args = msg.params?.arguments ?? {};
      const provenance = { tool_use_id: typeof args.tool_use_id === "string" ? args.tool_use_id : undefined, agent_id: typeof args.agent_id === "string" ? args.agent_id : undefined };
      const reply = (text: string) => send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
      if (name === "ask_user" && !allowQuestion) return reply("later.dog: this question tool is excluded by the bot's tool selection.");
      if (name === "approve" && args.tool_name === ASK_USER_QUESTION) {
        return reply(await answerNativeQuestions(args.input, provenance));
      }
      const askId = randomUUID();
      const isQuestion = name === "ask_user";
      const answer: any = await askBroker(
        isQuestion
          ? { t: "ask", id: askId, kind: "question", tool: "ask_user", input: { question: args.question, choices: args.choices } }
          : { t: "ask", id: askId, tool: args.tool_name, input: args.input, ...provenance },
      );
      let text = answer.message || "No answer was given — use your best judgment.";
      if (!isQuestion) {
        if (answer.behavior === "allow") {
          const result: AllowPermissionResult = { behavior: "allow", updatedInput: args.input ?? {} };
          text = JSON.stringify(result);
        } else {
          text = JSON.stringify({ behavior: "deny", message: answer.message || "Denied from later.dog" });
        }
      }
      return reply(text);
    }
    if (String(msg.method ?? "").startsWith("notifications/")) return;
    if (msg.id != null) {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
    }
  }

  return {
    line(text) {
      if (closed || !text.trim()) return;
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      void handle(msg).catch(() => {});
    },
    close() {
      if (closed) return;
      closed = true;
      conn.destroy();
    },
  };
}
