export const QUICK_LOOK_KINDS: ReadonlySet<string> = new Set([
  "pdf", "xlsx", "xls", "numbers", "ods", "csv", "tsv",
  "pptx", "ppt", "key", "odp", "docx", "doc", "pages", "odt", "rtf",
]);
export const QUICK_LOOK_MAX_BYTES = 50 * 1024 * 1024;

export type QuickLookWay = "native" | "browser";

export function quickLookKind(name: string): string | null {
  const base = name.split(/[\\/]/).at(-1) ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = base.slice(dot + 1).toLowerCase();
  return QUICK_LOOK_KINDS.has(extension) ? extension : null;
}

export function quickLookWay(name: string, bridge: Window["laterdog"]): QuickLookWay | null {
  const kind = quickLookKind(name);
  if (!kind) return null;
  if (bridge?.previewFile) return "native";
  return !bridge && kind === "pdf" ? "browser" : null;
}
