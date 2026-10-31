import { z } from "zod";

export const NEARBY_RADIUS_DEFAULT_M = 1_500;
export const NEARBY_RADIUS_MAX_M = 10_000;
export const NEARBY_LIMIT_DEFAULT = 8;
export const NEARBY_LIMIT_MAX = 20;
export const NEARBY_SOURCE = "Places from OpenStreetMap (© OpenStreetMap contributors).";
const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const USER_AGENT = "later.dog (https://later.dog)";
const LOOKUP_TIMEOUT_MS = 45_000;
const SEARCH_TIMEOUT_S = 30;
const EARTH_M = 6_371_000;

type Filter = readonly [key: string, pattern: string];

const KINDS: ReadonlyArray<{ words: RegExp; filters: readonly Filter[] }> = [
  { words: /\b(coffee|cafe|café|espresso)\b/i, filters: [["amenity", "^cafe$"]] },
  { words: /\b(fast food|burger|drive.?thru)\b/i, filters: [["amenity", "^fast_food$"]] },
  { words: /\b(restaurant|food|dinner|lunch|breakfast|brunch|eat)\b/i, filters: [["amenity", "^(restaurant|fast_food)$"]] },
  { words: /\b(bar|pub|brewery|drinks?)\b/i, filters: [["amenity", "^(bar|pub|biergarten)$"]] },
  { words: /\b(pharmacy|pharmacies|drugstore|chemist)\b/i, filters: [["amenity", "^pharmacy$"], ["shop", "^chemist$"]] },
  { words: /\b(ev|electric|charg(er|ing))\b/i, filters: [["amenity", "^charging_station$"]] },
  { words: /\b(gas|fuel|petrol)\b/i, filters: [["amenity", "^fuel$"]] },
  { words: /\batms?\b/i, filters: [["amenity", "^atm$"]] },
  { words: /\bbanks?\b/i, filters: [["amenity", "^bank$"]] },
  { words: /\b(hospital|emergency room|er)\b/i, filters: [["amenity", "^hospital$"]] },
  { words: /\b(urgent care|clinic|doctor)s?\b/i, filters: [["amenity", "^(clinic|doctors)$"], ["healthcare", "^(clinic|doctor)$"]] },
  { words: /\bparking\b/i, filters: [["amenity", "^parking$"]] },
  { words: /\b(grocery|groceries|supermarket|market)\b/i, filters: [["shop", "^(supermarket|grocery|greengrocer)$"]] },
  { words: /\b(convenience|corner store|bodega)\b/i, filters: [["shop", "^convenience$"]] },
  { words: /\b(hotel|motel|place to stay)s?\b/i, filters: [["tourism", "^(hotel|motel|guest_house)$"]] },
  { words: /\b(gym|fitness)\b/i, filters: [["leisure", "^fitness_centre$"]] },
  { words: /\bparks?\b/i, filters: [["leisure", "^park$"]] },
  { words: /\b(post office|mail)\b/i, filters: [["amenity", "^post_office$"]] },
  { words: /\blibrar(y|ies)\b/i, filters: [["amenity", "^library$"]] },
  { words: /\b(hardware|home improvement)\b/i, filters: [["shop", "^(hardware|doityourself)$"]] },
  { words: /\b(car wash)\b/i, filters: [["amenity", "^car_wash$"]] },
  { words: /\b(vet|veterinar(y|ian)|pet store)\b/i, filters: [["amenity", "^veterinary$"], ["shop", "^pet$"]] },
  { words: /\b(restroom|toilet|bathroom)s?\b/i, filters: [["amenity", "^toilets$"]] },
];

export const nearbyPlacesInput = z.object({
  what: z.string().trim().min(2).max(80),
  near: z.string().trim().min(3).max(200).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  radius_m: z.number().int().min(100).max(NEARBY_RADIUS_MAX_M).optional(),
  limit: z.number().int().min(1).max(NEARBY_LIMIT_MAX).optional(),
}).strict().superRefine((input, context) => {
  const point = input.latitude !== undefined || input.longitude !== undefined;
  if (point && (input.latitude === undefined || input.longitude === undefined)) {
    context.addIssue({ code: "custom", path: ["latitude"], message: "Give latitude and longitude together." });
  }
  if (!point && !input.near) context.addIssue({ code: "custom", path: ["near"], message: "Say where: latitude and longitude (read_phone what=location gives them), or near with an address or place." });
  if (point && input.near) context.addIssue({ code: "custom", path: ["near"], message: "Give either near or latitude and longitude, not both." });
});

export type NearbyPlacesInput = z.infer<typeof nearbyPlacesInput>;

export interface NearbyPlace {
  name: string;
  kind: string;
  distance_m: number;
  address?: string;
  opening_hours?: string;
  phone?: string;
  website?: string;
  map: string;
}

export interface NearbyPlacesAnswer {
  center: { latitude: number; longitude: number; label?: string };
  radius_m: number;
  places: NearbyPlace[];
  source: string;
}

export type LookupFetch = (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status" | "json">>;

export class NearbyPlacesError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const quoted = (value: string) => JSON.stringify(value);

export function placeFilters(what: string): readonly Filter[] | null {
  return KINDS.find((kind) => kind.words.test(what))?.filters ?? null;
}

function tagFilter([key, pattern]: Filter): string {
  const single = /^\^([a-z_]+)\$$/.exec(pattern);
  return single ? `[${quoted(key)}=${quoted(single[1]!)}]` : `[${quoted(key)}~${quoted(pattern)}]`;
}

export function overpassQuery(filters: readonly Filter[], latitude: number, longitude: number, radius: number, limit: number): string {
  const around = `(around:${radius},${latitude.toFixed(6)},${longitude.toFixed(6)})`;
  const parts = filters.map((filter) => `nwr${tagFilter(filter)}${around};`).join("");
  return `[out:json][timeout:${SEARCH_TIMEOUT_S}];(${parts});out center tags ${Math.min(limit * 6, 120)};`;
}

export function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const rad = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

function tagText(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = [...value].map((char) => {
    const code = char.codePointAt(0)!;
    return code < 0x20 || code === 0x7f ? " " : char;
  }).join("").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function addressOf(tags: Record<string, unknown>): string | undefined {
  const road = tagText(tags["addr:street"]);
  const street = road ? [tagText(tags["addr:housenumber"]), road].filter(Boolean).join(" ") : "";
  const line = [street, tagText(tags["addr:unit"]) ? `#${tagText(tags["addr:unit"])}` : "", tagText(tags["addr:city"])].filter(Boolean).join(", ");
  return line || tagText(tags["addr:full"]);
}

function kindOf(tags: Record<string, unknown>): string {
  for (const key of ["amenity", "shop", "tourism", "leisure", "healthcare", "cuisine"]) {
    const value = tagText(tags[key], 60);
    if (value) return value.replace(/_/g, " ");
  }
  return "place";
}

export function mapLink(name: string, latitude: number, longitude: number): string {
  return `https://maps.apple.com/?q=${encodeURIComponent(name)}&ll=${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}

export function placesFrom(raw: unknown, center: { latitude: number; longitude: number }, limit: number): NearbyPlace[] {
  const elements = raw && typeof raw === "object" && Array.isArray((raw as { elements?: unknown }).elements) ? (raw as { elements: unknown[] }).elements : [];
  const seen = new Set<string>();
  const places: NearbyPlace[] = [];
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const item = element as { lat?: unknown; lon?: unknown; center?: { lat?: unknown; lon?: unknown }; tags?: Record<string, unknown> };
    const latitude = typeof item.lat === "number" ? item.lat : item.center?.lat;
    const longitude = typeof item.lon === "number" ? item.lon : item.center?.lon;
    const tags = item.tags ?? {};
    const name = tagText(tags.name, 120);
    if (typeof latitude !== "number" || typeof longitude !== "number" || !name) continue;
    const key = `${name.toLowerCase()}@${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const address = addressOf(tags);
    const opening = tagText(tags.opening_hours, 120);
    const phone = tagText(tags.phone ?? tags["contact:phone"], 40);
    const website = tagText(tags.website ?? tags["contact:website"], 200);
    places.push({
      name,
      kind: kindOf(tags),
      distance_m: distanceMeters(center, { latitude, longitude }),
      ...(address ? { address } : {}),
      ...(opening ? { opening_hours: opening } : {}),
      ...(phone ? { phone } : {}),
      ...(website && /^https?:\/\//i.test(website) ? { website } : {}),
      map: mapLink(name, latitude, longitude),
    });
  }
  return places.sort((a, b) => a.distance_m - b.distance_m).slice(0, limit);
}

export function searchBox(center: { latitude: number; longitude: number }, radius: number): string {
  const dLat = (radius / EARTH_M) * (180 / Math.PI);
  const dLon = dLat / Math.max(Math.cos((center.latitude * Math.PI) / 180), 0.01);
  const edge = (value: number) => value.toFixed(6);
  return [edge(center.longitude - dLon), edge(center.latitude + dLat), edge(center.longitude + dLon), edge(center.latitude - dLat)].join(",");
}

export function namedPlacesFrom(raw: unknown, center: { latitude: number; longitude: number }, limit: number): NearbyPlace[] {
  const rows = Array.isArray(raw) ? raw : [];
  const places: NearbyPlace[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as { lat?: unknown; lon?: unknown; name?: unknown; type?: unknown; display_name?: unknown; address?: Record<string, unknown> };
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    const name = tagText(item.name, 120) ?? tagText(typeof item.display_name === "string" ? item.display_name.split(",")[0] : undefined, 120);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !name) continue;
    const address = item.address ?? {};
    const road = tagText(address.road);
    const line = [road ? [tagText(address.house_number), road].filter(Boolean).join(" ") : "", tagText(address.city ?? address.town ?? address.village)].filter(Boolean).join(", ");
    places.push({
      name,
      kind: tagText(item.type, 60)?.replace(/_/g, " ") ?? "place",
      distance_m: distanceMeters(center, { latitude, longitude }),
      ...(line ? { address: line } : {}),
      map: mapLink(name, latitude, longitude),
    });
  }
  return places.sort((a, b) => a.distance_m - b.distance_m).slice(0, limit);
}

async function lookup(fetcher: LookupFetch, url: string, init: RequestInit, what: string): Promise<unknown> {
  let response: Awaited<ReturnType<LookupFetch>>;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), headers: { "user-agent": USER_AGENT, accept: "application/json", ...(init.headers as Record<string, string> | undefined) } });
  } catch {
    throw new NearbyPlacesError(`The ${what} didn't answer. Try again in a minute.`, 502);
  }
  if (response.status === 429 || response.status === 504) throw new NearbyPlacesError(`The ${what} is busy right now. Try again in a minute.`, 503);
  if (!response.ok) throw new NearbyPlacesError(`The ${what} answered ${response.status}. Try again in a minute.`, 502);
  try {
    return await response.json();
  } catch {
    throw new NearbyPlacesError(`The ${what} sent something unreadable. Try again in a minute.`, 502);
  }
}

export async function nearbyPlaces(raw: unknown, options: { fetch: LookupFetch; overpassUrl?: string; geocodeUrl?: string }): Promise<NearbyPlacesAnswer> {
  const parsed = nearbyPlacesInput.safeParse(raw);
  if (!parsed.success) throw new NearbyPlacesError(parsed.error.issues[0]?.message ?? "Say what to look for and where.", 400);
  const input = parsed.data;
  let center: NearbyPlacesAnswer["center"];
  if (input.near) {
    const found = await lookup(options.fetch, `${options.geocodeUrl ?? NOMINATIM_URL}?format=jsonv2&limit=1&q=${encodeURIComponent(input.near)}`, { method: "GET" }, "address search");
    const first = Array.isArray(found) ? found[0] as { lat?: unknown; lon?: unknown; display_name?: unknown } | undefined : undefined;
    const latitude = Number(first?.lat);
    const longitude = Number(first?.lon);
    if (!first || !Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new NearbyPlacesError(`Couldn't find ${input.near}. Try a fuller address.`, 404);
    center = { latitude, longitude, ...(tagText(first.display_name) ? { label: tagText(first.display_name) } : {}) };
  } else {
    center = { latitude: input.latitude!, longitude: input.longitude! };
  }
  const radius = input.radius_m ?? NEARBY_RADIUS_DEFAULT_M;
  const limit = input.limit ?? NEARBY_LIMIT_DEFAULT;
  const filters = placeFilters(input.what);
  if (!filters) {
    const named = await lookup(options.fetch, `${options.geocodeUrl ?? NOMINATIM_URL}?format=jsonv2&addressdetails=1&bounded=1&limit=${NEARBY_LIMIT_MAX}&viewbox=${searchBox(center, radius)}&q=${encodeURIComponent(input.what)}`, { method: "GET" }, "places search");
    return { center, radius_m: radius, places: namedPlacesFrom(named, center, limit).filter((place) => place.distance_m <= radius), source: NEARBY_SOURCE };
  }
  const query = overpassQuery(filters, center.latitude, center.longitude, radius, limit);
  const found = await lookup(options.fetch, options.overpassUrl ?? OVERPASS_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
  }, "places search");
  return { center, radius_m: radius, places: placesFrom(found, center, limit), source: NEARBY_SOURCE };
}
