import { describe, expect, it } from "vitest";
import { FEEDBACK_URL } from "./app-links";
import { BUG_REPORT_URL_LIMIT, bugReportIssue, bugReportOs, bugReportTitle, type BugReportDraft } from "./bug-report";

const draft = (patch: Partial<BugReportDraft> = {}): BugReportDraft => ({
  happened: "The Computer panel spun forever.",
  expected: "The box to start.",
  version: "0.1.27",
  os: "macOS",
  ...patch,
});

function opened(url: string) {
  const parsed = new URL(url);
  return {
    base: `${parsed.origin}${parsed.pathname}`,
    keys: [...parsed.searchParams.keys()],
    title: parsed.searchParams.get("title") ?? "",
    body: parsed.searchParams.get("body") ?? "",
  };
}

describe("bug report issue link", () => {
  it("opens a new issue on later.dog's tracker with only a title and a body", () => {
    const { base, keys } = opened(bugReportIssue(draft()).url);
    expect(base).toBe(`${FEEDBACK_URL}/new`);
    expect(keys).toEqual(["title", "body"]);
  });

  it("follows the bug template's sections and adds the version and system", () => {
    const issue = bugReportIssue(draft());
    const { title, body } = opened(issue.url);
    expect(title).toBe("The Computer panel spun forever.");
    expect(body).toBe(
      "**What happened**\n\nThe Computer panel spun forever.\n\n**What you expected**\n\nThe box to start.\n\n**Versions**: later.dog 0.1.27 · macOS\n",
    );
    expect(issue.report).toBe(body);
    expect(issue.shortened).toBe(false);
  });

  it("encodes every character the link needs to carry", () => {
    const happened = "50% of runs & then #2 fails?\nline two + more = 😀";
    const { url } = bugReportIssue(draft({ happened }));
    const query = url.slice(url.indexOf("?") + 1);
    expect(query).not.toMatch(/[\s#?+😀]/u);
    expect(query.split("&")).toHaveLength(2);
    expect(query.match(/=/g)).toHaveLength(2);
    expect(opened(url).body).toContain(happened);
  });

  it("leaves out an empty expectation, and the conversation unless you include it", () => {
    const { body } = opened(bugReportIssue(draft({ expected: "  " })).url);
    expect(body).not.toContain("What you expected");
    expect(body).not.toContain("Conversation ID");
    expect(opened(bugReportIssue(draft({ conversationId: "thread-42" })).url).body).toContain("**Conversation ID**: `thread-42`");
  });

  it("never puts diagnostics in the link, only a note to attach the saved file", () => {
    const { body } = opened(bugReportIssue(draft({ diagnostics: true })).url);
    expect(body).toContain("**Evidence**");
    expect(body).toContain("Drag the diagnostics file");
    expect(body).not.toMatch(/## (App|Configuration|Server log)/);
    expect(opened(bugReportIssue(draft()).url).body).not.toContain("Evidence");
  });

  it("titles the issue with the first line you wrote, cut to a readable length", () => {
    expect(bugReportTitle("\n\n   Sidebar   froze \n after that")).toBe("Sidebar froze");
    const long = bugReportTitle("word ".repeat(40));
    expect(Array.from(long).length).toBeLessThanOrEqual(80);
    expect(long.endsWith("…")).toBe(true);
  });

  it("keeps the link under the limit by shortening the longest text, and keeps the full report to copy", () => {
    const happened = `Start ${"a long description ".repeat(700)}end`;
    const issue = bugReportIssue(draft({ happened, expected: "Short.", conversationId: "thread-42" }));
    expect(issue.url.length).toBeLessThanOrEqual(BUG_REPORT_URL_LIMIT);
    expect(issue.url.length).toBeGreaterThan(BUG_REPORT_URL_LIMIT - 200);
    expect(issue.shortened).toBe(true);
    const { body } = opened(issue.url);
    expect(body).toContain("Start a long description");
    expect(body).toContain("…");
    expect(body).toContain("**What you expected**\n\nShort.");
    expect(body).toContain("**Conversation ID**: `thread-42`");
    expect(body).toContain("**Versions**: later.dog 0.1.27 · macOS");
    expect(issue.report).toContain(`${"a long description ".repeat(699)}a long description end`);
  });

  it("stays under the limit even when every character needs several bytes", () => {
    const issue = bugReportIssue(draft({ happened: "😀".repeat(10_000), expected: "日本語".repeat(3_000) }));
    expect(issue.url.length).toBeLessThanOrEqual(BUG_REPORT_URL_LIMIT);
    expect(() => decodeURIComponent(issue.url)).not.toThrow();
  });

  it("survives text with a broken surrogate pair", () => {
    const issue = bugReportIssue(draft({ happened: "bad \uD83D text" }));
    expect(opened(issue.url).body).toContain("bad � text");
  });
});

describe("bug report system name", () => {
  it("names the desktop system from the app's platform", () => {
    expect(bugReportOs("darwin")).toBe("macOS");
    expect(bugReportOs("win32", "anything")).toBe("Windows");
  });

  it("names the browser's system when later.dog runs on the web", () => {
    expect(bugReportOs(undefined, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe("iOS (web)");
    expect(bugReportOs(undefined, "Mozilla/5.0 (Linux; Android 15)")).toBe("Android (web)");
    expect(bugReportOs(undefined, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("macOS (web)");
    expect(bugReportOs(undefined, "")).toBe("web");
  });
});
