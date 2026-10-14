import { describe, expect, it } from "vitest";
import { escapeHtml, messagePage, newNonce, pageHeaders, viewerPage } from "../src/viewer";

describe("viewer page", () => {
  const nonce = "abc123";
  const html = viewerPage({ name: `Rex <img src=x onerror=alert(1)> "&"`, expiresAtMs: 1_800_007_200_000, nonce });

  it("loads noVNC from the versioned, token-free static path and keeps the socket and status under the signed path", () => {
    expect(html).toContain('import RFB from "/novnc/1.6.0/core/rfb.js";');
    expect(html).toContain('new URL("websockify", location.href)');
    expect(html).toContain('fetch("status"');
    expect(html).not.toContain("./core/");
    expect(html).not.toMatch(/src="\//);
  });

  it("preloads every noVNC module in one go so the import chain is not fetched level by level", () => {
    const links = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((match) => match[1]);
    expect(links).toHaveLength(52);
    expect(links).toContain("/novnc/1.6.0/core/rfb.js");
    expect(links).toContain("/novnc/1.6.0/vendor/pako/lib/zlib/inflate.js");
    expect(new Set(links).size).toBe(links.length);
  });

  it("escapes the computer's name", () => {
    expect(html).not.toContain("<img");
    expect(html).toContain("Rex &#60;img src=x onerror=alert(1)&#62; &#34;&#38;&#34;");
  });

  it("tags its inline script and style with the nonce", () => {
    expect(html).toContain(`<script type="module" nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it("takes the mouse and keyboard from the first frame and stops reconnecting at expiry", () => {
    expect(html).toContain("rfb.viewOnly = false;");
    expect(html).not.toContain("Take over");
    expect(html).toContain("const EXPIRES_AT = 1800007200000;");
  });
});

describe("page headers", () => {
  it("allow only same-origin scripts, the nonce and this host's WebSocket", () => {
    const headers = pageHeaders(new URL("https://computers.example.dev/desktop/x/y/"), "n0nce");
    expect(headers["content-security-policy"]).toContain("script-src 'self' 'nonce-n0nce'");
    expect(headers["content-security-policy"]).toContain("connect-src 'self' wss://computers.example.dev");
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["cache-control"]).toBe("no-store");
  });
  it("use ws: for local development over http", () => {
    expect(pageHeaders(new URL("http://localhost:8787/desktop/x/y/"), "n")["content-security-policy"]).toContain("connect-src 'self' ws://localhost:8787");
  });
});

describe("helpers", () => {
  it("escape every HTML-significant character", () => {
    expect(escapeHtml(`<a href='x'>&"`)).toBe("&#60;a href=&#39;x&#39;&#62;&#38;&#34;");
  });
  it("make fresh 128-bit nonces", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
  it("render message pages escaped", () => {
    expect(messagePage({ title: "Link <ended>", message: "Open it again.", nonce: "n" })).toContain("Link &#60;ended&#62;");
  });

  it("offers to open the app and opens it once, under the page's nonce", () => {
    const page = messagePage({ title: "Started", message: "Done.", nonce: "n", openApp: { href: "laterdog://trial", label: "Open later.dog" } });
    expect(page).toContain('<a href="laterdog://trial">Open later.dog</a>');
    expect(page).toContain('<script nonce="n">window.setTimeout(() => { location.href = "laterdog://trial"; }, 400);</script>');
    expect(messagePage({ title: "Started", message: "Done.", nonce: "n" })).not.toContain("<script");
  });
});
