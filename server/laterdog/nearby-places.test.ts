import { describe, expect, it, vi } from "vitest";

import {
  distanceMeters,
  mapLink,
  NEARBY_SOURCE,
  nearbyPlaces,
  NearbyPlacesError,
  overpassQuery,
  placeFilters,
  placesFrom,
  searchBox,
  type LookupFetch,
} from "./nearby-places.ts";

const HOME = { latitude: 37.7749, longitude: -122.4194 };

const answer = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const CAFES = {
  elements: [
    { type: "node", lat: 37.7768, lon: -122.4194, tags: { amenity: "cafe", name: "Far Beans", opening_hours: "Mo-Fr 07:00-15:00" } },
    { type: "way", center: { lat: 37.7752, lon: -122.4194 }, tags: { amenity: "cafe", name: "Near Cup", "addr:housenumber": "12", "addr:street": "Market St", "addr:city": "San Francisco", phone: "+1 415 555 0100", website: "https://near.example" } },
    { type: "node", lat: 37.7750, lon: -122.4190, tags: { amenity: "cafe" } },
    { type: "node", lat: 37.7752, lon: -122.4194, tags: { amenity: "cafe", name: "Near Cup" } },
    { type: "node", lat: 37.776, lon: -122.42, tags: { amenity: "cafe", name: "Odd\u0007Name", website: "javascript:alert(1)" } },
  ],
};

describe("what to look for", () => {
  it.each([
    ["coffee", "amenity", "^cafe$"],
    ["a gas station", "amenity", "^fuel$"],
    ["EV charger", "amenity", "^charging_station$"],
    ["pharmacy", "amenity", "^pharmacy$"],
    ["grocery store", "shop", "^(supermarket|grocery|greengrocer)$"],
    ["urgent care", "amenity", "^(clinic|doctors)$"],
  ])("knows %s as a kind of place", (what, key, pattern) => {
    expect(placeFilters(what)?.[0]).toEqual([key, pattern]);
  });

  it("looks for anything else by its name", () => {
    expect(placeFilters("Trader Joe's")).toBeNull();
    expect(placeFilters("Philz Coffee")).toEqual([["amenity", "^cafe$"]]);
  });

  it("asks for every matching place around the point, with centers for buildings", () => {
    expect(overpassQuery([["amenity", "^cafe$"]], 37.7749, -122.4194, 1500, 8))
      .toBe('[out:json][timeout:30];(nwr["amenity"="cafe"](around:1500,37.774900,-122.419400););out center tags 48;');
    expect(overpassQuery([["amenity", "^(clinic|doctors)$"], ["healthcare", "^(clinic|doctor)$"]], 1, 2, 500, 2))
      .toBe('[out:json][timeout:30];(nwr["amenity"~"^(clinic|doctors)$"](around:500,1.000000,2.000000);nwr["healthcare"~"^(clinic|doctor)$"](around:500,1.000000,2.000000););out center tags 12;');
  });
});

describe("the places it answers with", () => {
  it("lists named places closest first, once each, with what is known about them", () => {
    const places = placesFrom(CAFES, HOME, 8);
    expect(places.map((place) => place.name)).toEqual(["Near Cup", "Odd Name", "Far Beans"]);
    expect(places[0]).toEqual({
      name: "Near Cup",
      kind: "cafe",
      distance_m: 33,
      address: "12 Market St, San Francisco",
      phone: "+1 415 555 0100",
      website: "https://near.example",
      map: mapLink("Near Cup", 37.7752, -122.4194),
    });
    expect(places[1]).not.toHaveProperty("website");
    expect(places[2]).toMatchObject({ opening_hours: "Mo-Fr 07:00-15:00" });
    expect(placesFrom(CAFES, HOME, 1)).toHaveLength(1);
    expect(placesFrom({ nope: true }, HOME, 8)).toEqual([]);
  });

  it("measures distance along the earth and links to Apple Maps at the place", () => {
    expect(distanceMeters(HOME, { latitude: 37.7849, longitude: -122.4194 })).toBe(1112);
    expect(mapLink("Near Cup & Co", 37.7752, -122.4194)).toBe("https://maps.apple.com/?q=Near%20Cup%20%26%20Co&ll=37.775200,-122.419400");
  });
});

describe("looking up places", () => {
  it("searches around the phone's point and names its source", async () => {
    const fetcher = vi.fn<LookupFetch>(async () => answer(CAFES));
    const found = await nearbyPlaces({ what: "coffee", latitude: HOME.latitude, longitude: HOME.longitude, limit: 2 }, { fetch: fetcher, overpassUrl: "https://places.test/api" });
    expect(found).toMatchObject({ center: HOME, radius_m: 1500, source: NEARBY_SOURCE });
    expect(found.places.map((place) => place.name)).toEqual(["Near Cup", "Odd Name"]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://places.test/api");
    expect(init).toMatchObject({ method: "POST", headers: { "user-agent": "later.dog (https://later.dog)", "content-type": "application/x-www-form-urlencoded" } });
    expect(decodeURIComponent(String(init.body).replace(/^data=/, ""))).toContain('nwr["amenity"="cafe"](around:1500,37.774900,-122.419400);');
  });

  it("finds an address first when asked near somewhere else", async () => {
    const fetcher = vi.fn<LookupFetch>(async (url) => url.startsWith("https://geo.test")
      ? answer([{ lat: "37.7752", lon: "-122.4194", display_name: "12 Market St, San Francisco" }])
      : answer(CAFES));
    const found = await nearbyPlaces({ what: "coffee", near: "12 Market St, San Francisco", radius_m: 500 }, { fetch: fetcher, geocodeUrl: "https://geo.test/search", overpassUrl: "https://places.test/api" });
    expect(fetcher.mock.calls[0]![0]).toBe("https://geo.test/search?format=jsonv2&limit=1&q=12%20Market%20St%2C%20San%20Francisco");
    expect(found.center).toEqual({ latitude: 37.7752, longitude: -122.4194, label: "12 Market St, San Francisco" });
    expect(found.radius_m).toBe(500);
    expect(found.places[0]).toMatchObject({ name: "Near Cup", distance_m: 0 });
  });

  it("searches by name within the area, closest first, and leaves out what lies beyond it", async () => {
    const fetcher = vi.fn<LookupFetch>(async () => answer([
      { lat: "37.7800", lon: "-122.4194", name: "Trader Joe's", type: "supermarket", address: { house_number: "555", road: "9th St", city: "San Francisco" } },
      { lat: "37.7760", lon: "-122.4194", name: "", display_name: "Trader Joe's, 10 Main St", type: "supermarket", address: { house_number: "10" } },
      { lat: "37.9000", lon: "-122.4194", name: "Trader Joe's", type: "supermarket" },
    ]));
    const found = await nearbyPlaces({ what: "Trader Joe's", latitude: HOME.latitude, longitude: HOME.longitude, radius_m: 1000 }, { fetch: fetcher, geocodeUrl: "https://geo.test/search" });
    const url = String(fetcher.mock.calls[0]![0]);
    expect(url).toContain("https://geo.test/search?format=jsonv2&addressdetails=1&bounded=1&limit=20&viewbox=");
    expect(url).toContain("&q=Trader%20Joe's");
    expect(found.places.map((place) => [place.name, place.distance_m, place.address ?? null, place.kind])).toEqual([
      ["Trader Joe's", 122, null, "supermarket"],
      ["Trader Joe's", 567, "555 9th St, San Francisco", "supermarket"],
    ]);
  });

  it("draws the search area around the point, wider east to west away from the equator", () => {
    const [west, north, east, south] = searchBox(HOME, 1000).split(",").map(Number);
    expect(north! - HOME.latitude).toBeCloseTo(0.008993, 5);
    expect(HOME.latitude - south!).toBeCloseTo(0.008993, 5);
    expect(east! - HOME.longitude).toBeCloseTo(0.011374, 4);
    expect(HOME.longitude - west!).toBeCloseTo(0.011374, 4);
  });

  it.each([
    [{ what: "coffee" }, "Say where"],
    [{ what: "coffee", latitude: 37.7 }, "Give latitude and longitude together."],
    [{ what: "coffee", near: "Market St", latitude: 1, longitude: 2 }, "not both"],
    [{ what: "coffee", latitude: 91, longitude: 0 }, ""],
    [{ what: "coffee", latitude: 1, longitude: 2, radius_m: 50_000 }, ""],
    [{ what: "coffee", latitude: 1, longitude: 2, extra: true }, ""],
  ])("refuses %j before looking anything up", async (input, words) => {
    const fetcher = vi.fn<LookupFetch>();
    const failure = await nearbyPlaces(input, { fetch: fetcher }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(NearbyPlacesError);
    expect((failure as NearbyPlacesError).status).toBe(400);
    expect((failure as NearbyPlacesError).message).toContain(words);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("says plainly when an address isn't found or the search is busy or down", async () => {
    const nowhere = nearbyPlaces({ what: "coffee", near: "Nowhere Lane" }, { fetch: async () => answer([]) });
    await expect(nowhere).rejects.toMatchObject({ status: 404, message: "Couldn't find Nowhere Lane. Try a fuller address." });
    const busy = nearbyPlaces({ what: "coffee", latitude: 1, longitude: 2 }, { fetch: async () => answer({}, 429) });
    await expect(busy).rejects.toMatchObject({ status: 503, message: "The places search is busy right now. Try again in a minute." });
    const down = nearbyPlaces({ what: "coffee", latitude: 1, longitude: 2 }, { fetch: async () => { throw new Error("offline"); } });
    await expect(down).rejects.toMatchObject({ status: 502, message: "The places search didn't answer. Try again in a minute." });
  });
});
