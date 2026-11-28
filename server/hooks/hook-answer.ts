import { readFile } from "node:fs/promises";

const CONTEXT_EVENTS = new Set(["SessionStart", "UserPromptSubmit"]);
export const HOOK_BUDGET_MS = 4_000;
const HOOK_HELPER = /(?:^|\/)hooks\/laterdog-hook\.(?:ts|js)$/;
const LOCAL_URL = /^https?:\/\/127\.0\.0\.1(:\d+)?$/;

export interface HookAnswer {
  stdout: string;
  code: number;
}

export interface HookTarget {
  url: string;
  tokenFile: string;
}

export interface HookAnswerOptions extends HookTarget {
  payload: unknown;
  budgetMs?: number;
  requireReply?: boolean;
  fetch?: typeof fetch;
}

export function hookBudget(env: Record<string, string | undefined>): number {
  const requested = Number(env.LATERDOG_HOOK_TIMEOUT_MS);
  return Number.isFinite(requested) && requested > 0 ? Math.min(requested, HOOK_BUDGET_MS) : HOOK_BUDGET_MS;
}

function shellWords(command: string): string[] | null {
  const words: string[] = [];
  const pattern = /'((?:[^']|'\\'')*)'|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    if (match[1] !== undefined) words.push(match[1].replace(/'\\''/g, "'"));
    else if (/['"\\$`]/.test(match[2]!)) return null;
    else words.push(match[2]!);
  }
  return words;
}

export function laterdogHookTarget(command: string): HookTarget | null {
  const words = shellWords(command.trim());
  if (!words || words.length !== 4) return null;
  const [, helper, url, tokenFile] = words as [string, string, string, string];
  if (!HOOK_HELPER.test(helper) || !LOCAL_URL.test(url) || !tokenFile.startsWith("/")) return null;
  return { url, tokenFile };
}

export async function answerHook(options: HookAnswerOptions): Promise<HookAnswer> {
  const unavailable: HookAnswer = { stdout: "", code: options.requireReply ? 2 : 0 };
  const payload = options.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return unavailable;
  const record = payload as Record<string, unknown>;
  const event = typeof record.hook_event_name === "string" ? record.hook_event_name : "";
  if (!event || !LOCAL_URL.test(options.url) || !options.tokenFile) return unavailable;
  const token = await readFile(options.tokenFile, "utf8").then((text) => text.trim(), () => "");
  if (!token) return unavailable;
  const budgetMs = options.budgetMs ?? HOOK_BUDGET_MS;
  try {
    const response = await (options.fetch ?? fetch)(`${options.url}/api/internal/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ event, payload: record }),
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(200, budgetMs - 300)),
    });
    if (!response.ok) return unavailable;
    const body = (await response.json().catch(() => null)) as { ok?: unknown; hookSpecificOutput?: unknown; context?: unknown } | null;
    if (body && typeof body === "object" && body.hookSpecificOutput && typeof body.hookSpecificOutput === "object") {
      return { stdout: JSON.stringify({ hookSpecificOutput: body.hookSpecificOutput }), code: 0 };
    }
    if (body && typeof body === "object" && typeof body.context === "string" && body.context && CONTEXT_EVENTS.has(event)) {
      return { stdout: body.context, code: 0 };
    }
    if (body?.ok === true) return { stdout: "", code: 0 };
    return unavailable;
  } catch {
    return unavailable;
  }
}
