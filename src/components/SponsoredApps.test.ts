import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.hoisted(() => vi.fn(async (_url: string) => {}));
vi.mock("@/lib/app-links", () => ({ openExternalLink: open }));
import { sponsorSlot, type SponsorSlot } from "@/lib/sponsors";
import { SponsoredApps } from "./SponsoredApps";

type Node = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;
function nodes(value: ReactNode): Node[] {
  return Children.toArray(value).flatMap((child) => {
    if (!isValidElement(child)) return [];
    const node = child as Node;
    return [node, ...nodes(node.props.children)];
  });
}
function render(slot?: SponsorSlot) {
  let tree: ReactNode = null;
  function Capture() {
    tree = SponsoredApps(slot ? { slot } : {});
    return tree;
  }
  const html = renderToStaticMarkup(createElement(Capture));
  return { html, links: nodes(tree).filter((node) => node.type === "a") };
}
const click = (link: Node, desktop: boolean) => {
  const event = { preventDefault: vi.fn() };
  vi.stubGlobal("window", desktop ? { laterdog: { openExternal: vi.fn() } } : {});
  (link.props.onClick as (event: { preventDefault: () => void }) => void)(event);
  return event.preventDefault;
};

beforeEach(() => {
  open.mockReset();
  vi.stubGlobal("window", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("Sponsored in Apps", () => {
  it("draws nothing while there are no sponsors and no sponsor page", () => {
    expect(render().html).toBe("");
    expect(render({ kind: "none" }).html).toBe("");
  });

  it("shows one quiet card inviting a sponsor once the sponsor page exists", () => {
    const { html, links } = render(sponsorSlot([], "https://later.dog/sponsor"));
    expect(html).toContain('data-apps-sponsored="open"');
    expect(html).toContain('aria-label="Sponsored"');
    expect(html).toContain("Your card here — sponsor this spot");
    expect(html).toContain("border-dashed");
    expect(links.map((link) => link.props.href)).toEqual(["https://later.dog/sponsor"]);
    expect(links[0]!.props.rel).toBe("noopener noreferrer");
    expect(click(links[0]!, true)).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("https://later.dog/sponsor");
  });

  it("labels each sponsor's card Sponsored, opens it in the browser, and adds a small sponsor link", () => {
    const { html, links } = render(sponsorSlot([
      { name: "Acme", tagline: "Ships your dogs' work.", url: "https://acme.example/later-dog", color: "#0a7" },
      { name: "Globex", tagline: "Hosting for dogs.", url: "https://globex.example", icon: "/sponsors/globex.png" },
    ], "https://later.dog/sponsor"));
    expect(html).toContain('data-apps-sponsored="sponsors"');
    expect(html).toContain('data-sponsor="Acme"');
    expect(html).toContain('data-sponsor="Globex"');
    expect(html.match(/>Sponsored</g)).toHaveLength(2);
    expect(html).toContain("Ships your dogs&#x27; work.");
    expect(html).toContain('src="/sponsors/globex.png"');
    expect(html).not.toContain("Your card here");
    expect(links.map((link) => link.props.href)).toEqual(["https://acme.example/later-dog", "https://globex.example/", "https://later.dog/sponsor"]);
    expect(links.map((link) => link.props.target)).toEqual(["_blank", "_blank", "_blank"]);
    expect(html).toContain(">Sponsor this spot</a>");

    expect(click(links[0]!, false)).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(click(links[0]!, true)).toHaveBeenCalled();
    expect(open).toHaveBeenLastCalledWith("https://acme.example/later-dog");
  });

  it("leaves out the sponsor link when there is no page to send people to", () => {
    const { html, links } = render(sponsorSlot([{ name: "Acme", tagline: "", url: "https://acme.example" }], null));
    expect(html).toContain('data-sponsor="Acme"');
    expect(html).not.toContain("Sponsor this spot");
    expect(html).not.toContain("data-sponsor-link");
    expect(links.map((link) => link.props.href)).toEqual(["https://acme.example/"]);
  });
});
