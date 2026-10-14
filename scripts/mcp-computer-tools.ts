import { TOOLS as WORKER_TOOLS, argumentProblem, toolNamed } from "../deploy/laterdog/computers/src/mcp-tools.ts";
import { ComputersConfigError, computersConnection, computersKey, readCapped, type ComputersConnection } from "../server/laterdog/cloud-computers.ts";

export const COMPUTER_TOOLS = WORKER_TOOLS;

const MAX_ANSWER_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
const EXEC_GRACE_MS = 30_000;

export const NOT_SET_UP =
  "later.dog Cloud is not set up on this Mac. Start the free trial in later.dog, or set LATERDOG_COMPUTERS_API to your own computers service.";

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ComputerToolResult {
  content: ToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export class ComputerToolOutput {
  constructor(readonly result: ComputerToolResult) {}
}

export interface ComputerProxyDeps {
  connection?: () => ComputersConnection | null;
  key?: (connection: ComputersConnection) => string;
  fetch?: typeof fetch;
}

export const isComputerTool = (name: unknown): boolean => toolNamed(name) !== undefined;

export function computerToolProblem(name: string, args: unknown): string | null {
  const tool = toolNamed(name);
  return tool ? argumentProblem(tool, args) : `Unknown tool: ${name}`;
}

export function mcpEndpoint(api: string): string {
  if (!api.endsWith("/v1")) throw new ComputersConfigError("later.dog's computers service address must end in /v1");
  return `${api.slice(0, -"/v1".length)}/mcp`;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function contentFrom(value: unknown): ToolContent[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const content: ToolContent[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    if (item.type === "text" && typeof item.text === "string") content.push({ type: "text", text: item.text });
    else if (item.type === "image" && typeof item.data === "string" && item.data.length % 4 === 0 && BASE64.test(item.data) && typeof item.mimeType === "string" && /^image\/(jpeg|png|webp)$/.test(item.mimeType)) {
      content.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else return null;
  }
  return content;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const unexpected = () => new Error("later.dog's computers service answered something unexpected");

function plainFailure(status: number, body: unknown, connection: ComputersConnection): Error {
  const theirs = isRecord(body) && isRecord(body.error) && typeof body.error.message === "string" ? body.error.message.trim().slice(0, 300) : "";
  if ((status === 401 || status === 403) && connection.source !== "trial") return new Error(`later.dog's computers service rejected the key in ${connection.keyFile}`);
  if (theirs) return new Error(theirs);
  if (status === 429) return new Error("later.dog's computers service is rate-limiting this Mac. Wait a minute and try again.");
  return new Error(`later.dog's computers service could not complete that request (${status})`);
}

export async function callComputerTool(
  name: string,
  args: Record<string, unknown>,
  deps: ComputerProxyDeps = {},
  signal?: AbortSignal,
): Promise<ComputerToolResult> {
  const connection = (deps.connection ?? computersConnection)();
  if (!connection) throw new Error(NOT_SET_UP);
  const key = (deps.key ?? computersKey)(connection);
  const endpoint = mcpEndpoint(connection.api);
  const wanted = name === "computer_exec" && typeof args.timeout_ms === "number" ? args.timeout_ms + EXEC_GRACE_MS : DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(wanted);
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(endpoint, {
      method: "POST",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(timeout.aborted ? "later.dog's computers service did not answer in time" : "later.dog's computers service could not be reached");
  }
  let body: unknown = null;
  let unreadable = false;
  try {
    body = JSON.parse((await readCapped(response, MAX_ANSWER_BYTES, unexpected)).toString("utf8"));
  } catch {
    unreadable = true;
  }
  if (!response.ok) throw plainFailure(response.status, body, connection);
  if (unreadable) throw unexpected();
  if (!isRecord(body)) throw unexpected();
  if (isRecord(body.error)) throw new Error(typeof body.error.message === "string" ? body.error.message.slice(0, 300) : "later.dog's computers service refused that call");
  const result = isRecord(body.result) ? body.result : null;
  const content = result ? contentFrom(result.content) : null;
  if (!result || !content) throw unexpected();
  return {
    content,
    ...(isRecord(result.structuredContent) ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError === true ? { isError: true } : {}),
  };
}
