import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";
import { CONFIG, configComments, dropLines, stripConfig } from "./no-comments-config.ts";

export const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
export const CSS = /\.css$/;
export const SHELL = /\.sh$|^scripts\/git-hooks\/[^/.]+$/;
export const DOCKER = /(?:^|\/)(?:Dockerfile|[^/]+\.Dockerfile)$/;
export const SWIFT = /\.swift$/;
export const PYTHON = /\.py$/;
const LINE_COMMENTED = [SHELL, DOCKER, SWIFT, PYTHON];
export const EXCLUDED = /^(?:third_party|electron\/vendor)\//;

const DIRECTIVE = new RegExp(
  [
    String.raw`^@ts-(?:expect-error|ignore|nocheck|check)\b`,
    String.raw`^(?:eslint|oxlint)-(?:disable|enable)`,
    String.raw`^@vitest-environment\b`,
    String.raw`^@(?:vite|webpack)-ignore\b`,
    String.raw`^[#@]__(?:PURE|NO_SIDE_EFFECTS)__$`,
    String.raw`^prettier-ignore\b`,
    String.raw`^(?:c8|v8|istanbul) ignore\b`,
    String.raw`^@jsx(?:ImportSource|Runtime|Frag)?\b`,
    String.raw`^<reference\s`,
    String.raw`^falls? ?through\b`,
    String.raw`^webpack[A-Z]\w*:`,
  ].join("|"),
  "i",
);
const LICENSE = /@license\b|@preserve\b|\bcopyright\b|SPDX-License-Identifier/i;

export function isDirective(raw: string): boolean {
  if (raw.startsWith("/*!") || LICENSE.test(raw)) return true;
  const body = raw.startsWith("//") ? raw.slice(2).replace(/^\/+/, "") : raw.slice(2, -2).replace(/^\*+/, "");
  return body
    .split("\n")
    .map((line) => line.replace(/^\s*\*?\s*/, "").trim())
    .filter(Boolean)
    .some((line) => DIRECTIVE.test(line));
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const isJsDoc = (node: ts.Node) => node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode;

const isEmptyJsxChild = (node: ts.Node) =>
  ts.isJsxExpression(node) && !node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent));

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
}

interface Found {
  comments: ts.CommentRange[];
  emptyJsx: ts.JsxExpression[];
  emptyLists: Array<[number, number]>;
}

const OPEN = new Set([ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.OpenParenToken]);

function find(file: string, text: string): Found {
  const source = parse(file, text);
  const byPos = new Map<number, ts.CommentRange>();
  const jsxText: Array<[number, number]> = [];
  const emptyJsx: ts.JsxExpression[] = [];
  const emptyLists: Array<[number, number]> = [];
  const add = (ranges: readonly ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) byPos.set(range.pos, range);
  };
  const visit = (node: ts.Node) => {
    if (isJsDoc(node)) return;
    if (node.kind === ts.SyntaxKind.JsxText) {
      jsxText.push([node.pos, node.end]);
      return;
    }
    if (isEmptyJsxChild(node)) emptyJsx.push(node as ts.JsxExpression);
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    const children = node.getChildren(source);
    children.forEach((child, index) => {
      const list = children[index + 1];
      const close = children[index + 2];
      if (OPEN.has(child.kind) && list?.kind === ts.SyntaxKind.SyntaxList && list.getChildCount(source) === 0 && close) {
        emptyLists.push([child.end, close.getStart(source)]);
      }
    });
    for (const child of children) visit(child);
  };
  visit(source);
  const comments = [...byPos.values()]
    .filter((range) => !jsxText.some(([start, end]) => range.pos >= start && range.pos < end))
    .sort((a, b) => a.pos - b.pos);
  return { comments, emptyJsx, emptyLists };
}

function kept(text: string, comments: ts.CommentRange[]): Set<number> {
  const keep = new Set<number>();
  const lineOf = (pos: number) => text.slice(0, pos).split("\n").length;
  const alone = (range: ts.CommentRange) => {
    const start = text.lastIndexOf("\n", range.pos - 1) + 1;
    const newline = text.indexOf("\n", range.end);
    return isBlank(text.slice(start, range.pos)) && isBlank(text.slice(range.end, newline === -1 ? text.length : newline));
  };
  let block: ts.CommentRange[] = [];
  const close = () => {
    if (block.some((range) => LICENSE.test(text.slice(range.pos, range.end)))) for (const range of block) keep.add(range.pos);
    block = [];
  };
  for (const range of comments) {
    const raw = text.slice(range.pos, range.end);
    if (isDirective(raw)) keep.add(range.pos);
    const previous = block.at(-1);
    const empty = raw.replace(/^\/+/, "").trim() === "";
    const continues = previous && !empty && raw.startsWith("//") && alone(range) && lineOf(range.pos) === lineOf(previous.pos) + 1;
    if (!continues) close();
    if (!empty && raw.startsWith("//") && alone(range)) block.push(range);
  }
  close();
  return keep;
}

export function remainingComments(file: string, text: string): Array<{ line: number; text: string }> {
  const lines = (pos: number) => text.slice(0, pos).split("\n").length;
  if (CSS.test(file)) {
    return cssComments(text).filter(([start, end]) => !text.slice(start, end).startsWith("/*!")).map(([start, end]) => ({ line: lines(start), text: text.slice(start, end) }));
  }
  if (LINE_COMMENTED.some((pattern) => pattern.test(file))) {
    const comments = lineComments(file, text);
    return text.split("\n").flatMap((line, index) => (comments.has(index) ? [{ line: index + 1, text: line.trim() }] : []));
  }
  if (CONFIG.some((pattern) => pattern.test(file))) return configComments(file, text);
  const { comments } = find(file, text);
  const keep = kept(text, comments);
  return comments
    .filter((range) => !keep.has(range.pos))
    .map((range) => ({ line: lines(range.pos), text: text.slice(range.pos, range.end).split("\n")[0] }));
}

interface Span {
  start: number;
  end: number;
  replacement: string;
}

const isBlank = (line: string) => line.trim() === "";
const OPENERS = "([{,;";
const CLOSERS = ")]},;";

function lineBounds(text: string, start: number, end: number) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end);
  const lineEnd = newline === -1 ? text.length : newline;
  return { lineStart, lineEnd };
}

function spanFor(text: string, start: number, end: number): Span {
  const { lineStart, lineEnd } = lineBounds(text, start, end);
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (isBlank(before) && isBlank(after)) {
    let spanStart = lineStart;
    let spanEnd = lineEnd === text.length ? text.length : lineEnd + 1;
    const previousStart = lineStart === 0 ? -1 : text.lastIndexOf("\n", lineStart - 2) + 1;
    const previousLine = previousStart === -1 ? null : text.slice(previousStart, lineStart - 1);
    const nextEnd = text.indexOf("\n", spanEnd);
    const nextLine = spanEnd >= text.length ? null : text.slice(spanEnd, nextEnd === -1 ? text.length : nextEnd);
    const openedAbove = previousLine === null || isBlank(previousLine) || /[{([]\s*$/.test(previousLine);
    if (openedAbove && nextLine !== null && isBlank(nextLine) && nextEnd !== -1) spanEnd = nextEnd + 1;
    if (spanEnd === text.length && lineStart > 0 && lineEnd === text.length) spanStart = lineStart - 1;
    return { start: spanStart, end: spanEnd, replacement: "" };
  }
  if (isBlank(after)) {
    const trailingSpace = before.length - before.trimEnd().length;
    return { start: start - trailingSpace, end, replacement: "" };
  }
  const following = after.length - after.trimStart().length;
  const previous = text[start - 1] ?? "";
  const next = text[end + following] ?? "";
  if (text.slice(start, end).includes("\n")) return { start: start - (before.length - before.trimEnd().length), end: end + following, replacement: "\n" };
  if (/\s/.test(previous)) return { start, end: end + following, replacement: "" };
  const needsSpace = previous && next && !OPENERS.includes(previous) && !CLOSERS.includes(next);
  return { start, end: end + following, replacement: needsSpace ? " " : "" };
}

function apply(text: string, spans: Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged.at(-1);
    if (last && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ ...span });
  }
  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start) + span.replacement;
    cursor = span.end;
  }
  out += text.slice(cursor);
  if (text.endsWith("\n") && !out.endsWith("\n")) out += "\n";
  return out;
}

const CLOSING = new Set([ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.CloseParenToken]);

function signature(file: string, text: string): string[] {
  const source = parse(file, text);
  const tokens: string[] = [];
  let previousEnd = 0;
  const visit = (node: ts.Node) => {
    if (isJsDoc(node) || isEmptyJsxChild(node)) return;
    const children = node.getChildren(source);
    if (children.length === 0 || node.kind === ts.SyntaxKind.JsxText) {
      if (node.kind === ts.SyntaxKind.JsxText && (node as ts.JsxText).containsOnlyTriviaWhiteSpaces) return;
      const start = node.getStart(source);
      const lineBreak = tokens.length > 0 && !CLOSING.has(node.kind) && /\n/.test(text.slice(previousEnd, start)) && node.kind !== ts.SyntaxKind.JsxText;
      tokens.push(`${node.kind}${lineBreak ? "\n" : " "}${node.getText(source).trim()}`);
      previousEnd = node.end;
      return;
    }
    for (const child of children) visit(child);
  };
  visit(source);
  return tokens;
}

export function stripSource(file: string, text: string): { text: string; removed: number } {
  const { comments, emptyJsx, emptyLists } = find(file, text);
  const keep = kept(text, comments);
  const removable = comments.filter((range) => !keep.has(range.pos));
  if (removable.length === 0) return { text, removed: 0 };
  const spans: Span[] = [];
  for (const [start, end] of emptyLists) {
    const inside = comments.filter((range) => range.pos >= start && range.end <= end);
    if (inside.length === 0 || inside.some((range) => keep.has(range.pos))) continue;
    const rest = inside.reduceRight((interior, range) => interior.slice(0, range.pos - start) + interior.slice(range.end - start), text.slice(start, end));
    if (rest.trim() === "") spans.push({ start, end, replacement: "" });
  }
  const covered = new Set<number>();
  for (const node of emptyJsx) {
    const start = node.getStart();
    const inside = comments.filter((range) => range.pos >= start && range.end <= node.end);
    if (inside.length === 0 || inside.some((range) => keep.has(range.pos))) continue;
    spans.push(spanFor(text, start, node.end));
    for (const range of inside) covered.add(range.pos);
  }
  for (const range of removable) {
    if (!covered.has(range.pos)) spans.push(spanFor(text, range.pos, range.end));
  }
  const out = apply(text, spans);
  const before = signature(file, text);
  const after = signature(file, out);
  const sameTokens = before.length === after.length && before.every((token, index) => token === after[index]);
  if (!sameTokens) {
    const index = before.findIndex((token, i) => token !== after[i]);
    throw new Error(`${file}: removing comments would change the code near token ${index}: ${JSON.stringify(before[index])} vs ${JSON.stringify(after[index])}`);
  }
  const left = remainingComments(file, out);
  if (left.length) throw new Error(`${file}: comments left after removal at lines ${left.map((c) => c.line).join(", ")}`);
  return { text: out, removed: removable.length };
}

function cssComments(text: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      found.push([i, stop]);
      i = stop - 1;
    }
  }
  return found;
}

export function stripCss(text: string): { text: string; removed: number } {
  const ranges = cssComments(text).filter(([start, end]) => !text.slice(start, end).startsWith("/*!"));
  return { text: apply(text, ranges.map(([start, end]) => spanFor(text, start, end))), removed: ranges.length };
}

function lineComments(file: string, text: string): Set<number> {
  const found = new Set<number>();
  const docker = DOCKER.test(file);
  const marker = SWIFT.test(file) ? "//" : "#";
  const quotes = SWIFT.test(file) ? ['"""'] : PYTHON.test(file) ? ['"""', "'''"] : [];
  let terminator: RegExp | null = null;
  let openQuote = "";
  let inBlock = false;
  let instructions = false;
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trimStart();
    if (terminator) {
      if (terminator.test(line)) terminator = null;
      return;
    }
    if (openQuote) {
      if (line.split(openQuote).length % 2 === 0) openQuote = "";
      return;
    }
    if (inBlock) {
      found.add(index);
      if (trimmed.includes("*/")) inBlock = false;
      return;
    }
    if (marker === "//" && trimmed.startsWith("/*")) {
      found.add(index);
      inBlock = !trimmed.includes("*/");
      return;
    }
    if (trimmed.startsWith(marker)) {
      const shebang = index === 0 && trimmed.startsWith("#!");
      const directive = /^#\s*shellcheck\s/.test(trimmed) || (docker && !instructions && /^#\s*(?:syntax|escape|check)\s*=/.test(trimmed))
        || (PYTHON.test(file) && index < 2 && /coding[:=]/.test(trimmed));
      if (!shebang && !directive) found.add(index);
      return;
    }
    if (trimmed) instructions = true;
    const quote = quotes.find((delimiter) => line.split(delimiter).length % 2 === 0);
    if (quote) {
      openQuote = quote;
      return;
    }
    if (marker === "#" && !PYTHON.test(file)) {
      const heredoc = line.match(/<<(-?)\s*(['"]?)([A-Za-z_]\w*)\2/);
      if (heredoc && !line.includes("<<<")) terminator = new RegExp(`^${heredoc[1] ? "\\t*" : ""}${heredoc[3]}$`);
    }
  });
  return found;
}

export function stripLines(file: string, text: string): { text: string; removed: number } {
  const comments = lineComments(file, text);
  return { text: comments.size ? dropLines(text, comments) : text, removed: comments.size };
}

export function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => file && !EXCLUDED.test(file) && [SOURCE, CSS, ...LINE_COMMENTED, ...CONFIG].some((pattern) => pattern.test(file)));
}

export function strip(file: string, text: string): { text: string; removed: number } {
  if (CSS.test(file)) return stripCss(text);
  if (LINE_COMMENTED.some((pattern) => pattern.test(file))) return stripLines(file, text);
  if (CONFIG.some((pattern) => pattern.test(file))) return stripConfig(file, text);
  return stripSource(file, text);
}

if (import.meta.main) {
  const write = process.argv.includes("--write");
  const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  let total = 0;
  let changed = 0;
  const failures: string[] = [];
  for (const file of files.length ? files : trackedFiles()) {
    const text = readFileSync(file, "utf8");
    try {
      const result = strip(file, text);
      if (result.removed) {
        total += result.removed;
        changed++;
        if (write) writeFileSync(file, result.text);
      }
    } catch (error) {
      failures.push(String((error as Error).message));
    }
  }
  console.log(`${write ? "removed" : "would remove"} ${total} comments in ${changed} files`);
  if (process.argv.includes("--check") && total) {
    console.log("later.dog's code has no comments: node scripts/no-comments.ts --write removes them.");
    process.exitCode = 1;
  }
  if (failures.length) {
    console.log(`${failures.length} files left alone:\n${failures.join("\n")}`);
    process.exitCode = 1;
  }
}
