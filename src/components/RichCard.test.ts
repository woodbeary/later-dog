import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { richCard } from "@/lib/rich-cards";
import { RichCard } from "./RichCard";

const show = (lang: string, value: unknown) => renderToStaticMarkup(createElement(RichCard, { card: richCard(lang, JSON.stringify(value))! }));

describe("cards in a reply", () => {
  it("shows a place with directions in both map apps", () => {
    const html = show("place", { name: "Blue Bottle", address: "300 Webster St, Oakland" });
    expect(html).toContain("Blue Bottle");
    expect(html).toContain("300 Webster St, Oakland");
    expect(html).toContain('href="https://maps.apple.com/?daddr=300%20Webster%20St%2C%20Oakland&amp;q=Blue%20Bottle"');
    expect(html).toContain("Google Maps");
  });

  it("shows a product's price and store, and a Buy link only when there is one", () => {
    const html = show("product", { name: "Kettle", price: "$39.99", store: "Target", url: "https://target.com/k", image: "https://img.example/k.png" });
    expect(html).toContain("$39.99 · Target");
    expect(html).toContain('href="https://target.com/k"');
    expect(html).toContain('src="https://img.example/k.png"');
    expect(show("product", { name: "Kettle" })).not.toContain("Buy");
  });

  it("shows the weather now and each day", () => {
    const html = show("weather", { place: "Oakland", unit: "F", now: { temp: 64, condition: "Partly cloudy" }, days: [{ day: "Fri", high: 70, low: 55, condition: "Sunny" }, { day: "Sat", high: 66, low: 54, condition: "Rain" }] });
    for (const shown of ["Oakland", "64°F", "Partly cloudy", "Fri", "70°F", "55°F", "Sat", "66°F"]) expect(html).toContain(shown);
  });
});
