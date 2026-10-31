import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const QUICK_LOOK_KINDS = new Set([
  "pdf", "xlsx", "xls", "numbers", "ods", "csv", "tsv",
  "pptx", "ppt", "key", "odp", "docx", "doc", "pages", "odt", "rtf",
]);
export const QUICK_LOOK_MAX_BYTES = 50 * 1024 * 1024;
const NAME_LIMIT = 120;

export function quickLookName(rawName) {
  if (typeof rawName !== "string") return null;
  const base = rawName.split(/[\\/]/).at(-1) ?? "";
  const visible = [...base].map((char) => (char.codePointAt(0) < 32 || char.codePointAt(0) === 127 || char === ":" ? " " : char)).join("");
  const clean = visible.replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  const dot = clean.lastIndexOf(".");
  if (dot <= 0) return null;
  const extension = clean.slice(dot + 1).toLowerCase();
  if (!QUICK_LOOK_KINDS.has(extension)) return null;
  const stem = clean.slice(0, dot).slice(0, NAME_LIMIT - extension.length - 1).trim();
  return stem ? `${stem}.${extension}` : null;
}

export function quickLookBytes(bytes) {
  return bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= QUICK_LOOK_MAX_BYTES ? bytes : null;
}

export async function writeQuickLookFile(root, name, bytes) {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(path.join(root, "preview-"));
  const file = path.join(folder, name);
  await writeFile(file, bytes, { mode: 0o600 });
  return file;
}

export function clearQuickLookFiles(root) {
  return rm(root, { recursive: true, force: true });
}
