import type { AppConfig } from "../config.ts";
import { PAGE_AGENT_SOURCE, PAGE_CDP_PORT, PAGE_READ_MAX_CHARS, PAGE_TEXT_MAX_CHARS } from "./page-agent.ts";

export type ExecResult = { ok: boolean; exitCode: number | null; stdout: string; stderr: string };
export type RemoteExec = (command: string, signal: AbortSignal) => Promise<ExecResult>;
export type PageToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ref = { type: "string", pattern: "^e[0-9]{1,6}$" };
const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) =>
  ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } });

export const PAGE_TOOLS = [
  tool("page_open", "Open a URL in the browser on the cloud computer, the one the screen shows, and get the page's structure.", { url: { type: "string", pattern: "^https?://", maxLength: 2000 } }, ["url"]),
  tool("page_read", "Read the current page's structure: headings, text, tables, and links, buttons and fields with refs such as e12. selector narrows it to one part.", { selector: { type: "string", maxLength: 300 } }),
  tool("page_click", "Click the link or button with this ref.", { ref }, ["ref"]),
  tool("page_fill", "Replace the text in the field with this ref.", { ref, text: { type: "string", maxLength: 4000 } }, ["ref", "text"]),
  tool("page_select", "Choose an option, by its text or value, in the list with this ref.", { ref, option: { type: "string", maxLength: 300 } }, ["ref", "option"]),
  tool("page_press", "Press a key in the page, such as Enter, Tab or Escape.", { key: { type: "string", pattern: "^[A-Za-z0-9]{1,12}$" } }, ["key"]),
  tool("page_back", "Go back one page."),
  tool("page_text", "Read the full text of the element with this ref, or of the part a selector names.", { ref, selector: { type: "string", maxLength: 300 } }),
];

export const PAGE_FIRST_PROMPT =
  " For a web page, read its structure with page_open and page_read and act with the page tools; take a screenshot only when the structure does not show what you need, such as a picture, a canvas, a CAPTCHA or a window outside the page.";

export const PAGE_TOOL_NAMES: ReadonlySet<string> = new Set(PAGE_TOOLS.map((entry) => entry.name));

export function pageToolsEnabled(cfg: AppConfig): boolean {
  return cfg.features?.pageTools === true;
}

const PAGE_AGENT_B64 = Buffer.from(PAGE_AGENT_SOURCE).toString("base64");
const ACTIONS: Record<string, string> = {
  page_open: "open", page_read: "read", page_click: "click", page_fill: "fill", page_select: "select", page_press: "press", page_back: "back", page_text: "text",
};

export function pageAgentInput(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const input: Record<string, unknown> = { action: ACTIONS[name], port: PAGE_CDP_PORT, max: PAGE_READ_MAX_CHARS, textMax: PAGE_TEXT_MAX_CHARS };
  if (typeof args.url === "string") input.url = args.url;
  if (typeof args.selector === "string") input.selector = args.selector;
  if (typeof args.ref === "string") input.ref = args.ref;
  if (typeof args.key === "string") input.key = args.key;
  if (typeof args.text === "string") input.value = args.text;
  if (typeof args.option === "string") input.value = args.option;
  return input;
}

export function pageAgentCommand(input: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(input)).toString("base64");
  return `node --input-type=module -e "$(printf %s '${PAGE_AGENT_B64}' | base64 -d)" '${payload}'`;
}

export function pageOpenLaunch(): string {
  return `curl -s -m 2 http://127.0.0.1:\${LATERDOG_PAGE_CDP_PORT:-${PAGE_CDP_PORT}}/json/version >/dev/null 2>&1 || (nohup xdg-open about:blank >/dev/null 2>&1 </dev/null &)`;
}

export async function runPageTool(exec: RemoteExec, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<PageToolResult> {
  if (!PAGE_TOOL_NAMES.has(name)) return { isError: true, content: [{ type: "text", text: "Unknown page tool." }] };
  const command = pageAgentCommand(pageAgentInput(name, args));
  const raw = await exec(name === "page_open" ? `${pageOpenLaunch()}; ${command}` : command, signal);
  let answer: { ok?: boolean; text?: string; error?: string } | null = null;
  try { answer = JSON.parse(raw.stdout.trim()); } catch {}
  if (!answer) return { isError: true, content: [{ type: "text", text: `The page tool did not answer: ${(raw.stderr || raw.stdout).trim().slice(-400) || `exit ${raw.exitCode}`}` }] };
  if (!answer.ok) return { isError: true, content: [{ type: "text", text: answer.error ?? "The page tool failed." }] };
  return { content: [{ type: "text", text: answer.text ?? "" }] };
}
