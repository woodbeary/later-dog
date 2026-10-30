import type { LookupAddress } from "node:dns";
import { describe, expect, it, vi } from "vitest";
import { LinkPreviews, pageMeta, previewTarget, type FetchedPage } from "./link-preview.ts";

const PAGE = `<!doctype html><html><head>
<title>Fallback title</title>
<meta property="og:title" content="Blue Bottle &amp; Friends">
<meta name="description" content="Coffee in Oakland">
<meta property="og:image" content="/images/cup.jpg">
<meta property="og:site_name" content='Blue Bottle'>
</head><body>ignored</body></html>`;

const publicHost = async (): Promise<LookupAddress[]> => [{ address: "93.184.216.34", family: 4 }];

describe("link preview targets", () => {
  it("only reads plain https addresses on public names", () => {
    expect(previewTarget("https://bluebottlecoffee.com/cafes#oakland")?.toString()).toBe("https://bluebottlecoffee.com/cafes");
    for (const bad of ["http://example.com", "https://user:pw@example.com", "https://example.com:8443/", "https://127.0.0.1/", "https://[::1]/",
      "https://localhost/", "https://email.internal/", "https://printer.local/", "https://intranet/", "javascript:alert(1)", "not a url"]) {
      expect(previewTarget(bad), bad).toBeNull();
    }
  });
});

describe("page metadata", () => {
  it("reads the title, description, picture and site from the page head", () => {
    expect(pageMeta(PAGE, new URL("https://bluebottlecoffee.com/cafes"))).toEqual({
      title: "Blue Bottle & Friends", description: "Coffee in Oakland", image: "https://bluebottlecoffee.com/images/cup.jpg", site: "Blue Bottle",
    });
  });

  it("falls back to the page title, drops pictures that aren't https, and needs a title", () => {
    expect(pageMeta('<head><title> Plain &#8212; page </title><meta property="og:image" content="http://x.example/a.png"></head>', new URL("https://x.example/")))
      .toEqual({ title: "Plain — page" });
    expect(pageMeta("<head><meta name=description content=nothing></head>", new URL("https://x.example/"))).toBeNull();
  });
});

describe("LinkPreviews", () => {
  const html = (body: string): FetchedPage => ({ status: 200, contentType: "text/html; charset=utf-8", body });

  it("fetches a public page once and keeps the answer for an hour", async () => {
    const fetchPage = vi.fn(async () => html(PAGE));
    let now = 0;
    const previews = new LinkPreviews({ lookup: publicHost, fetchPage, now: () => now });
    expect(await previews.preview("https://bluebottlecoffee.com/cafes")).toMatchObject({ url: "https://bluebottlecoffee.com/cafes", title: "Blue Bottle & Friends" });
    expect(await previews.preview("https://bluebottlecoffee.com/cafes#again")).toMatchObject({ title: "Blue Bottle & Friends" });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    now = 61 * 60 * 1000;
    await previews.preview("https://bluebottlecoffee.com/cafes");
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("never connects to a name that resolves to a private address", async () => {
    const fetchPage = vi.fn(async () => html(PAGE));
    const lookup = async (): Promise<LookupAddress[]> => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
    expect(await new LinkPreviews({ lookup, fetchPage }).preview("https://rebinding.example/")).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("follows https redirects, checking each new address, and stops at anything else", async () => {
    const pages: Record<string, FetchedPage> = {
      "https://short.example/a": { status: 301, location: "https://long.example/article", body: "" },
      "https://long.example/article": html(PAGE),
      "https://short.example/b": { status: 302, location: "http://long.example/article", body: "" },
      "https://short.example/c": { status: 302, location: "https://inside.example/", body: "" },
    };
    const fetchPage = vi.fn(async (url: URL) => pages[url.toString()] ?? { status: 404, body: "" });
    const lookup = async (host: string): Promise<LookupAddress[]> => [{ address: host === "inside.example" ? "192.168.1.2" : "93.184.216.34", family: 4 }];
    const previews = new LinkPreviews({ lookup, fetchPage });
    expect(await previews.preview("https://short.example/a")).toMatchObject({ url: "https://short.example/a", title: "Blue Bottle & Friends" });
    expect(await previews.preview("https://short.example/b")).toBeNull();
    expect(await previews.preview("https://short.example/c")).toBeNull();
    expect(fetchPage.mock.calls.map(([url]) => String(url))).not.toContain("https://inside.example/");
  });

  it("answers nothing for pages that fail or aren't web pages", async () => {
    const fetchPage = vi.fn(async (url: URL) => url.pathname === "/pdf" ? { status: 200, contentType: "application/pdf", body: "" } : { status: 500, body: "" });
    const previews = new LinkPreviews({ lookup: publicHost, fetchPage });
    expect(await previews.preview("https://files.example/pdf")).toBeNull();
    expect(await previews.preview("https://files.example/broken")).toBeNull();
  });
});
