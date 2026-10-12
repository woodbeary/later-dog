import { MAX_QUESTION_TEXT } from "../shared/ask-question.ts";
import { redactSecrets, redactSecretsInText } from "./redact.ts";
import { fileChangeDetail } from "./laterdog/file-change-detail.ts";

export function toolDetailPreview(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  let budget = 200;
  let textBudget = 256_000;
  const bounded = (item: unknown, depth = 0): unknown => {
    if (--budget < 0 || depth > 6) return "[additional data omitted]";
    if (typeof item === "string") {
      if (item.length > textBudget) return "[large content omitted]";
      if (/^data:[^,\s]+;base64,/i.test(item)) return "[binary content omitted]";
      if (/^\s*[[{]/.test(item)) {
        try { return bounded(JSON.parse(item), depth + 1); }
        catch {}
      }
      textBudget -= item.length;
      return item;
    }
    if (typeof item === "bigint") return String(item);
    if (item === null || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.slice(0, 40).map((child) => bounded(child, depth + 1)).concat(item.length > 40 ? ["[additional items omitted]"] : []);
    const entries = Object.entries(item);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of entries.slice(0, 40)) {
      result[key] = /token|secret|password|passwd|cookie|authorization|api.?key|(^|[_.-])keys?$/i.test(key)
        ? "[redacted]"
        : /^(data|base64|blob)$/i.test(key) && typeof child === "string"
          ? "[binary content omitted]"
          : bounded(child, depth + 1);
    }
    if (entries.length > 40) result["…"] = "[additional fields omitted]";
    return result;
  };
  const safe = redactSecrets(bounded(value));
  const text = typeof safe === "string" ? safe : JSON.stringify(safe, null, 2);
  if (!text?.trim() || text === "{}" || text === "[]") return undefined;
  return text.length > 6_000 ? `${text.slice(0, 6_000)}\n[… preview shortened]` : text;
}

const LIMIT = 200;

function fieldsOf(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

const cut = (text: string, limit: number) => redactSecretsInText(text).trim().slice(0, limit);

function clipped(text: string, limit: number): string {
  const safe = redactSecretsInText(text).trim();
  return safe.length > limit ? `${safe.slice(0, limit)}…` : safe;
}

export function commandSummary(input: unknown): string | undefined {
  const command = fieldsOf(input)?.command;
  if (typeof command !== "string") return undefined;
  return cut(command.replace(/\s*[\r\n]+\s*/g, " "), LIMIT);
}

export function askInputSummary(input: unknown): string | undefined {
  const fields = fieldsOf(input);
  if (!fields) return undefined;
  if (typeof fields.question === "string") return cut(fields.question, MAX_QUESTION_TEXT);
  if (typeof fields.command === "string") return clipped(fields.command, LIMIT);
  if (typeof fields.url === "string") return clipped(fields.url, LIMIT);
  const fileChange = fileChangeDetail(fields);
  if (fileChange) return fileChange;
  const text = JSON.stringify(fields);
  return text === "{}" ? undefined : clipped(text, LIMIT);
}
