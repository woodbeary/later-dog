import { redactSecretsInText } from "./redact.ts";

export const REVIEW_INPUT_MAX = 600;
export const REVIEW_INPUT_MAX_FIELDS = 24;
const SCAN_MAX = 20_000;

export interface ReviewField {
  key: string;
  value: string;
}

export interface ReviewInput {
  fields: ReviewField[];
  length: number;
}

const OVER_LIMIT = REVIEW_INPUT_MAX + 1;

function render(value: unknown): string {
  if (typeof value === "string") return value.slice(0, SCAN_MAX);
  if (value === undefined || value === null) return "";
  try {
    return (JSON.stringify(value) ?? "").slice(0, SCAN_MAX);
  } catch {
    return "x".repeat(OVER_LIMIT);
  }
}

export function reviewInputOf(input: unknown, options: { skip?: readonly string[] } = {}): ReviewInput | undefined {
  if (input === null || input === undefined) return undefined;
  const skip = new Set(options.skip ?? []);
  const entries: Array<[string, unknown]> =
    typeof input === "object" && !Array.isArray(input)
      ? Object.entries(input as Record<string, unknown>).filter(([key]) => !skip.has(key))
      : [["input", input]];
  const fields: ReviewField[] = [];
  let length = 0;
  for (const [key, raw] of entries) {
    const rendered = render(raw);
    if (!rendered && raw !== "") continue;
    length += key.length + rendered.length;
    if (fields.length < REVIEW_INPUT_MAX_FIELDS) {
      fields.push({ key: key.slice(0, 80), value: redactSecretsInText(rendered.slice(0, REVIEW_INPUT_MAX)) });
    } else {
      length = Math.max(length, OVER_LIMIT);
    }
  }
  return { fields, length };
}

export function reviewInputText(input: ReviewInput): string {
  return input.fields.map((field) => `${field.key}: ${field.value}`).join("; ").replace(/\s+/g, " ").trim();
}

export function reviewInputWasCut(input: ReviewInput): boolean {
  return input.length > REVIEW_INPUT_MAX;
}
