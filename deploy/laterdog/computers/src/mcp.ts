import { TooLarge, json, readLimited } from "./http";
import { JSON_MAX_BYTES } from "./inputs";
import { MCP_PROTOCOL_VERSIONS, MCP_SERVER_NAME, MCP_SERVER_VERSION, TOOLS, argumentProblem, toolNamed } from "./mcp-tools";
import { type ScreenCheck, actionCommand, actionSummary, actionTimeoutMs, checkRequest, readScreenCheck } from "./mcp-screen";

export type McpComputerOp = "get" | "wake" | "sleep" | "exec" | "screenshot" | "desktop";

export interface McpBackend {
  screenChecks: boolean;
  list(): Promise<Response>;
  create(input: { name?: string; size?: string }): Promise<Response>;
  computer(op: McpComputerOp, id: string, input?: unknown): Promise<Response>;
  screenCheck(input: unknown): Promise<Response>;
  decide(input: unknown): Promise<Response>;
}

export interface McpDeps {
  backend: McpBackend;
  wait?: (ms: number) => Promise<void>;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const WAKE_POLLS = 15;
const WAKE_POLL_MS = 2000;
const SETTLE_MS = 500;
const LOADING_RETRIES = 3;
const LOADING_RETRY_MS = 1000;
const SCREEN_IMAGE_MAX_CHARS = 190_000;
const NO_SCREEN_CHECKS = "Screen checks come with a free trial or later.dog Cloud key. This key gets the screenshot only.";
const DECIDE_BODY_LIMIT_NOTE = "That screenshot is too large for a screen check, so only the screenshot is returned.";

const INSTRUCTIONS =
  "later.dog cloud computers and the Clef decision model. Create a computer, call computer_wake until it is running, then use computer_action "
  + "(mouse and keyboard, returns a screenshot and a screen check) and computer_exec (shell). Trial computers have open internet and passwordless root.";

class ToolFailure extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (message: string): Content => ({ type: "text", text: message });
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function rpc(id: string | number | null, body: { result: unknown } | { error: { code: number; message: string } }, status = 200): Response {
  return json({ jsonrpc: "2.0", id, ...body }, status);
}

const refused = (id: string | number | null, code: number, message: string, status = 200) => rpc(id, { error: { code, message } }, status);

const MESSAGE_MAX_CHARS = 300;
const SERVER_PROBLEM = "The computer had a problem. Try again in a minute.";
const PLAIN_SERVER_CODES = new Set(["busy_today", "not_included", "trials_off", "upstream_failed", "not_configured"]);

async function failure(response: Response): Promise<ToolFailure> {
  let message = `The computers service answered ${response.status}.`;
  let code = "";
  try {
    const body: unknown = await response.json();
    const error = isRecord(body) && isRecord(body.error) ? body.error : {};
    if (typeof error.message === "string" && error.message.length > 0) message = error.message;
    if (typeof error.code === "string") code = error.code;
  } catch {}
  if (response.status >= 500 && !PLAIN_SERVER_CODES.has(code)) {
    console.error(`laterdog computers: mcp got ${response.status} ${code}: ${message.slice(0, 2000)}`);
    return new ToolFailure(SERVER_PROBLEM);
  }
  return new ToolFailure(message.length > MESSAGE_MAX_CHARS ? `${message.slice(0, MESSAGE_MAX_CHARS)}...` : message);
}

async function data(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) throw await failure(response);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new ToolFailure("The computers service answered something unexpected.");
  return body;
}

async function picture(response: Response): Promise<Uint8Array> {
  if (!response.ok) throw await failure(response);
  return new Uint8Array(await response.arrayBuffer());
}

const described = (computer: unknown) => (isRecord(computer) ? computer : {});

function structured(value: Record<string, unknown>, note?: string): ToolResult {
  return { content: [text(note ? `${note}\n${pretty(value)}` : pretty(value))], structuredContent: value };
}

async function listTool({ backend }: McpDeps): Promise<ToolResult> {
  return structured(await data(await backend.list()));
}

async function createTool({ backend }: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const body = await data(await backend.create({
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(typeof args.size === "string" ? { size: args.size } : {}),
  }));
  return structured(body, "Created. It is starting; call computer_wake to wait until it is running.");
}

async function wakeTool({ backend, wait = sleep }: McpDeps, id: string): Promise<ToolResult> {
  let computer = described((await data(await backend.computer("wake", id))).computer);
  for (let poll = 0; computer.state === "starting" && poll < WAKE_POLLS; poll++) {
    await wait(WAKE_POLL_MS);
    computer = described((await data(await backend.computer("get", id))).computer);
  }
  if (computer.state === "running") return structured({ computer, ready: true });
  if (computer.state === "error") throw new ToolFailure(`The computer could not start${typeof computer.error === "string" ? `: ${computer.error}` : "."}`);
  return structured({ computer, ready: false }, "It is still starting. Call computer_wake again in a few seconds.");
}

async function sleepTool({ backend }: McpDeps, id: string): Promise<ToolResult> {
  return structured(await data(await backend.computer("sleep", id)));
}

async function screenshotTool({ backend }: McpDeps, id: string): Promise<ToolResult> {
  const bytes = await picture(await backend.computer("screenshot", id));
  return { content: [text(`Screenshot of ${id}, ${bytes.byteLength} bytes.`), { type: "image", data: toBase64(bytes), mimeType: "image/jpeg" }] };
}

async function viewerTool({ backend }: McpDeps, id: string): Promise<ToolResult> {
  return structured(await data(await backend.computer("desktop", id)), "Open this link in a browser to watch and take over the screen. It expires; keep it private.");
}

const EXEC_TEXT_MAX_CHARS = 100_000;

function cut(output: unknown): string {
  const value = typeof output === "string" ? output : "";
  if (value.length <= EXEC_TEXT_MAX_CHARS) return value;
  return `${value.slice(0, EXEC_TEXT_MAX_CHARS)}\n[later.dog: output cut; showing the first ${EXEC_TEXT_MAX_CHARS} of ${value.length} characters]`;
}

async function execTool({ backend }: McpDeps, id: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await data(await backend.computer("exec", id, {
    command: args.command,
    timeoutMs: args.timeout_ms ?? 30_000,
    ...(typeof args.cwd === "string" ? { cwd: args.cwd } : {}),
  }));
  const shown = { exitCode: result.exitCode, stdout: cut(result.stdout), stderr: cut(result.stderr), timedOut: result.timedOut === true };
  return { content: [text(`${result.timedOut === true ? "The command ran out of time and was stopped.\n" : ""}${pretty(shown)}`)] };
}

const asDataUrl = (bytes: Uint8Array) => `data:image/jpeg;base64,${toBase64(bytes)}`;

async function decideTool({ backend }: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const images = Array.isArray(args.images) ? [...(args.images as string[])] : [];
  if (typeof args.computer_id === "string") {
    if (images.length >= 4) throw new ToolFailure("Send at most four images, counting the computer's screenshot.");
    images.push(asDataUrl(await picture(await backend.computer("screenshot", args.computer_id))));
  }
  const answer = await data(await backend.decide({
    state: args.state,
    questions: args.questions,
    ...(images.length > 0 ? { images } : {}),
    ...(args.model === undefined ? {} : { model: args.model }),
  }));
  return structured(answer);
}

async function actionTool(deps: McpDeps, id: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { backend, wait = sleep } = deps;
  const command = actionCommand(args);
  if (!command.ok) throw new ToolFailure(command.message);
  const expect = typeof args.expect === "string" ? args.expect : undefined;
  const checking = backend.screenChecks;
  const before = checking ? await picture(await backend.computer("screenshot", id)) : new Uint8Array(0);
  const ran = await data(await backend.computer("exec", id, { command: command.command, timeoutMs: actionTimeoutMs(args) }));
  if (ran.exitCode !== 0 || ran.timedOut === true) {
    const reason = typeof ran.stderr === "string" && ran.stderr.trim() ? ran.stderr.trim().slice(0, 500) : `exit code ${String(ran.exitCode)}`;
    throw new ToolFailure(`The action did not work: ${reason}`);
  }
  const summary = actionSummary(args);
  const beforeUrl = checking ? asDataUrl(before) : "";
  let after = before;
  let check: ScreenCheck | { unavailable: string } = { unavailable: NO_SCREEN_CHECKS };
  let looks = 0;
  for (;;) {
    await wait(looks === 0 ? SETTLE_MS : LOADING_RETRY_MS);
    after = await picture(await backend.computer("screenshot", id));
    looks += 1;
    if (!checking) break;
    const afterUrl = asDataUrl(after);
    if (beforeUrl.length > SCREEN_IMAGE_MAX_CHARS || afterUrl.length > SCREEN_IMAGE_MAX_CHARS) {
      check = { unavailable: DECIDE_BODY_LIMIT_NOTE };
      break;
    }
    const response = await backend.screenCheck(checkRequest(summary, expect, beforeUrl, afterUrl));
    if (!response.ok) {
      check = { unavailable: (await failure(response)).message };
      break;
    }
    const read = readScreenCheck(await response.json(), looks);
    if (!read) {
      check = { unavailable: "The decision model gave an answer that could not be read." };
      break;
    }
    check = read;
    if (read.screen !== "loading" || looks > LOADING_RETRIES) break;
  }
  const summaryOut: Record<string, unknown> = { computer_id: id, did: summary, screen_check: check };
  if ("screen" in check && ["login", "two_factor", "captcha"].includes(check.screen)) {
    summaryOut.needs_a_person = "This needs a person: use computer_viewer_link so they can sign in or solve it themselves.";
  }
  return { content: [text(pretty(summaryOut)), { type: "image", data: toBase64(after), mimeType: "image/jpeg" }], structuredContent: summaryOut };
}

async function callTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const id = typeof args.computer_id === "string" ? args.computer_id : "";
  switch (name) {
    case "computer_list":
      return listTool(deps);
    case "computer_create":
      return createTool(deps, args);
    case "computer_wake":
      return wakeTool(deps, id);
    case "computer_sleep":
      return sleepTool(deps, id);
    case "computer_screenshot":
      return screenshotTool(deps, id);
    case "computer_action":
      return actionTool(deps, id, args);
    case "computer_exec":
      return execTool(deps, id, args);
    case "computer_viewer_link":
      return viewerTool(deps, id);
    default:
      return decideTool(deps, args);
  }
}

async function runTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return await callTool(deps, name, args);
  } catch (error) {
    if (error instanceof ToolFailure) return { content: [text(error.message)], isError: true };
    console.error(`laterdog computers: mcp tool ${name} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return { content: [text("Something went wrong on the computers service. The error was logged; try again.")], isError: true };
  }
}

function initialize(id: string | number, params: unknown): Response {
  if (!isRecord(params) || typeof params.protocolVersion !== "string" || !isRecord(params.capabilities) || !isRecord(params.clientInfo)) {
    return refused(id, -32602, "initialize needs protocolVersion, capabilities and clientInfo.");
  }
  const asked = params.protocolVersion;
  const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1]!;
  return rpc(id, {
    result: {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      instructions: INSTRUCTIONS,
    },
  });
}

async function call(deps: McpDeps, id: string | number, params: unknown): Promise<Response> {
  if (!isRecord(params)) return refused(id, -32602, "tools/call needs a name and arguments.");
  const tool = toolNamed(params.name);
  if (!tool) return refused(id, -32602, `There is no tool named ${typeof params.name === "string" ? params.name : "that"}. Use tools/list to see them.`);
  const args = params.arguments === undefined ? {} : params.arguments;
  const problem = argumentProblem(tool, args);
  if (problem) return rpc(id, { result: { content: [text(problem)], isError: true } satisfies ToolResult });
  return rpc(id, { result: await runTool(deps, tool.name, args as Record<string, unknown>) });
}

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  let bytes: Uint8Array;
  try {
    bytes = await readLimited(request.body, JSON_MAX_BYTES);
  } catch (error) {
    if (error instanceof TooLarge) return refused(null, -32600, error.message, 413);
    throw error;
  }
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refused(null, -32700, "The body is not valid JSON.", 400);
  }
  if (Array.isArray(message)) return refused(null, -32600, "Send one JSON-RPC message per request; batches are not supported.", 400);
  if (!isRecord(message) || message.jsonrpc !== "2.0") return refused(null, -32600, 'Send a JSON-RPC 2.0 message with "jsonrpc": "2.0".', 400);
  const id = message.id;
  if (typeof message.method !== "string") {
    return id === undefined || "result" in message || "error" in message ? new Response(null, { status: 202 }) : refused(null, -32600, "A request needs a method.", 400);
  }
  if (id === undefined) return new Response(null, { status: 202 });
  if (typeof id !== "string" && (typeof id !== "number" || !Number.isFinite(id))) return refused(null, -32600, "The id must be a string or a number.", 400);
  switch (message.method) {
    case "initialize":
      return initialize(id, message.params);
    case "ping":
      return rpc(id, { result: {} });
    case "tools/list":
      return rpc(id, { result: { tools: TOOLS } });
    case "tools/call":
      return call(deps, id, message.params);
    default:
      return refused(id, -32601, `This server does not offer ${message.method}.`);
  }
}
