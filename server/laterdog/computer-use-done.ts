import { z } from "zod";
import { readCapped } from "./cloud-computers.ts";

export const PAGE_CHECK_TIMEOUT_MS = 15_000;
export const PAGE_CHECK_MAX_BYTES = 2 * 1024 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const pageUrl = z.string().max(2000).url().refine((raw) => {
  const url = new URL(raw);
  return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)));
}, "The page check needs an https address (or loopback http) with no credentials in it");

export const doneRuleSchema = z.object({
  pageCheck: z.object({ url: pageUrl, contains: z.string().trim().min(1).max(500) }).strict().nullable(),
}).strict();
export type DoneRule = z.infer<typeof doneRuleSchema>;
export type PageCheckRule = NonNullable<DoneRule["pageCheck"]>;

export const DONE_SOURCES = ["person", "page_check"] as const;
export type DoneSource = typeof DONE_SOURCES[number];

export interface PageCheckResult {
  passed: boolean;
  detail: string;
}

export type PageCheck = (rule: PageCheckRule, signal: AbortSignal) => Promise<PageCheckResult>;

export function livePageCheck(fetchImpl: typeof fetch = fetch): PageCheck {
  return async (rule, signal) => {
    const timeout = AbortSignal.timeout(PAGE_CHECK_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(rule.url, { headers: { accept: "text/html, text/plain, application/json" }, signal: AbortSignal.any([signal, timeout]) });
    } catch {
      return { passed: false, detail: timeout.aborted ? "The page did not answer in 15 seconds." : "The page could not be reached." };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { passed: false, detail: `The page answered HTTP ${response.status}.` };
    }
    let text: string;
    try { text = (await readCapped(response, PAGE_CHECK_MAX_BYTES, () => new Error("too large"))).toString("utf8"); }
    catch { return { passed: false, detail: "The page is larger than 2 MB, so it was not checked." }; }
    return text.includes(rule.contains)
      ? { passed: true, detail: `HTTP ${response.status}; the page shows the expected text.` }
      : { passed: false, detail: `HTTP ${response.status}; the expected text is not on the page.` };
  };
}
