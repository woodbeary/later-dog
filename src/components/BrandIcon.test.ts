import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BRAND_INK, BRAND_MARKS, markColor } from "@/lib/brand-icons";
import { MCP_CONNECTORS } from "@/lib/mcp-connectors";
import { BrandIcon } from "./BrandIcon";
import { ConnectorCard } from "./ConnectorCard";

const draw = (props: Parameters<typeof BrandIcon>[0]) => renderToStaticMarkup(createElement(BrandIcon, props));

describe("BrandIcon", () => {
  it("draws every catalog connector's mark as an svg of its path, in its colour", () => {
    for (const connector of MCP_CONNECTORS) {
      const mark = BRAND_MARKS[connector.id];
      const html = draw({ brand: connector.id, name: connector.name });
      expect(html, connector.id).toContain('<svg viewBox="0 0 24 24"');
      expect(html, connector.id).toContain(`<path d="${mark.path}"></path>`);
      expect(html, connector.id).toContain(`fill="${markColor(mark)}"`);
    }
  });

  it("sizes the tile and the mark inside it: white, rounded, with a hairline edge", () => {
    const html = draw({ brand: "linear", name: "Linear" });
    expect(html).toContain("width:40px;height:40px;border-radius:12px;background-color:#ffffff");
    expect(html).toContain('width="22" height="22" fill="#5E6AD2"');
    expect(html).toContain("ring-1 ring-inset ring-black/10");
    const large = draw({ brand: "linear", name: "Linear", size: 44 });
    expect(large).toContain("width:44px;height:44px;border-radius:13px");
    expect(large).toContain('width="24" height="24"');
  });

  it("names the brand, or stays silent when its name sits beside it", () => {
    expect(draw({ brand: "stripe", name: "Stripe" })).toContain('role="img" aria-label="Stripe"');
    const decorative = draw({ brand: "stripe", name: "Stripe", decorative: true });
    expect(decorative).toContain('data-brand-icon="stripe" aria-hidden="true"');
    expect(decorative).not.toContain("role=");
    expect(decorative).not.toContain("aria-label");
  });

  it("draws Intercom's pale mark in black, and an unknown brand as its initial on the same tile", () => {
    expect(draw({ brand: "intercom", name: "Intercom" })).toContain(`fill="${BRAND_INK}"`);
    const unknown = draw({ brand: "gmail", name: "Gmail" });
    expect(unknown).not.toContain("<svg");
    expect(unknown).toContain('role="img" aria-label="Gmail"');
    expect(unknown).toContain("background-color:#ffffff");
    expect(unknown).toMatch(/>G<\/span><\/span>$/);
  });
});

describe("the in-chat connector card", () => {
  const card = (slug: string, label: string) => renderToStaticMarkup(createElement(ConnectorCard, {
    botId: "atlas",
    threadId: "thread",
    message: {
      id: "m1",
      role: "bot",
      kind: "connector",
      at: 1,
      connector: { slug, label, description: "Read things", status: "required", resumeKey: "resume1" },
    },
  }));

  it("shows the brand's mark for a service the catalog has one for", () => {
    const html = card("notion", "Notion");
    expect(html).toContain('data-brand-icon="notion" aria-hidden="true"');
    expect(html).toContain(`<path d="${BRAND_MARKS.notion.path}"></path>`);
  });

  it("keeps the lettered tile for any other service", () => {
    const html = card("gmail", "Gmail");
    expect(html).not.toContain("data-brand-icon");
    expect(html).toContain(">G</div>");
  });
});
