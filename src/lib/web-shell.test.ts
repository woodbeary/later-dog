import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const file = (path: string) => new URL(`../../${path}`, import.meta.url);
const text = (path: string) => readFileSync(file(path), "utf8");
const index = text("index.html");
const css = text("src/styles.css");

function pngSize(path: string): [number, number] {
  const bytes = readFileSync(file(path));
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function meta(name: string): string[] {
  return [...index.matchAll(new RegExp(`<meta\\s+name="${name}"[^>]*>`, "g"))].map(([tag]) => tag);
}

describe("the page's head, for Safari on iPhone, iPad and Mac", () => {
  it("fills the screen and keeps the controls out from under the notch and home bar", () => {
    expect(meta("viewport")[0]).toContain("viewport-fit=cover");
    expect(meta("viewport")[0]).not.toMatch(/maximum-scale|user-scalable/);
    expect(css).toMatch(/\.safe-area-frame\s*\{[^}]*env\(safe-area-inset-bottom\)/);
    expect(text("src/App.tsx")).toContain('className="safe-area-frame flex h-full flex-col"');
  });

  it("tints the browser bar for light and dark, and names the home-screen icon", () => {
    expect(meta("theme-color").map((tag) => /media="\(prefers-color-scheme: (light|dark)\)"/.exec(tag)?.[1])).toEqual(["light", "dark"]);
    expect(meta("apple-mobile-web-app-title")[0]).toContain('content="later.dog"');
    expect(meta("apple-mobile-web-app-capable")[0]).toContain('content="yes"');
  });

  it("points at a 180 pixel touch icon and a standalone manifest whose icons exist", () => {
    expect(index).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(pngSize("public/apple-touch-icon.png")).toEqual([180, 180]);
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    const manifest = JSON.parse(text("public/manifest.webmanifest"));
    expect(manifest).toMatchObject({ name: "later.dog", display: "standalone", start_url: "/", scope: "/" });
    for (const icon of manifest.icons as { src: string; sizes: string }[]) {
      const side = Number(icon.sizes.split("x")[0]);
      expect(pngSize(`public${icon.src}`), icon.src).toEqual([side, side]);
    }
  });
});

describe("the stylesheet's Safari touches", () => {
  it("stops text inflating, the tap flash, double-tap zoom and rubber-banding the whole page", () => {
    expect(css).toMatch(/-webkit-text-size-adjust:\s*100%/);
    expect(css).toMatch(/text-size-adjust:\s*100%/);
    expect(css).toMatch(/-webkit-tap-highlight-color:\s*transparent/);
    expect(css).toMatch(/touch-action:\s*manipulation/);
    expect(css).toMatch(/html,\s*body\s*\{\s*overscroll-behavior:\s*none/);
    expect(text("src/components/ChatView.tsx")).toContain("glass-scroller h-full overflow-x-hidden overflow-y-auto overscroll-y-contain");
  });

  it("keeps every field at 16px on iOS, with the composer's mirror matching its textarea, so focusing never zooms", () => {
    const ios = /@supports \(-webkit-touch-callout: none\) \{([\s\S]*?)\n\}\n/.exec(css)?.[1] ?? "";
    expect(ios).toMatch(/input:not\(\[type="checkbox"\], \[type="radio"\], \[type="range"\], \[data-keep-size\]\),\s*select,\s*textarea,\s*\.mention-editor-mirror\s*\{\s*font-size:\s*16px;/);
    expect(text("src/components/CloudSignInForm.tsx")).toContain("data-keep-size");
    expect(ios).toMatch(/\.mention-editor textarea,\s*\.mention-editor-mirror\s*\{\s*line-height:\s*22px;/);
    expect(ios).toMatch(/color-scheme:\s*var\(--code-color-scheme\)/);
  });
});

describe("the sign-in fields", () => {
  it("ask for the emailed code and the saved email the way iOS expects", () => {
    for (const path of ["src/pair/PairPage.tsx", "src/components/CloudSignInForm.tsx"]) {
      const source = text(path);
      expect(source, path).toContain('autoComplete="one-time-code"');
      expect(source, path).toContain('autoComplete="email webauthn"');
      expect(source, path).toContain('autoCapitalize="none"');
    }
  });
});
