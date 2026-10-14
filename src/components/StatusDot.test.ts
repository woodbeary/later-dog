import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusDot } from "./StatusDot";

const draw = (kind: Parameters<typeof StatusDot>[0]["kind"], announce?: boolean) =>
  renderToStaticMarkup(createElement(StatusDot, { kind, ring: "border-panel", announce }));

describe("StatusDot", () => {
  it("draws nothing while the dog is idle", () => {
    expect(draw(null)).toBe("");
  });

  it("is one steady green dot for work, without a live-region announcement unless asked", () => {
    const quiet = draw("working");
    expect(quiet).toContain('data-testid="working-dot"');
    expect(quiet).toContain("bg-success");
    expect(quiet).not.toContain("role=");
    const loud = draw("working", true);
    expect(loud).toContain('role="status"');
    expect(loud).toContain('aria-label="Working"');
  });

  it("changes colour in place for waiting, teammates and queued", () => {
    expect(draw("waiting")).toContain("bg-warning");
    expect(draw("teammates")).toContain("bg-accent");
    expect(draw("queued")).toContain("bg-ink-secondary");
    expect(draw("waiting")).toContain('data-testid="waiting-dot"');
  });
});
