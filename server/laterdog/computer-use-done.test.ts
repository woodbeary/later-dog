import { describe, expect, it } from "vitest";
import { doneRuleSchema, livePageCheck } from "./computer-use-done.ts";

const RULE = { url: "https://clinic.example/requests/42", contains: "Request received" };
const page = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
const check = (fetchImpl: typeof fetch) => livePageCheck(fetchImpl)(RULE, new AbortController().signal);

describe("the live-page check", () => {
  it("passes only when the page answers and shows the expected text", async () => {
    expect(await check(page(200, "<h1>Request received</h1>"))).toEqual({ passed: true, detail: "HTTP 200; the page shows the expected text." });
    expect(await check(page(200, "<h1>Sign in</h1>"))).toEqual({ passed: false, detail: "HTTP 200; the expected text is not on the page." });
    expect(await check(page(404, "Request received"))).toEqual({ passed: false, detail: "The page answered HTTP 404." });
  });

  it("fails when the page cannot be reached or is too large to read", async () => {
    expect(await check((async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch)).toEqual({ passed: false, detail: "The page could not be reached." });
    expect(await check(page(200, "x".repeat(2 * 1024 * 1024 + 1)))).toEqual({ passed: false, detail: "The page is larger than 2 MB, so it was not checked." });
  });

  it("is written down before the run as an https page and the text to find", () => {
    expect(doneRuleSchema.parse({ pageCheck: RULE })).toEqual({ pageCheck: RULE });
    expect(doneRuleSchema.parse({ pageCheck: null })).toEqual({ pageCheck: null });
    expect(doneRuleSchema.parse({ pageCheck: { url: "http://127.0.0.1:4100/ok", contains: "ok" } }).pageCheck?.url).toBe("http://127.0.0.1:4100/ok");
    expect(doneRuleSchema.safeParse({ pageCheck: { url: "ftp://clinic.example/", contains: "ok" } }).success).toBe(false);
    expect(doneRuleSchema.safeParse({ pageCheck: RULE, agent: "may finish" }).success).toBe(false);
  });
});
