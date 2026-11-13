import { redactSecretsInText } from "./redact.ts";

export const FAILURE_DETAIL_MAX_CHARS = 1_200;

export interface PlainFailure {
  line: string;
  detail?: string;
}

type Rule = { shape: RegExp; line: (who: string, match: RegExpExecArray) => string };

const DOG = "Your dog";

const RULES: readonly Rule[] = [
  {
    shape: /^(?!MCP\b)[\w.-]+(?: ACP)? exited (?:with )?(?:code )?(?:null|undefined|-?\d+|SIG[A-Z0-9]+|unexpectedly)\b/i,
    line: (who) => `${who} stopped before it finished.`,
  },
  { shape: /^(?:pi )?turn failed\.?$/i, line: (who) => `${who} stopped before it finished.` },
  {
    shape: /^\S+ began a steered message but went silent/i,
    line: (who) => `${who} went quiet after your new message, so the turn was stopped.`,
  },
  {
    shape: /^no activity for (\d+) minutes? — the turn was stopped$/i,
    line: (who, match) => `${who} showed no progress for ${match[1]} minute${match[1] === "1" ? "" : "s"}, so the turn was stopped.`,
  },
  { shape: /^`[^`]+` isn't installed, or isn't on this app's PATH$/, line: (who) => `${who} could not start because a program it needs is missing on this computer.` },
  { shape: /^`[^`]+` isn't executable\b/, line: (who) => `${who} could not start because a program it needs is not allowed to run on this computer.` },
  { shape: /^`[^`]+` received too much launch data/, line: (who) => `${who} could not start because the request was too large. Try a shorter message.` },
  { shape: /^spawn failed:/i, line: (who) => `${who} could not start. Try again.` },
  { shape: /^\S+(?: ACP)? initialization timed out\b/i, line: (who) => `${who} did not start in time. Try again.` },
  { shape: /^could not deliver approval to the provider\b/i, line: (who) => `Your answer did not reach ${who}. Try the task again.` },
  { shape: /^queued (?:channel )?message could not start\b/i, line: () => "Your waiting message could not start. Send it again." },
  { shape: /^Could not carry on with ([^:]+):/, line: (_who, match) => `Could not carry on with ${match[1]!.trim()}. Try again.` },
  { shape: /^Could not continue on ([^:]+):/, line: (_who, match) => `Could not continue on ${match[1]!.trim()}. Try again.` },
  { shape: /^MCP server could not start\b/i, line: () => "A connected tool could not start. Check its settings." },
  { shape: /^MCP server exited\b/i, line: () => "A connected tool stopped before the turn ended." },
  { shape: /^MCP startup timed out\b/i, line: () => "A connected tool did not start in time. Try again." },
  { shape: /^MCP request timed out\b/i, line: () => "A connected tool did not answer in time, so it is not clear whether it finished." },
  { shape: /^\S+ did not shut down after it was asked to stop\b/i, line: (who) => `${who} did not stop when asked, so some of its work may still be running.` },
  { shape: /^The (?:remaining )?helpers stopped with this turn\.?$/i, line: () => "Work running in the background stopped when this turn ended." },
  { shape: /^(?!Codex automatic review)(?:.{0,80}\s)?timed out\b/i, line: (who) => `${who} did not get an answer in time. Try again.` },
  {
    shape: /^(?:[\w .-]{0,40} )?HTTP (5\d\d)\b|^(5\d\d) [A-Z][a-z]+(?: [A-Z][a-z]+)*$/,
    line: (who) => `The service behind ${who}'s account had a problem. Try again.`,
  },
];

export function plainFailure(cause: string, who?: string): PlainFailure {
  const raw = cause.trim();
  const name = who?.trim() || DOG;
  for (const rule of RULES) {
    const match = rule.shape.exec(raw);
    if (match) return withDetail(rule.line(name, match), raw);
  }
  const said = sentenceInBody(raw);
  return said === raw ? { line: raw } : withDetail(said, raw);
}

function withDetail(line: string, raw: string): PlainFailure {
  if (line === raw) return { line };
  const masked = redactSecretsInText(raw);
  const detail = masked.length > FAILURE_DETAIL_MAX_CHARS ? `${masked.slice(0, FAILURE_DETAIL_MAX_CHARS - 1)}…` : masked;
  return { line, detail };
}

function sentenceInBody(cause: string): string {
  const start = cause.indexOf("{");
  if (start < 0) return cause;
  let body: unknown;
  try { body = JSON.parse(cause.slice(start)); } catch { return cause; }
  const said = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  const inner = record?.error && typeof record.error === "object" ? record.error as Record<string, unknown> : null;
  const sentence = said(inner?.message) ?? said(record?.error) ?? said(record?.message) ?? said(record?.detail);
  if (!sentence) return cause;
  const lead = cause.slice(0, start).trimEnd();
  return lead ? `${lead} ${sentence}` : sentence;
}
