import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { parseAllDocuments } from "yaml";

export const YAML_FILE = /(?:^|\/)(?!pnpm-lock\.yaml$)[^/]+\.ya?ml$/;
export const JSON_FILE = /\.jsonc?$/;
export const SQL = /\.sql$/;
export const MARKUP = /\.(?:html|xml|svg|plist)$/;
export const HASH_LINES = /(?:^|\/)(?:Caddyfile|CODEOWNERS|chromium-flags|\.gitignore|\.gitattributes|\.dockerignore|[^/]*\.example|[^/]+\.(?:apparmor|desktop|list|rc|toml|conf))$/;
export const CONFIG = [YAML_FILE, JSON_FILE, SQL, MARKUP, HASH_LINES];

const SHELL_KEYS = new Set(["run", "script"]);

export interface FoundComment {
  line: number;
  text: string;
}

type Range = [number, number];

const isBlank = (line: string | undefined) => line !== undefined && line.trim() === "";

export function dropLines(text: string, comments: Set<number>): string {
  const lines = text.split("\n");
  const drop = new Set(comments);
  for (const index of comments) {
    let previous = index - 1;
    while (drop.has(previous)) previous--;
    let next = index + 1;
    while (drop.has(next)) next++;
    const openedAbove = previous < 0 || isBlank(lines[previous]) || (previous === 0 && lines[0]!.startsWith("#!"));
    if (openedAbove && next < lines.length - 1 && isBlank(lines[next])) drop.add(next);
  }
  return lines.filter((_, index) => !drop.has(index)).join("\n");
}

function removeRanges(text: string, ranges: Range[]): string {
  let out = "";
  let cursor = 0;
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const newline = text.indexOf("\n", end);
    const lineEnd = newline === -1 ? text.length : newline;
    if (lineStart >= cursor && isBlank(text.slice(lineStart, start)) && isBlank(text.slice(end, lineEnd))) {
      out += text.slice(cursor, lineStart);
      cursor = newline === -1 ? text.length : newline + 1;
    } else {
      out += text.slice(cursor, start).replace(/[ \t]+$/, "");
      cursor = end;
    }
  }
  out += text.slice(cursor);
  return out;
}

function lineOf(text: string, pos: number): number {
  return text.slice(0, pos).split("\n").length;
}

function trailingHash(line: string): number {
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (quote === '"' && char === "\\") i++;
      else if (char === quote) {
        if (quote === "'" && line[i + 1] === "'") i++;
        else quote = "";
      }
      continue;
    }
    if ((char === '"' || char === "'") && (i === 0 || /[\s:[{,-]/.test(line[i - 1]!))) quote = char;
    else if (char === "#" && i > 0 && /\s/.test(line[i - 1]!)) return i;
  }
  return -1;
}

interface YamlComments {
  whole: Set<number>;
  trailing: Map<number, number>;
}

function yamlComments(text: string): YamlComments {
  const whole = new Set<number>();
  const trailing = new Map<number, number>();
  let block: { indent: number; shell: boolean } | null = null;
  let heredoc: RegExp | null = null;
  text.split("\n").forEach((line, index) => {
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (block) {
      if (trimmed === "" || indent > block.indent) {
        if (!block.shell) return;
        if (heredoc) {
          if (heredoc.test(trimmed)) heredoc = null;
          return;
        }
        if (trimmed.startsWith("#") && !trimmed.startsWith("#!")) {
          whole.add(index);
          return;
        }
        const opened = line.match(/<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/);
        if (opened && !line.includes("<<<")) heredoc = new RegExp(`^${opened[3]}$`);
        return;
      }
      block = null;
      heredoc = null;
    }
    if (trimmed.startsWith("#")) {
      if (!/^#\s*yaml-language-server:/.test(trimmed)) whole.add(index);
      return;
    }
    const hash = trailingHash(line);
    if (hash !== -1) trailing.set(index, hash);
    const content = hash === -1 ? line : line.slice(0, hash);
    const opener = content.match(/^(\s*)((?:-\s+)*)(?:([^\s#'"][^:#]*?)\s*:\s+)?[|>][-+1-9]*\s*$/);
    if (opener && (opener[3] !== undefined || opener[2])) {
      const keyColumn = opener[1]!.length + (opener[3] !== undefined ? opener[2]!.length : Math.max(opener[2]!.length - 2, 0));
      block = { indent: keyColumn, shell: opener[3] !== undefined && SHELL_KEYS.has(opener[3]) };
    }
  });
  return { whole, trailing };
}

function yamlData(file: string, text: string): unknown[] {
  return parseAllDocuments(text).map((document) => {
    if ("errors" in document && document.errors.length) throw new Error(`${file}: ${document.errors[0]!.message}`);
    return document.toJS();
  });
}

function onlyCommentLinesRemoved(before: string, after: string): boolean {
  const kept = after.split("\n");
  let cursor = 0;
  for (const line of before.split("\n")) {
    if (cursor < kept.length && kept[cursor] === line) cursor++;
    else if (!(line.trim() === "" || (line.trim().startsWith("#") && !line.trim().startsWith("#!")))) return false;
  }
  return cursor === kept.length;
}

function sameYaml(before: unknown, after: unknown, key?: string): boolean {
  if (typeof before === "string" && typeof after === "string" && key && SHELL_KEYS.has(key)) {
    return before === after || onlyCommentLinesRemoved(before, after);
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.length === after.length && before.every((item, index) => sameYaml(item, after[index], key));
  }
  if (before && after && typeof before === "object" && typeof after === "object") {
    const keys = Object.keys(before);
    return isDeepStrictEqual(keys, Object.keys(after))
      && keys.every((name) => sameYaml((before as Record<string, unknown>)[name], (after as Record<string, unknown>)[name], name));
  }
  return isDeepStrictEqual(before, after);
}

function stripYaml(file: string, text: string): { text: string; removed: number } {
  const { whole, trailing } = yamlComments(text);
  const removed = whole.size + trailing.size;
  if (removed === 0) return { text, removed: 0 };
  const lines = text.split("\n").map((line, index) => {
    const at = trailing.get(index);
    return at === undefined ? line : line.slice(0, at).replace(/\s+$/, "");
  });
  const out = dropLines(lines.join("\n"), whole);
  if (!sameYaml(yamlData(file, text), yamlData(file, out))) {
    throw new Error(`${file}: removing comments would change the YAML it describes`);
  }
  return { text: out, removed };
}

function jsonComments(text: string): Range[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  const found: Range[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      found.push([scanner.getTokenStart(), scanner.getTokenEnd()]);
    }
  }
  return found;
}

function jsonData(file: string, text: string): unknown {
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  if (error) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(error.messageText, "\n")}`);
  return config;
}

function stripJson(file: string, text: string): { text: string; removed: number } {
  const ranges = jsonComments(text);
  if (ranges.length === 0) return { text, removed: 0 };
  const out = removeRanges(text, ranges);
  if (!isDeepStrictEqual(jsonData(file, text), jsonData(file, out))) {
    throw new Error(`${file}: removing comments would change the JSON it holds`);
  }
  return { text: out, removed: ranges.length };
}

function sqlComments(text: string): Range[] {
  const found: Range[] = [];
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) {
        if (text[i + 1] === quote) i++;
        else quote = "";
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "-" && text[i + 1] === "-") {
      const newline = text.indexOf("\n", i);
      const stop = newline === -1 ? text.length : newline;
      found.push([i, stop]);
      i = stop - 1;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      found.push([i, stop]);
      i = stop - 1;
    }
  }
  return found;
}

function sqlWords(text: string): string[] {
  const ranges = sqlComments(text);
  let rest = "";
  let cursor = 0;
  for (const [start, end] of ranges) {
    rest += `${text.slice(cursor, start)} `;
    cursor = end;
  }
  rest += text.slice(cursor);
  return rest.split(/\s+/).filter(Boolean);
}

function stripSql(file: string, text: string): { text: string; removed: number } {
  const ranges = sqlComments(text);
  if (ranges.length === 0) return { text, removed: 0 };
  const out = removeRanges(text, ranges);
  if (!isDeepStrictEqual(sqlWords(text), sqlWords(out))) throw new Error(`${file}: removing comments would change the SQL`);
  return { text: out, removed: ranges.length };
}

function markupComments(text: string): Range[] {
  const found: Range[] = [];
  let at = 0;
  while (true) {
    const start = text.indexOf("<!--", at);
    if (start === -1) return found;
    const cdata = text.lastIndexOf("<![CDATA[", start);
    if (cdata !== -1 && text.indexOf("]]>", cdata) > start) {
      at = text.indexOf("]]>", cdata) + 3;
      continue;
    }
    const end = text.indexOf("-->", start + 4);
    const stop = end === -1 ? text.length : end + 3;
    found.push([start, stop]);
    at = stop;
  }
}

function stripMarkup(file: string, text: string): { text: string; removed: number } {
  const ranges = markupComments(text);
  if (ranges.length === 0) return { text, removed: 0 };
  const out = removeRanges(text, ranges);
  if (markupComments(out).length) throw new Error(`${file}: comments left after removal`);
  return { text: out, removed: ranges.length };
}

function hashLines(text: string): Set<number> {
  const found = new Set<number>();
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("#")) return;
    if (index === 0 && trimmed.startsWith("#!")) return;
    if (/^#\s*include\b/.test(trimmed)) return;
    found.add(index);
  });
  return found;
}

export function stripConfig(file: string, text: string): { text: string; removed: number } {
  if (YAML_FILE.test(file)) return stripYaml(file, text);
  if (JSON_FILE.test(file)) return stripJson(file, text);
  if (SQL.test(file)) return stripSql(file, text);
  if (MARKUP.test(file)) return stripMarkup(file, text);
  const comments = hashLines(text);
  return { text: comments.size ? dropLines(text, comments) : text, removed: comments.size };
}

export function configComments(file: string, text: string): FoundComment[] {
  const lines = text.split("\n");
  const fromRanges = (ranges: Range[]) => ranges.map(([start, end]) => ({ line: lineOf(text, start), text: text.slice(start, end).split("\n")[0]! }));
  if (YAML_FILE.test(file)) {
    const { whole, trailing } = yamlComments(text);
    return [
      ...[...whole].map((index) => ({ line: index + 1, text: lines[index]!.trim() })),
      ...[...trailing].map(([index, at]) => ({ line: index + 1, text: lines[index]!.slice(at) })),
    ].sort((a, b) => a.line - b.line);
  }
  if (JSON_FILE.test(file)) return fromRanges(jsonComments(text));
  if (SQL.test(file)) return fromRanges(sqlComments(text));
  if (MARKUP.test(file)) return fromRanges(markupComments(text));
  return [...hashLines(text)].map((index) => ({ line: index + 1, text: lines[index]!.trim() }));
}
