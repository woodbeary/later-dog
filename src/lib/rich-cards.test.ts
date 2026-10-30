import { describe, expect, it } from "vitest";
import { degrees, directions, mermaidCode, richCard, sky } from "./rich-cards";

describe("cards a dog writes into a reply", () => {
  it("reads a place by address or coordinates, and refuses one with neither", () => {
    expect(richCard("place", JSON.stringify({ name: "Blue Bottle", address: "300 Webster St, Oakland, CA" })))
      .toEqual({ kind: "place", name: "Blue Bottle", address: "300 Webster St, Oakland, CA" });
    expect(richCard(" Place ", JSON.stringify({ name: "Trailhead", lat: "37.8", lon: -122.25 })))
      .toEqual({ kind: "place", name: "Trailhead", lat: 37.8, lon: -122.25 });
    expect(richCard("place", JSON.stringify({ name: "Nowhere" }))).toBeNull();
    expect(richCard("place", JSON.stringify({ name: "Bad", lat: 200, lon: 0 }))).toBeNull();
  });

  it("reads a product, keeping only web links", () => {
    expect(richCard("product", JSON.stringify({ name: "Kettle", price: 39.99, store: "Target", url: "https://target.com/k", image: "javascript:alert(1)" })))
      .toEqual({ kind: "product", name: "Kettle", price: "39.99", store: "Target", url: "https://target.com/k" });
    expect(richCard("product", JSON.stringify({ price: "$5" }))).toBeNull();
  });

  it("reads the weather now and by day, in the unit given", () => {
    expect(richCard("weather", JSON.stringify({ place: "Oakland", unit: "c", now: { temp: "18°C", condition: "Partly cloudy" }, days: [{ day: "Fri", high: 21, low: 12, condition: "Sunny" }, { high: 3 }] })))
      .toEqual({ kind: "weather", place: "Oakland", unit: "C", now: { temp: 18, condition: "Partly cloudy" }, days: [{ day: "Fri", high: 21, low: 12, condition: "Sunny" }] });
    expect(richCard("weather", JSON.stringify({ place: "Oakland" }))).toBeNull();
  });

  it("leaves other code blocks and broken JSON as code", () => {
    expect(richCard("json", "{}")).toBeNull();
    expect(richCard("place", "{ not json")).toBeNull();
    expect(richCard("weather", "[1, 2]")).toBeNull();
  });

  it("opens directions in Apple Maps and Google Maps", () => {
    expect(directions({ kind: "place", name: "Blue Bottle", address: "300 Webster St" })).toEqual({
      apple: "https://maps.apple.com/?daddr=300%20Webster%20St&q=Blue%20Bottle",
      google: "https://www.google.com/maps/dir/?api=1&destination=300%20Webster%20St",
    });
    expect(directions({ kind: "place", name: "Trailhead", lat: 37.8, lon: -122.25 }).google).toBe("https://www.google.com/maps/dir/?api=1&destination=37.8%2C-122.25");
    expect(directions({ kind: "place", name: "Blue Bottle", address: "300 Webster St", lat: 1, lon: 2 }).google).toBe("https://www.google.com/maps/dir/?api=1&destination=300%20Webster%20St");
  });

  it("picks a sky for each condition and shows temperatures rounded", () => {
    expect(["Sunny", "Partly cloudy", "Overcast", "Light rain", "Thunderstorms", "Snow showers", "Fog", "Windy"].map(sky))
      .toEqual(["sun", "partly", "cloud", "rain", "storm", "snow", "fog", "wind"]);
    expect(degrees(71.6, "F")).toBe("72°F");
    expect(degrees(undefined, "C")).toBe("–");
  });

  it("draws a diagram whose block is named after its type, as models often write it", () => {
    expect(mermaidCode("mermaid", "pie\n  \"A\": 1")).toBe("pie\n  \"A\": 1");
    expect(mermaidCode("xychart-beta", "title \"Steps\"\nbar [1, 2]")).toBe("xychart-beta\ntitle \"Steps\"\nbar [1, 2]");
    expect(mermaidCode("sequenceDiagram", "sequenceDiagram\n  A->>B: hi")).toBe("sequenceDiagram\n  A->>B: hi");
    expect(mermaidCode("flowchart", "%% note\nflowchart LR\n  A --> B")).toBe("%% note\nflowchart LR\n  A --> B");
    expect(mermaidCode("json", "{}")).toBeNull();
    expect(mermaidCode("", "pie")).toBeNull();
  });
});
