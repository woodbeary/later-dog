import { describe, expect, it } from "vitest";
import { looksLikeThreadRefUrl, plainThreadLinks, threadRefUrl } from "./thread-refs";

describe("legacy thread links", () => {
  it("writes the source-conversation link the server still sends", () => {
    expect(threadRefUrl({ botId: "scout", threadId: "a b" })).toBe("laterdog://thread/a%20b?bot=scout");
  });

  it("recognizes old thread links so chat shows them as plain text", () => {
    expect(looksLikeThreadRefUrl(" LaterDog://thread/qa?bot=scout")).toBe(true);
    expect(looksLikeThreadRefUrl("https://example.com/thread/qa")).toBe(false);
  });
});

describe("old stored thread links in sent messages", () => {
  it("turns a stored link back into the #Title the person typed", () => {
    expect(plainThreadLinks("please finish [Fix login](laterdog://thread/abc?bot=b1) first")).toBe("please finish #Fix login first");
  });

  it("unescapes brackets in the stored title and keeps a title that already starts with #", () => {
    expect(plainThreadLinks("see [QA \\[v2\\]](laterdog://thread/x%20y?bot=b1)")).toBe("see #QA [v2]");
    expect(plainThreadLinks("see [#245](laterdog://thread/q?bot=b1)")).toBe("see #245");
  });

  it("leaves code spans, fences and ordinary links alone", () => {
    const code = "`[Fix login](laterdog://thread/abc?bot=b1)`";
    const fence = "```\n[Fix login](laterdog://thread/abc?bot=b1)\n```";
    const web = "[docs](https://example.com/thread/abc)";
    expect(plainThreadLinks(code)).toBe(code);
    expect(plainThreadLinks(fence)).toBe(fence);
    expect(plainThreadLinks(web)).toBe(web);
  });

  it("returns text without thread links unchanged", () => {
    expect(plainThreadLinks("#Fix login stays as typed")).toBe("#Fix login stays as typed");
  });
});
