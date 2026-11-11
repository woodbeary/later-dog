import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusDot } from "./StatusDot";

const draw = (kind: Parameters<typeof StatusDot>[0]["kind"], announce?: boolean) =>
  renderToStaticMarkup(createElement(StatusDot, { kind, announce }));

const calm = readFileSync(new URL("../chat-calm.css", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

describe("StatusDot", () => {
  it("appears with a short entrance that ends at the dot's own look and is not held afterwards, so a shown dot is not kept on a layer of its own", () => {
    expect(calm).toMatch(/\.status-dot \{\s*animation: dot-in var\(--dur-150\) var\(--ease-calm\) backwards;/);
    expect(styles).toMatch(/@keyframes dot-in \{\s*from \{ transform: scale\(0\.5\); opacity: 0; \}\s*to \{ transform: none; opacity: 1; \}\s*\}/);
    expect(draw("unread")).not.toMatch(/opacity|scale|rotate|translate/);
  });

  it("draws nothing when there is nothing to ask of you", () => {
    expect(draw(null)).toBe("");
  });

  it("is orange and announced while the dog waits on you", () => {
    const waiting = draw("waiting");
    expect(waiting).toContain('data-testid="waiting-dot"');
    expect(waiting).toContain("bg-waiting");
    expect(waiting).toContain('role="status"');
  });

  it("is a quiet blue dot for unread, announced only when asked", () => {
    const quiet = draw("unread");
    expect(quiet).toContain('data-testid="unread-dot"');
    expect(quiet).toContain("bg-unread");
    expect(quiet).toContain('role="img"');
    expect(quiet).toContain('aria-label="Unread"');
    expect(draw("unread", true)).toContain('role="status"');
  });

  it("never uses the accent, success or warning colours, which vary by skin", () => {
    for (const kind of ["waiting", "unread"] as const) {
      expect(draw(kind)).not.toMatch(/bg-(accent|success|warning)\b/);
    }
  });

  it("adds a surface ring only where it sits over an avatar", () => {
    expect(draw("unread")).not.toContain("border-2");
    expect(renderToStaticMarkup(createElement(StatusDot, { kind: "unread", ring: "border-panel" }))).toContain("border-2 border-panel");
  });
});
