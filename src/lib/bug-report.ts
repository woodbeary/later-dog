import { FEEDBACK_URL, platformLabel } from "@/lib/app-links";

export const BUG_REPORT_TEXT_LIMIT = 10_000;
export const BUG_REPORT_URL_LIMIT = 6_000;
const TITLE_LIMIT = 80;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const BROWSER_SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Macintosh|Mac OS X/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux|X11/, "Linux"],
];

export interface BugReportDraft {
  happened: string;
  expected: string;
  conversationId?: string | null;
  diagnostics?: boolean;
  version: string;
  os: string;
}

export interface BugReportIssue {
  url: string;
  report: string;
  shortened: boolean;
}

function clean(text: string): string {
  return text.replace(LONE_SURROGATE, "�").replace(/\r\n?/g, "\n").trim();
}

function cut(text: string, limit: number): string {
  const chars = Array.from(text);
  return chars.length <= limit ? text : `${chars.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}

export function bugReportOs(platform: string | undefined, userAgent = ""): string {
  const desktop = platformLabel(platform);
  if (desktop) return desktop;
  const system = BROWSER_SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  return system ? `${system} (web)` : "web";
}

export function bugReportTitle(happened: string): string {
  const line = clean(happened).split("\n").map((part) => part.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  return cut(line, TITLE_LIMIT);
}

function body(draft: BugReportDraft, happened: string, expected: string): string {
  const sections = [`**What happened**\n\n${happened}`];
  if (expected) sections.push(`**What you expected**\n\n${expected}`);
  const conversation = draft.conversationId?.replace(/[`\s]/g, "");
  if (conversation) sections.push(`**Conversation ID**: \`${conversation}\``);
  if (draft.diagnostics) sections.push("**Evidence**\n\n<!-- Drag the diagnostics file later.dog saved into this box to attach it. -->");
  sections.push(`**Versions**: later.dog ${draft.version.trim() || "dev"} · ${draft.os.trim() || "unknown"}`);
  return `${sections.join("\n\n")}\n`;
}

function issueUrl(title: string, text: string): string {
  return `${FEEDBACK_URL}/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(text)}`;
}

export function bugReportIssue(draft: BugReportDraft, limit = BUG_REPORT_URL_LIMIT): BugReportIssue {
  const happened = clean(draft.happened);
  const expected = clean(draft.expected);
  const title = bugReportTitle(happened);
  const report = body(draft, happened, expected);
  const full = issueUrl(title, report);
  if (full.length <= limit) return { url: full, report, shortened: false };
  const shortenedTo = (cap: number) => issueUrl(title, body(draft, cut(happened, cap), cut(expected, cap)));
  let low = 0;
  let high = Math.max(Array.from(happened).length, Array.from(expected).length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (shortenedTo(middle).length <= limit) low = middle;
    else high = middle - 1;
  }
  return { url: shortenedTo(low), report, shortened: true };
}
