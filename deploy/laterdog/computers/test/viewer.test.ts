import { describe, expect, it } from "vitest";
import { escapeHtml, messagePage, newNonce, pageHeaders, viewerPage } from "../src/viewer";

describe("viewer page", () => {
  const nonce = "abc123";
  const html = viewerPage({ name: `Rex <img src=x onerror=alert(1)> "&"`, expiresAtMs: 1_800_007_200_000, nonce });

  it("loads noVNC by relative URL so it stays under the signed path", () => {
    expect(html).toContain('import RFB from "./core/rfb.js";');
    expect(html).toContain('new URL("websockify", location.href)');
    expect(html).toContain('fetch("status"');
    expect(html).not.toMatch(/src="\//);
  });

  it("escapes the computer's name", () => {
    expect(html).not.toContain("<img");
    expect(html).toContain("Rex &#60;img src=x onerror=alert(1)&#62; &#34;&#38;&#34;");
  });

  it("tags its inline script and style with the nonce", () => {
    expect(html).toContain(`<script type="module" nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
  });

  it("starts in watch mode and stops reconnecting at expiry", () => {
    expect(html).toContain("rfb.viewOnly = !controlling;");
    expect(html).toContain("let controlling = false;");
    expect(html).toContain("const EXPIRES_AT = 1800007200000;");
  });
});

describe("page headers", () => {
  it("allow only same-origin scripts, the nonce and this host's WebSocket", () => {
    const headers = pageHeaders(new URL("https://computers.example.dev/desktop/x/y/"), "n0nce");
    expect(headers["content-security-policy"]).toContain("script-src 'self' 'nonce-n0nce'");
    expect(headers["content-security-policy"]).toContain("connect-src 'self' wss://computers.example.dev");
    expect(headers["content-security-policy"]).toContain("default-src 'none'");
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
});
