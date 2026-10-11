import { redactSecrets } from "../redact.ts";

type Fields = Record<string, unknown>;

const PATH_KEYS = ["file_path", "notebook_path"];
const CHANGE_KEYS = new Set([...PATH_KEYS, "content", "new_source", "old_string", "new_string", "edits"]);
const DETAIL_LIMIT = 2_000;
const FIELD_LIMIT = 200;

const isText = (value: unknown): value is string => typeof value === "string";

function marked(text: string, mark: "-" | "+"): string {
  return text.split(/\r?\n/).map((line) => `${mark} ${line}`).join("\n");
}

function editLines(edit: unknown, nested: boolean): string | undefined {
  if (!edit || typeof edit !== "object") return undefined;
  const { old_string: before, new_string: after, replace_all: every } = edit as Fields;
  if (!isText(before) || !isText(after)) return undefined;
  const lines = [before && marked(before, "-"), after && marked(after, "+")];
  if (nested && every === true) lines.unshift("replace_all: true");
  return lines.filter(Boolean).join("\n");
}

function change(fields: Fields): string | undefined {
  if (isText(fields.content)) return fields.content;
  if (isText(fields.new_source)) return fields.new_source;
  const edits = Array.isArray(fields.edits)
    ? fields.edits.map((edit) => editLines(edit, true))
    : [editLines(fields, false)];
  const shown = edits.filter(isText);
  return shown.length ? shown.join("\n\n") : undefined;
}

function fieldLine(key: string, value: unknown): string | undefined {
  if (value === undefined || value === null || value === false) return undefined;
  const text = (isText(value) ? value : JSON.stringify(value) ?? "").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return `${key}: ${text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)}…` : text}`;
}

function shorten(text: string): string {
  if (text.length <= DETAIL_LIMIT) return text;
  const head = text.slice(0, DETAIL_LIMIT);
  const end = head.lastIndexOf("\n");
  return `${(end > DETAIL_LIMIT / 2 ? head.slice(0, end) : head).trimEnd()}\n…`;
}

export function fileChangeDetail(input: Fields): string | undefined {
  const fields = redactSecrets(input) as Fields;
  const path = PATH_KEYS.map((key) => fields[key]).find((value): value is string => isText(value) && value.trim() !== "");
  const body = path === undefined ? undefined : change(fields)?.trimEnd();
  if (path === undefined || body === undefined) return undefined;
  const extra = Object.entries(fields)
    .filter(([key]) => !CHANGE_KEYS.has(key))
    .map(([key, value]) => fieldLine(key, value))
    .filter(isText);
  const head = [path.trim(), ...extra].join("\n");
  return shorten(body.trim() ? `${head}\n\n${body}` : head);
}
