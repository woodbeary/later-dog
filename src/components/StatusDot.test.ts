import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusDot } from "./StatusDot";

const draw = (kind: Parameters<typeof StatusDot>[0]["kind"], announce?: boolean) =>
  renderToStaticMarkup(createElement(StatusDot, { kind, announce }));

describe("StatusDot", () => {
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
