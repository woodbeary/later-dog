import { fromMarkdown, type Options } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";

type MarkdownNode = {
  type: string;
  value?: string;
  alt?: string | null;
  start?: number | null;
  ordered?: boolean | null;
  children?: MarkdownNode[];
};

const SOURCE_LIMIT = 4_000;
const CACHE_LIMIT = 200;
const SKIPPED = new Set(["definition", "footnoteDefinition", "footnoteReference", "thematicBreak"]);
const BLOCKS = new Set(["paragraph", "heading", "blockquote", "list", "listItem", "table", "tableRow", "tableCell"]);

const gfm: {
  micromarkExtensions?: Options["extensions"];
  fromMarkdownExtensions?: Options["mdastExtensions"];
} = {};
remarkGfm.call({ data: () => gfm });
const parseOptions: Options = { extensions: gfm.micromarkExtensions, mdastExtensions: gfm.fromMarkdownExtensions };
const cache = new Map<string, string>();

function flatten(node: MarkdownNode, prose: string[], code: string[]): void {
  if (SKIPPED.has(node.type)) return;
  if (node.type === "code") {
    code.push(` ${node.value ?? ""} `);
    return;
  }
  if (node.type === "image" || node.type === "imageReference") {
    prose.push(node.alt ?? "");
    return;
  }
  if (node.type === "break") {
    prose.push(" ");
    return;
  }
  if (typeof node.value === "string") {
    prose.push(node.value);
    return;
  }
  const block = BLOCKS.has(node.type);
  if (block) prose.push(" ");
  node.children?.forEach((child, index) => {
    if (node.type === "list" && node.ordered) prose.push(` ${(node.start ?? 1) + index}. `);
    flatten(child, prose, code);
  });
  if (block) prose.push(" ");
}

function oneLine(parts: string[]): string {
  return parts.join("").replace(/\s+/g, " ").trim();
}

export function markdownPreview(text: string): string {
  const source = text.length > SOURCE_LIMIT ? text.slice(0, SOURCE_LIMIT) : text;
  const known = cache.get(source);
  if (known !== undefined) return known;
  const prose: string[] = [];
  const code: string[] = [];
  try {
    flatten(fromMarkdown(source, parseOptions) as MarkdownNode, prose, code);
  } catch {
    return oneLine([source]);
  }
  const line = oneLine(prose) || oneLine(code);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(source, line);
  return line;
}
