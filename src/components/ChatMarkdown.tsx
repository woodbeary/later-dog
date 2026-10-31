import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { HighlighterCore } from "shiki/core";
import Markdown, { defaultUrlTransform, type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { fromMarkdown, type Options as MarkdownParseOptions } from "mdast-util-from-markdown";
import { Check, Copy, Download, LoaderCircle, RotateCcw, WrapText, X } from "lucide-react";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { remarkMentions, type MentionPeer } from "@/lib/mentions";
import { MentionFace } from "./MentionFace";

import {
  countLines,
  downloadSnippetFile,
  formatLineCount,
  getLanguageDisplayName,
  getSnippetFileName,
} from "../lib/code-block";
import { repairMarkdownTables } from "../lib/markdown-tables";
import { TRANSCRIPT_WINDOW_SIZE } from "../lib/transcript-window";
import { windowsPathDestinations } from "../../shared/markdown-windows-paths";
import { looksLikeThreadRefUrl } from "../lib/thread-refs";
import { MarkdownImagePreview, MessageFolderFiles, OutsideWorkspaceFile, useLocalFileSave, type MessageAttachmentContext } from "./AttachmentPreview";
import { MarkdownTable } from "./MarkdownTable";
import { RichCard } from "./RichCard";
import { DraftCardView } from "./DraftCard";
import { QuickLookButton } from "./QuickLookButton";
import { TableFileButton } from "./TableFilePreview";
import { mermaidCode, richCard } from "../lib/rich-cards";
import { draftCard, type DraftCard } from "../lib/draft-card";
import { DARK_PIE, diagramPng, exportableDiagram, saveBlob } from "../lib/diagram-export";

const highlightCache = new Map<string, string>();
export const HIGHLIGHT_CACHE_MAX = 200;
export const HIGHLIGHT_CACHE_MAX_CHARS = 4 * 1024 * 1024;
function rememberHighlight(key: string, html: string) {
  if (html.length > HIGHLIGHT_CACHE_MAX_CHARS) return;
  highlightCache.set(key, html);
  let chars = 0;
  for (const cached of highlightCache.values()) chars += cached.length;
  for (const [oldest, oldestHtml] of highlightCache) {
    if (highlightCache.size <= HIGHLIGHT_CACHE_MAX && chars <= HIGHLIGHT_CACHE_MAX_CHARS) break;
    highlightCache.delete(oldest);
    chars -= oldestHtml.length;
  }
}
const mermaidCache = new Map<string, string>();
const MERMAID_CACHE_MAX = 50;
let mermaidRenderId = 0;
const hash = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
};

const LIGHT_THEME = "github-light-default";
const DARK_THEME = "github-dark-default";
const grammarLoaders = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  powershell: () => import("shiki/langs/powershell.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  sass: () => import("shiki/langs/sass.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  mdx: () => import("shiki/langs/mdx.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  dart: () => import("shiki/langs/dart.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  makefile: () => import("shiki/langs/makefile.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  wasm: () => import("shiki/langs/wasm.mjs"),
};
type GrammarFile = keyof typeof grammarLoaders;
const grammarAlias: Record<string, GrammarFile> = {
  js: "javascript", node: "javascript",
  ts: "typescript",
  sh: "bash", zsh: "bash", shell: "bash",
  ps1: "powershell",
  py: "python",
  htm: "html",
  yml: "yaml",
  md: "markdown",
  svg: "xml",
  "c++": "cpp", cc: "cpp", cxx: "cpp",
  cs: "csharp", "c#": "csharp",
  rs: "rust",
  golang: "go",
  rb: "ruby",
  kt: "kotlin",
  gql: "graphql",
  protobuf: "proto",
  docker: "dockerfile",
  make: "makefile",
};
const PLAIN_LANGS = new Set(["", "text", "txt", "plaintext", "plain"]);
let highlighterPromise: Promise<HighlighterCore> | undefined;
const grammarLoading = new Map<string, Promise<void>>();

function grammarFile(lang: string): GrammarFile | undefined {
  const alias = grammarAlias[lang];
  if (alias) return alias;
  return Object.prototype.hasOwnProperty.call(grammarLoaders, lang) ? lang as GrammarFile : undefined;
}

function getHighlighter(): Promise<HighlighterCore> {
  if (highlighterPromise) return highlighterPromise;
  const created = (async () => {
    const { createHighlighterCore } = await import("shiki/core");
    const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
    return createHighlighterCore({
      themes: [
        import("shiki/themes/github-light-default.mjs").then((mod) => mod.default),
        import("shiki/themes/github-dark-default.mjs").then((mod) => mod.default),
      ],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })().catch((error: unknown) => {
    highlighterPromise = undefined;
    throw error;
  });
  highlighterPromise = created;
  return created;
}

function loadGrammar(highlighter: HighlighterCore, file: GrammarFile): Promise<void> {
  const pending = grammarLoading.get(file);
  if (pending) return pending;
  const next = grammarLoaders[file]().then((mod) => highlighter.loadLanguage(mod.default)).catch((error: unknown) => {
    grammarLoading.delete(file);
    throw error;
  });
  grammarLoading.set(file, next);
  return next;
}

async function highlightFence(code: string, lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  const requested = lang.trim().toLowerCase();
  const plain = PLAIN_LANGS.has(requested);
  const file = plain ? undefined : grammarFile(requested);
  if (!plain && !file) throw new Error(`No bundled grammar for ${requested}`);
  if (file) await loadGrammar(highlighter, file);
  return highlighter.codeToHtml(code, {
    lang: file ?? "text",
    themes: { light: LIGHT_THEME, dark: DARK_THEME },
    defaultColor: "light-dark()",
  });
}
const highlightKey = (lang: string, code: string) => `${lang}:${hash(code)}`;
const mermaidKey = (scheme: "dark" | "light", code: string) => `${scheme}:${hash(code)}`;

const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/;
const absolutePath = (value: string): string | null => {
  if (value.startsWith("/") || WINDOWS_PATH.test(value)) return value;
  return null;
};

export const localFilePath = (href?: string): string | null => {
  if (!href) return null;
  if (/^file:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (url.username || url.password || url.port || url.search || url.hash) return null;
      const path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== "localhost") return `//${url.hostname}${path}`;
      return /^\/[a-z]:[\\/]/i.test(path) ? path.slice(1) : absolutePath(path);
    } catch {
      return null;
    }
  }
  if (href.startsWith("\\\\")) return href;
  if (href.startsWith("//")) return null;
  const absolute = absolutePath(href);
  if (absolute) return absolute;
  if (href.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(href)) return null;
  return href;
};

export function chatUrlTransform(value: string): string {
  if (looksLikeThreadRefUrl(value)) return value;
  const url = /^[a-zA-Z]:%5C/i.test(value) ? value.replace(/%5C/gi, "\\") : value;
  if (/^file:\/\//i.test(url) || WINDOWS_PATH.test(url) || url.startsWith("\\\\")) {
    return localFilePath(url) ? url : "";
  }
  return defaultUrlTransform(value);
}

function remarkWindowsPathDestinations(this: { data(): object }) {
  const data = this.data() as { fromMarkdownExtensions?: unknown[] };
  (data.fromMarkdownExtensions ??= []).push(windowsPathDestinations);
}

const gfmParseData: {
  micromarkExtensions?: MarkdownParseOptions["extensions"];
  fromMarkdownExtensions?: MarkdownParseOptions["mdastExtensions"];
} = {};
remarkGfm.call({ data: () => gfmParseData });
const normalizationParseOptions: MarkdownParseOptions = {
  extensions: gfmParseData.micromarkExtensions,
  mdastExtensions: [...(gfmParseData.fromMarkdownExtensions ?? []), windowsPathDestinations],
};

function unwrapLinkedImages() {
  return (tree: { children?: any[] }) => {
    const visit = (node: { children?: any[] }) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        if (child?.type === "link" && child.children?.length === 1 && child.children[0]?.type === "image") {
          const image = child.children[0];
          return { ...image, data: { ...image.data, hProperties: { ...image.data?.hProperties, "data-open-url": child.url } } };
        }
        visit(child);
        return child;
      });
    };
    visit(tree);
  };
}

const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;

export function textDirection(value: string): "rtl" | "ltr" {
  const strong = /\p{Letter}/u.exec(value);
  return strong && RTL_LETTER.test(strong[0]) ? "rtl" : "ltr";
}

interface HastNode {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
}

function blockText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "code" || node.tagName === "pre") return "";
  return (node.children ?? []).map(blockText).join("");
}

export function blockDirection(node: unknown): "rtl" | "ltr" {
  return textDirection(blockText(node as HastNode));
}

interface BlockProps {
  node?: unknown;
  children?: ReactNode;
}

export interface CodeBlockProps {
  code: string;
  lang: string;
}

export function CodeBlock({ code, lang }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(() => highlightCache.get(highlightKey(lang, code)) ?? null);
  const markup = useMemo(() => (html ? { __html: html } : null), [html]);
  const { state: copied, copy } = useCopyFeedback(code);
  const [wrapLines, setWrapLines] = useState(false);

  useEffect(() => {
    const key = highlightKey(lang, code);
    const cached = highlightCache.get(key);
    if (cached) return setHtml(cached);
    let alive = true;
    highlightFence(code, lang || "text")
      .then((out) => {
        if (!alive) return;
        rememberHighlight(key, out);
        setHtml(out);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [code, lang]);

  const download = () => {
    const filename = getSnippetFileName(lang);
    downloadSnippetFile(filename, code);
  };

  const displayLanguage = getLanguageDisplayName(lang);
  const lineCount = countLines(code);

  return (
    <div dir="ltr" className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between gap-2 border-b border-hairline/30 bg-raised/30 px-3 py-1.5 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span title={displayLanguage} className="min-w-0 truncate rounded border border-hairline/40 bg-raised px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-ink select-none">
            {displayLanguage}
          </span>
          {lineCount > 0 && (
            <span className="shrink-0 whitespace-nowrap text-[11px] text-ink-secondary select-none">
              {formatLineCount(lineCount)}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <button
            type="button"
            onClick={() => setWrapLines((w) => !w)}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
              wrapLines
                ? "bg-accent/15 text-accent font-medium"
                : "text-ink-secondary hover:bg-raised hover:text-ink"
            }`}
            title={wrapLines ? "Disable line wrapping" : "Wrap long lines"}
            aria-label={wrapLines ? "Disable line wrapping" : "Wrap long lines"}
            aria-pressed={wrapLines}
          >
            <WrapText size={12} aria-hidden="true" />
            <span className="hidden sm:inline">{wrapLines ? "Unwrap" : "Wrap"}</span>
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title="Download snippet as file"
            aria-label="Download snippet as file"
          >
            <Download size={12} aria-hidden="true" />
            <span className="hidden sm:inline">Save</span>
          </button>
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title={copied === "copied" ? "Copied to clipboard" : copied === "failed" ? t("common.copyFailed") : "Copy code"}
            aria-label={copied === "copied" ? "Code copied to clipboard" : copied === "failed" ? t("common.copyFailed") : "Copy code to clipboard"}
          >
            {copied === "failed" ? (
              <>
                <X size={12} className="text-danger" aria-hidden="true" />
                <span className="text-danger font-medium hidden sm:inline">{t("common.copyFailed")}</span>
              </>
            ) : copied === "copied" ? (
              <>
                <Check size={12} className="text-success" aria-hidden="true" />
                <span className="text-success font-medium hidden sm:inline">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={12} aria-hidden="true" />
                <span className="hidden sm:inline">Copy</span>
              </>
            )}
          </button>
        </div>
      </div>
      {markup ? (
        <div
          className={`text-[13px] leading-relaxed [&_pre]:!bg-transparent [&_pre]:m-0 [&_pre]:p-3 ${
            wrapLines
              ? "whitespace-pre-wrap break-words overflow-x-hidden [&_pre]:!whitespace-pre-wrap [&_pre]:!break-words [&_code]:!whitespace-pre-wrap [&_code]:!break-words"
              : "overflow-x-auto"
          }`}
          dangerouslySetInnerHTML={markup}
        />
      ) : (
        <pre
          className={`p-3 text-[13px] leading-relaxed text-ink ${
            wrapLines
              ? "whitespace-pre-wrap break-words overflow-x-hidden"
              : "overflow-x-auto"
          }`}
        >
          {code}
        </pre>
      )}
    </div>
  );
}

function mermaidScheme(element: HTMLElement | null): "dark" | "light" {
  if (!element || typeof window === "undefined" || typeof window.getComputedStyle !== "function") return "dark";
  try {
    return window.getComputedStyle(element).getPropertyValue("--code-color-scheme").trim() === "light"
      ? "light"
      : "dark";
  } catch {
    return "dark";
  }
}

export interface MermaidDiagramProps {
  code: string;
}

const MERMAID_FONT = '"Inter", -apple-system, BlinkMacSystemFont, "SF UI Text", "Segoe UI", system-ui, sans-serif';

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  const frame = useRef<HTMLDivElement | null>(null);
  const [skinEpoch, setSkinEpoch] = useState(0);
  const [svg, setSvg] = useState<string | null>(() =>
    mermaidCache.get(mermaidKey(mermaidScheme(typeof document === "undefined" ? null : document.documentElement), code)) ?? null);
  const markup = useMemo(() => (svg ? { __html: svg } : null), [svg]);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [saving, setSaving] = useState<"png" | "svg" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const { state: copied, copy } = useCopyFeedback(code);

  const save = async (format: "png" | "svg") => {
    setSaving(format);
    setSaveError(null);
    try {
      const module = await import("mermaid");
      mermaidRenderId += 1;
      const picture = await module.default.render(`laterdog-mermaid-export-${mermaidRenderId}`, exportableDiagram(code));
      saveBlob(`diagram.${format}`, format === "png"
        ? await diagramPng(picture.svg)
        : new Blob([picture.svg], { type: "image/svg+xml;charset=utf-8" }));
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(null);
    }
  };

  useEffect(() => {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") return;
    const observer = new MutationObserver(() => setSkinEpoch((epoch) => epoch + 1));
    observer.observe(document.documentElement, { subtree: true, attributeFilter: ["data-skin"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const scheme = mermaidScheme(frame.current);
    const key = mermaidKey(scheme, code);
    const cached = mermaidCache.get(key);
    if (cached) {
      setSvg(cached);
      setError(null);
      return;
    }
    let alive = true;
    import("mermaid")
      .then((module) => {
        mermaidRenderId += 1;
        module.default.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: scheme === "light" ? "default" : "dark",
          ...(scheme === "light" ? {} : { themeVariables: DARK_PIE }),
          fontFamily: MERMAID_FONT,
        });
        return module.default.render(`laterdog-mermaid-${mermaidRenderId}`, code);
      })
      .then((out) => {
        if (!alive) return;
        if (mermaidCache.size >= MERMAID_CACHE_MAX) {
          const first = mermaidCache.keys().next().value;
          if (first) mermaidCache.delete(first);
        }
        mermaidCache.set(key, out.svg);
        setSvg(out.svg);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message.length > 300 ? `${message.slice(0, 300)}…` : message);
      });
    return () => {
      alive = false;
    };
  }, [code, skinEpoch]);

  return (
    <div ref={frame} dir="ltr" className="my-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset">
      <div className="flex items-center justify-between gap-2 border-b border-hairline/30 bg-raised/30 px-3 py-1.5 text-xs">
        <span title="Mermaid diagram" className="min-w-0 truncate rounded border border-hairline/40 bg-raised px-1.5 py-0.5 text-[11px] font-medium tracking-wide text-ink select-none">
          Mermaid diagram
        </span>
        <div className="flex shrink-0 items-center gap-1 whitespace-nowrap">
          <button
            type="button"
            onClick={() => setShowSource((visible) => !visible)}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
              showSource
                ? "bg-accent/15 text-accent font-medium"
                : "text-ink-secondary hover:bg-raised hover:text-ink"
            }`}
            title={showSource ? "Hide diagram source" : "Show diagram source"}
            aria-label={showSource ? "Hide diagram source" : "Show diagram source"}
            aria-pressed={showSource}
          >
            <WrapText size={12} aria-hidden="true" />
            <span className="hidden sm:inline">{showSource ? "Hide source" : "Show source"}</span>
          </button>
          {svg && !error && (["png", "svg"] as const).map((format) => (
            <button
              key={format}
              type="button"
              onClick={() => void save(format)}
              disabled={saving !== null}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors disabled:opacity-50"
              title={t(format === "png" ? "richCard.savePng" : "richCard.saveSvg")}
              aria-label={t(format === "png" ? "richCard.savePng" : "richCard.saveSvg")}
            >
              {saving === format ? <LoaderCircle size={12} className="animate-spin" aria-hidden="true" /> : <Download size={12} aria-hidden="true" />}
              <span className="hidden sm:inline">{format.toUpperCase()}</span>
            </button>
          ))}
          <button
            type="button"
            onClick={copy}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-ink-secondary hover:bg-raised hover:text-ink transition-colors"
            title={copied === "copied" ? "Copied to clipboard" : copied === "failed" ? t("common.copyFailed") : "Copy diagram source"}
            aria-label={copied === "copied" ? "Diagram source copied to clipboard" : copied === "failed" ? t("common.copyFailed") : "Copy diagram source to clipboard"}
          >
            {copied === "failed" ? (
              <>
                <X size={12} className="text-danger" aria-hidden="true" />
                <span className="text-danger font-medium hidden sm:inline">{t("common.copyFailed")}</span>
              </>
            ) : copied === "copied" ? (
              <>
                <Check size={12} className="text-success" aria-hidden="true" />
                <span className="text-success font-medium hidden sm:inline">Copied!</span>
              </>
            ) : (
              <>
                <Copy size={12} aria-hidden="true" />
                <span className="hidden sm:inline">Copy</span>
              </>
            )}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="px-3 pt-2 text-[12px] text-danger">
          Diagram could not be rendered: {error}
        </p>
      )}
      {saveError && (
        <p role="alert" className="px-3 pt-2 text-[12px] text-danger">
          {t("richCard.saveFailed", { reason: saveError })}
        </p>
      )}
      {markup && (
        <div
          className="overflow-x-auto p-3 [&_svg]:!max-w-full"
          dangerouslySetInnerHTML={markup}
        />
      )}
      {(showSource || !svg || error) && (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed text-ink">{code}</pre>
      )}
    </div>
  );
}

function LocalFileLink({ filePath, children, message }: { filePath: string; children?: ReactNode; message?: MessageAttachmentContext }) {
  const save = useLocalFileSave(filePath, undefined, message);
  if (!message) {
    return <span title="Unavailable legacy file reference" className="break-words text-ink-secondary">{children}</span>;
  }
  const label = save.state === "saving"
    ? "Saving…"
    : save.state === "saved"
      ? "Saved"
      : save.state === "failed"
        ? "Retry"
        : null;

  return (
    <span dir="ltr" className="inline-flex flex-wrap items-center gap-x-1.5 [unicode-bidi:isolate]">
      <TableFileButton path={filePath} name={filePath.split(/[\\/]/).at(-1) ?? filePath} message={message} />
      <QuickLookButton path={filePath} name={filePath.split(/[\\/]/).at(-1) ?? filePath} message={message} />
      <button
        type="button"
        onClick={() => void save.save()}
        disabled={save.state === "saving"}
        title="Save a copy"
        className="inline-flex items-center gap-1 break-words text-start text-accent underline decoration-accent/40 hover:decoration-accent disabled:cursor-wait"
      >
        {children}
        {save.state === "saving" ? (
          <LoaderCircle size={12} className="shrink-0 animate-spin" aria-hidden="true" />
        ) : save.state === "saved" ? (
          <Check size={12} className="shrink-0 text-success" aria-hidden="true" />
        ) : save.state === "failed" ? (
          <RotateCcw size={12} className="shrink-0" aria-hidden="true" />
        ) : (
          <Download size={12} className="shrink-0" aria-hidden="true" />
        )}
      </button>
      {label && (
        <span
          role={save.state === "failed" ? "alert" : "status"}
          title={save.state === "saved" ? save.savedTo : undefined}
          className={`text-[12px] ${save.state === "saved" ? "text-success" : save.state === "failed" ? "text-danger" : "text-ink-secondary"}`}
        >
          {save.state === "failed" ? save.reason : label}
        </span>
      )}
      {save.state === "failed" && save.outsideWorkspace && (
        <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[12px]">
          <OutsideWorkspaceFile filePath={filePath} />
        </span>
      )}
      {save.folder && <MessageFolderFiles folderPath={filePath} listing={save.folder} message={message} />}
    </span>
  );
}

export function markdownImageName(src: string, alt?: string): string {
  const supplied = alt?.trim();
  if (supplied) return supplied;
  try {
    const path = decodeURIComponent(new URL(src, "https://laterdog.invalid").pathname);
    const name = path.split(/[\\/]/).filter(Boolean).at(-1)?.trim();
    if (name) return name;
  } catch {}
  return "Image";
}

export function markdownImageOpenUrl(src: string): string | undefined {
  try {
    const url = new URL(src.startsWith("//") ? `https:${src}` : src);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function Spoiler({ children }: { children?: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  if (!revealed) {
    return (
      <span className="relative mx-px inline-block rounded px-1 py-px">
        <span
          aria-hidden="true"
          className="pointer-events-none select-none bg-raised text-transparent [&_*]:!text-transparent [&_a]:!no-underline"
        >
          {children}
        </span>
        <button
          type="button"
          aria-label="Reveal spoiler"
          title="Reveal spoiler"
          onClick={() => setRevealed(true)}
          className="absolute inset-0 rounded bg-raised/90 transition-colors hover:bg-raised/75"
        />
      </span>
    );
  }
  return (
    <span className="mx-px inline rounded px-1 py-px text-[13px] leading-relaxed text-ink underline decoration-dotted decoration-hairline underline-offset-2">
      {children}
      <button
        type="button"
        aria-label="Hide spoiler"
        title="Hide spoiler"
        onClick={() => setRevealed(false)}
        className="ms-1 rounded px-0.5 text-[11px] text-ink-secondary hover:text-ink"
      >
        Hide
      </button>
    </span>
  );
}

const NO_MENTION_PEERS: readonly MentionPeer[] = [];

const MARKDOWN_IMAGE = "![";

const CURRENCY_DOLLAR = /(?<![$\p{L}\p{N}])(?:R|US|AU|A|CA|C|NZ|HK|SG|S|MX|NT|BZ|Z)\$(?=[ \t\u00a0]?\d)/gu;

function escapeLiteralDollars(text: string): string {
  const display: string[] = [];
  const hidden = text
    .replace(/\$\$[\s\S]*?\$\$/g, (math) => `\u0000LATERDOG_MATH_${display.push(math) - 1}\u0000`)
    .replace(CURRENCY_DOLLAR, (sign) => `${sign.slice(0, -1)}\\$`);
  const literal = new Set<number>();
  const singles: number[] = [];
  for (let i = 0; i < hidden.length; i++) {
    if (hidden[i] === "\\") i++;
    else if (hidden[i] === "$") singles.push(i);
  }
  let open: number | null = null;
  for (const at of singles) {
    if (open !== null) {
      const closes = !/\s/.test(hidden[at - 1]) && !/\d/.test(hidden[at + 1] ?? "")
        && !/\n[ \t]*\n/.test(hidden.slice(open, at));
      if (closes) { open = null; continue; }
      literal.add(open);
    }
    open = /\S/.test(hidden[at + 1] ?? "") ? at : null;
    if (open === null) literal.add(at);
  }
  if (open !== null) literal.add(open);
  let escaped = "";
  for (let i = 0; i < hidden.length; i++) escaped += literal.has(i) ? "\\$" : hidden[i];
  display.forEach((math, index) => {
    escaped = escaped.split(`\u0000LATERDOG_MATH_${index}\u0000`).join(math);
  });
  return escaped;
}

export function normalizeMathDelimiters(text: string, imageOffsets?: Map<number, number>): string {
  const protectedCode: Array<{ value: string; sourceOffset: number }> = [];
  const protect = (value: string, sourceOffset: number): string => {
    const token = `\u0000LATERDOG_CODE_${protectedCode.length}\u0000`;
    protectedCode.push({ value, sourceOffset });
    return token;
  };
  const spans: Array<{ start: number; end: number }> = [];
  const imageStarts: number[] = [];
  const visit = (node: { type: string; children?: any[]; position?: { start: { offset?: number }; end: { offset?: number } } }, protectedParent = false) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    const image = node.type === "image" || node.type === "imageReference";
    if (image && start !== undefined) imageStarts.push(start);
    const labelEnd = node.type === "link" && start !== undefined && text[start] === "["
      ? node.children?.at(-1)?.position?.end.offset : undefined;
    const protectedNode = node.type === "code" || node.type === "inlineCode" || node.type === "definition" || node.type === "linkReference" || node.type === "link" || (imageOffsets !== undefined && image);
    if (!protectedParent && protectedNode && start !== undefined && end !== undefined) {
      spans.push({ start: labelEnd ?? start, end });
    }
    node.children?.forEach((child) => visit(child, protectedParent || (protectedNode && labelEnd === undefined)));
  };
  visit(fromMarkdown(text, normalizationParseOptions));
  for (const { start, end } of spans.sort((a, b) => b.start - a.start)) {
    text = text.slice(0, start) + protect(text.slice(start, end), start) + text.slice(end);
  }
  let normalized = text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, math: string) => `$$\n${math}\n$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, math: string) => `$${math.trim()}$`)
    .replace(/\$\$[ \t]*([^\n][\s\S]*?)[ \t]*\$\$/g, (_match, math: string) => `$$\n${math}\n$$`);
  normalized = escapeLiteralDollars(normalized);
  let shift = 0;
  // oxlint-disable-next-line no-control-regex -- restore opaque code and image sentinels
  normalized = normalized.replace(/\u0000LATERDOG_CODE_(\d+)\u0000/g, (token, index: string, at: number) => {
    const part = protectedCode[Number(index)];
    if (!part) return token;
    const { value, sourceOffset } = part;
    for (const imageOffset of imageStarts) {
      if (imageOffset >= sourceOffset && imageOffset < sourceOffset + value.length) {
        imageOffsets?.set(at + shift + imageOffset - sourceOffset, imageOffset);
      }
    }
    shift += value.length - token.length;
    return value;
  });
  return normalized;
}

const normalizedCache = new Map<string, Pick<MessageScope, "imageOffsets"> & { source: string }>();
const NORMALIZED_CACHE_MAX = TRANSCRIPT_WINDOW_SIZE * 2;

function normalizeMessageMarkdown(text: string) {
  const cached = normalizedCache.get(text);
  if (cached) return cached;
  const imageOffsets = text.includes(MARKDOWN_IMAGE) ? new Map<number, number>() : undefined;
  const source = normalizeMathDelimiters(imageOffsets ? text : repairMarkdownTables(text), imageOffsets);
  if (normalizedCache.size >= NORMALIZED_CACHE_MAX) {
    const first = normalizedCache.keys().next().value;
    if (first !== undefined) normalizedCache.delete(first);
  }
  const normalized = { source, imageOffsets };
  normalizedCache.set(text, normalized);
  return normalized;
}

interface MessageScope {
  message?: MessageAttachmentContext;
  imageOffsets?: Map<number, number>;
}

const MessageScopeContext = createContext<MessageScope>({});

function MarkdownCode({ children }: { children?: ReactNode }) {
  const child: any = Array.isArray(children) ? children[0] : children;
  const className: string = child?.props?.className ?? "";
  const lang = /language-([^\s]+)/.exec(className)?.[1] ?? "";
  const flat = (n: any): string =>
    typeof n === "string" ? n : Array.isArray(n) ? n.map(flat).join("") : (n?.props?.children ? flat(n.props.children) : "");
  const code = flat(child?.props?.children).replace(/\n$/, "");
  const diagram = mermaidCode(lang, code);
  if (diagram !== null) return <MermaidDiagram code={diagram} />;
  const card = richCard(lang, code);
  if (card) return <RichCard card={card} />;
  const draft = draftCard(lang, code);
  if (draft) return <ScopedDraft card={draft} />;
  return <CodeBlock code={code} lang={lang} />;
}

function ScopedDraft({ card }: { card: DraftCard }) {
  const { message } = useContext(MessageScopeContext);
  return <DraftCardView card={card} messageId={message?.messageId} />;
}

function MarkdownImage(props: ComponentProps<"img"> & ExtraProps) {
  const { message, imageOffsets } = useContext(MessageScopeContext);
  const { src, alt } = props;
  if (!src) {
    return <span className="text-[12px] text-danger" role="alert">Image unavailable</span>;
  }
  const filePath = localFilePath(src) ?? undefined;
  const sourceOffset = props.node?.position?.start.offset;
  return (
    <MarkdownImagePreview
      src={src}
      name={markdownImageName(src, alt)}
      openUrl={markdownImageOpenUrl(typeof (props as Record<string, unknown>)["data-open-url"] === "string" ? String((props as Record<string, unknown>)["data-open-url"]) : src)}
      filePath={filePath}
      message={filePath ? message : undefined}
      sourceOffset={sourceOffset === undefined ? undefined : imageOffsets?.get(sourceOffset) ?? sourceOffset}
    />
  );
}

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { message } = useContext(MessageScopeContext);
  if (href && looksLikeThreadRefUrl(href)) return <span className="break-words">{children}</span>;
  const localPath = localFilePath(href);
  if (localPath) return <LocalFileLink filePath={localPath} message={message}>{children}</LocalFileLink>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      dir="auto"
      className="break-words text-accent underline decoration-accent/40 hover:decoration-accent [unicode-bidi:isolate]"
    >
      {children}
    </a>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: MarkdownCode,
  img: MarkdownImage,
  code({ children }: { children?: ReactNode }) {
    return (
      <code dir="ltr" className="rounded bg-inset px-1 py-px text-[13px] break-words [unicode-bidi:isolate]">{children}</code>
    );
  },
  span(props) {
    const { node: _node, children, ...rest } = props;
    const { "data-mention-dog": dog, "data-mention-body": body, ...attributes } = rest as Record<string, unknown>;
    if (typeof dog === "string") {
      return <span {...attributes}><MentionFace color={dog} body={typeof body === "string" ? body : undefined} />{children}</span>;
    }
    return <span {...rest}>{children}</span>;
  },
  a: MarkdownLink,
  table({ node, children }: BlockProps) {
    return <MarkdownTable direction={blockDirection(node)}>{children}</MarkdownTable>;
  },
  th({ children }: { children?: ReactNode }) {
    return (
      <th className="border-b border-hairline/40 px-2 py-1.5 text-start font-semibold">{children}</th>
    );
  },
  td({ children }: { children?: ReactNode }) {
    return <td className="border-b border-hairline/20 px-2 py-1.5 align-top">{children}</td>;
  },
  p({ node, children }: BlockProps) {
    return <p dir={blockDirection(node)}>{children}</p>;
  },
  ul({ node, children }: BlockProps) {
    return <ul dir={blockDirection(node)} className="list-disc space-y-1 ps-5">{children}</ul>;
  },
  ol({ node, children }: BlockProps) {
    return <ol dir={blockDirection(node)} className="list-decimal space-y-1 ps-5">{children}</ol>;
  },
  h1({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-2 text-[16px] font-semibold">{children}</div>;
  },
  h2({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-2 text-[15.5px] font-semibold">{children}</div>;
  },
  h3({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 font-semibold">{children}</div>;
  },
  h4({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 font-semibold">{children}</div>;
  },
  h5({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 text-[14px] font-semibold">{children}</div>;
  },
  h6({ node, children }: BlockProps) {
    return <div dir={blockDirection(node)} className="mt-1.5 text-[13.5px] font-semibold text-ink-secondary">{children}</div>;
  },
  blockquote({ node, children }: BlockProps) {
    return (
      <blockquote dir={blockDirection(node)} className="border-s-2 border-hairline ps-3 text-ink-secondary">{children}</blockquote>
    );
  },
  del({ children }: { children?: ReactNode }) {
    return <Spoiler>{children}</Spoiler>;
  },
  hr() {
    return <hr className="border-hairline/40" />;
  },
};

function ChatMarkdownComponent({ text, message, mentionPeers = NO_MENTION_PEERS, everyone = false }: {
  text: string; message?: MessageAttachmentContext;
  mentionPeers?: readonly MentionPeer[]; everyone?: boolean;
}) {
  const { source, imageOffsets } = normalizeMessageMarkdown(text);
  return (
    <MessageScopeContext.Provider value={{ message, imageOffsets }}>
      <div className="chat-md min-w-0 [&>*+*]:mt-2">
        <Markdown
          remarkPlugins={[remarkGfm, remarkMath, remarkWindowsPathDestinations, unwrapLinkedImages, [remarkMentions, { peers: mentionPeers, everyone }]]}
          rehypePlugins={[rehypeKatex]}
          urlTransform={chatUrlTransform}
          components={MARKDOWN_COMPONENTS}
        >
          {source}
        </Markdown>
      </div>
    </MessageScopeContext.Provider>
  );
}

export function samePeers(previous: readonly MentionPeer[], next: readonly MentionPeer[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((peer, index) => {
    const other = next[index]!;
    return peer.name === other.name && peer.hidden === other.hidden && peer.color === other.color
      && peer.id === other.id && peer.mascotBody === other.mascotBody && peer.self === other.self
      && (peer.formerNames ?? []).join("\n") === (other.formerNames ?? []).join("\n");
  });
}

export const ChatMarkdown = memo(ChatMarkdownComponent, (previous, next) => (
  previous.text === next.text
  && samePeers(previous.mentionPeers ?? NO_MENTION_PEERS, next.mentionPeers ?? NO_MENTION_PEERS)
  && previous.everyone === next.everyone
  && previous.message?.threadId === next.message?.threadId
  && previous.message?.messageId === next.message?.messageId
));
