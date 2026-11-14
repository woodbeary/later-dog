import { redactSecretsInText } from "./redact.ts";

export const FAILURE_DETAIL_MAX_CHARS = 1_200;

export interface PlainFailure {
  line: string;
  detail?: string;
  setup?: true;
}

type Reason =
  | { kind: "sign-in" }
  | { kind: "limit"; until?: string }
  | { kind: "off" }
  | { kind: "space" }
  | { kind: "busy" }
  | { kind: "credit" }
  | { kind: "model" }
  | { kind: "too-long" };

const DOG = "Your dog";

const KEEPS_ITS_WORDS = /\bsign in to (?:Claude|ChatGPT|Grok|Cursor)\b/i;
const SIGN_IN = /not logged in|please run \/login|invalid api key|authentication_error|\b401\b|unauthori[sz]ed|not signed in|signed out|needs? (?:you to )?sign(?:ing)? in|sign(?:ed)? ?in (?:again|first|with)|log out and sign in|token (?:has )?expired|could not be refreshed|session expired/i;
const LIMIT = /usage limit|hit (?:your|its) (?:\w+ )?limit|limit reached|out of usage|\bis (?:still )?resting\b/i;
const OFF = /\bis turned off\b/i;
const SPACE = /no space left|not enough (?:space|disk)|insufficient disk space|disk (?:is )?full|winerror\s*112|\bENOSPC\b/i;
const BUSY = /(?:HTTP|status|API Error:?|error)\s*\(?(?:5\d\d|429)\b|^\(?(?:5\d\d|429)\b|overloaded|temporarily unavailable|service unavailable|internal server error|bad gateway|rate[ _-]?limit/i;
const RATE_LIMIT = /rate[ _-]?limit/i;
const CREDIT = /credit balance is too low/i;
const MODEL = /issue with the selected model|invalid model|model .{0,60}(?:does not exist|not found|is not available)/i;
const TOO_LONG = /prompt is too long|input is too long|context (?:window|length) exceeded|exceeds? (?:the )?(?:model's )?(?:maximum )?context/i;
const CANNOT_RETRY = new RegExp([
  /safety|classifier|spend limit|you stopped|\bAPI Error:? 4(?!29)\d\d\b|request too large/.source,
  CREDIT.source, MODEL.source, TOO_LONG.source,
  /invalid_request_error|not_found_error|request_too_large|permission_error/.source,
].join("|"), "i");

export function retryCannotFix(raw: string): boolean {
  return CANNOT_RETRY.test(raw);
}
const UNTIL = /\b(?:until|at|resets?(?: at)?)\s+(\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?)(?![\d:])/i;

function failureReason(text: string): Reason | null {
  if (SIGN_IN.test(text)) return { kind: "sign-in" };
  if (LIMIT.test(text)) {
    const until = UNTIL.exec(text)?.[1]?.trim().replace(/\.$/, "");
    return until ? { kind: "limit", until } : { kind: "limit" };
  }
  if (OFF.test(text)) return { kind: "off" };
  if (SPACE.test(text)) return { kind: "space" };
  if (CREDIT.test(text)) return { kind: "credit" };
  if (MODEL.test(text)) return { kind: "model" };
  if (TOO_LONG.test(text)) return { kind: "too-long" };
  if (retryCannotFix(text)) return null;
  if (BUSY.test(text)) return { kind: "busy" };
  return null;
}

function clause(reason: Reason, holder: string): string {
  switch (reason.kind) {
    case "sign-in": return `${holder} needs you to sign in again`;
    case "limit": return `${holder} is out of usage ${reason.until ? `until ${reason.until}` : "for now"}`;
    case "off": return `${holder} is turned off. Turn it back on or pick another account`;
    case "space": return "this computer is almost out of space. Free up some space and try again";
    case "busy": return `the service behind ${holder} is busy or briefly unavailable. Try again in a moment`;
    case "credit": return `${holder} is out of credit. Add credit or pick another account`;
    case "model": return `${holder} cannot use the model it is set to. Pick another model`;
    case "too-long": return "the conversation is too long for its model. Start a new chat or pick a model with more room";
  }
}

type Reasoned = { line: string; reason: Reason } | null;
type Rule = {
  shape: RegExp;
  line: (who: string, match: RegExpExecArray) => string;
  reasoned?: (who: string, match: RegExpExecArray, raw: string) => Reasoned;
};

const because = (verb: "stopped" | "could not start") => (who: string, _match: RegExpExecArray, raw: string): Reasoned => {
  const reason = failureReason(raw);
  return reason && { line: `${who} ${verb} because ${clause(reason, "its account")}.`, reason };
};

const onAccount = (lead: string) => (_who: string, match: RegExpExecArray): Reasoned => {
  const reason = failureReason(match[2] ?? "");
  return reason && { line: `${lead} ${match[1]!.trim()}: ${clause(reason, "it")}.`, reason };
};

const RULES: readonly Rule[] = [
  {
    shape: /^(?!MCP\b)[\w.-]+(?: ACP)? exited (?:with )?(?:code )?(?:null|undefined|-?\d+|SIG[A-Z0-9]+|unexpectedly)\b/i,
    line: (who) => `${who} stopped before it finished.`,
    reasoned: because("stopped"),
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
  { shape: /^spawn failed:/i, line: (who) => `${who} could not start. Try again.`, reasoned: because("could not start") },
  { shape: /^\S+(?: ACP)? initialization timed out\b/i, line: (who) => `${who} did not start in time. Try again.`, reasoned: because("could not start") },
  { shape: /^could not deliver approval to the provider\b/i, line: (who) => `Your answer did not reach ${who}. Try the task again.` },
  {
    shape: /^queued (?:channel )?message could not start(?:\s*[—–-]\s*([\s\S]*))?$/i,
    line: () => "Your waiting message could not start. Send it again.",
    reasoned: (who, match) => {
      const reason = failureReason(match[1] ?? "");
      return reason && { line: `Your waiting message could not start: ${clause(reason, `${who}'s account`)}.`, reason };
    },
  },
  { shape: /^Could not carry on with ([^:]+):\s*([\s\S]*)$/, line: (_who, match) => `Could not carry on with ${match[1]!.trim()}. Try again.`, reasoned: onAccount("Could not carry on with") },
  { shape: /^Could not continue on ([^:]+):\s*([\s\S]*)$/, line: (_who, match) => `Could not continue on ${match[1]!.trim()}. Try again.`, reasoned: onAccount("Could not continue on") },
  { shape: /^MCP server could not start\b/i, line: () => "A connected tool could not start. Check its settings." },
  { shape: /^MCP server exited\b/i, line: () => "A connected tool stopped before the turn ended." },
  { shape: /^MCP startup timed out\b/i, line: () => "A connected tool did not start in time. Try again." },
  { shape: /^MCP request timed out\b/i, line: () => "A connected tool did not answer in time, so it is not clear whether it finished." },
  { shape: /^\S+ did not shut down after it was asked to stop\b/i, line: (who) => `${who} did not stop when asked, so some of its work may still be running.` },
  { shape: /^(?!Codex automatic review)(?:.{0,80}\s)?timed out\b/i, line: (who) => `${who} did not get an answer in time. Try again.`, reasoned: because("stopped") },
];

function said(found: { line: string; reason: Reason }, raw: string): PlainFailure {
  const plain = withDetail(found.line, raw);
  return found.reason.kind === "sign-in" ? { ...plain, setup: true } : plain;
}

export function plainFailure(cause: string, who?: string): PlainFailure {
  const raw = cause.trim();
  if (KEEPS_ITS_WORDS.test(raw)) return { line: raw };
  const name = who?.trim() || DOG;
  for (const rule of RULES) {
    const match = rule.shape.exec(raw);
    if (!match) continue;
    const found = rule.reasoned?.(name, match, raw);
    return found ? said(found, raw) : withDetail(rule.line(name, match), raw);
  }
  const reason = failureReason(raw);
  if (reason?.kind === "busy" && !RATE_LIMIT.test(raw)) {
    return withDetail(`The service behind ${name}'s account is busy or briefly unavailable. Try again in a moment.`, raw);
  }
  if (reason?.kind === "credit" || reason?.kind === "model" || reason?.kind === "too-long") {
    return withDetail(`${name} stopped because ${clause(reason, "its account")}.`, raw);
  }
  const words = sentenceInBody(raw);
  return words === raw ? { line: raw } : withDetail(words, raw);
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
