import { outcomeKindOfTool } from "../../shared/step-words.ts";
import { redactSecrets } from "../redact.ts";

type Fields = Record<string, unknown>;
const LIMIT = 120;
const fields = (value: unknown): Fields => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : {};
const words = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const unredacted = (text: string | undefined): string | undefined => text !== undefined && redactSecrets(text) === text ? text : undefined;
const NOT_PLAIN = /[*\\/[\]{}^|;<>`$]|&&|__|(?:^|\s)(?:~|\.{1,2}\w|-{1,2}[A-Za-z])/;
const plain = (text: string | undefined): string | undefined => text !== undefined && !NOT_PLAIN.test(text) ? text : undefined;

function fileWords(path: string | undefined): string | undefined {
  const name = path?.split(/[\\/]/).at(-1);
  if (!name) return undefined;
  const stem = name.replace(/^\.+/, "").replace(/\.[^.]*$/, "");
  const parts = stem.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").split(/[\s._-]+/).filter(Boolean);
  return parts.length ? parts.join(" ").toLowerCase() : undefined;
}

function host(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.hostname.replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

function clean(value: string | undefined): string | undefined {
  const text = unredacted(value?.trim());
  return text ? Array.from(text).slice(0, LIMIT).join("") : undefined;
}

export function stepSubject(toolName: string, input: unknown): string | undefined {
  const given = fields(input);
  switch (outcomeKindOfTool(toolName)) {
    case "command": case "check": case "cloud": case "help":
      return clean(plain(words(given.description)));
    case "read": case "wrote": case "edit": case "delete":
      return clean(fileWords(unredacted(words(given.file_path) ?? words(given.notebook_path) ?? words(given.path))));
    case "search": case "chats": case "web":
      return toolName.trim().toLowerCase().split("__").at(-1) === "glob" ? undefined : clean(plain(words(given.query) ?? words(given.pattern)));
    case "page": case "open":
      return clean(host(unredacted(words(given.url))));
    default:
      return undefined;
  }
}

export function changedFileSubject(changes: unknown): string | undefined {
  return Array.isArray(changes) && changes.length === 1 ? stepSubject("edit_file", { path: fields(changes[0]).path }) : undefined;
}
