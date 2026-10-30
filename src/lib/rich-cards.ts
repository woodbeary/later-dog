export interface PlaceCard {
  kind: "place";
  name: string;
  address?: string;
  lat?: number;
  lon?: number;
}

export interface ProductCard {
  kind: "product";
  name: string;
  price?: string;
  store?: string;
  url?: string;
  image?: string;
}

export interface WeatherDay {
  day: string;
  high?: number;
  low?: number;
  condition?: string;
}

export interface WeatherCard {
  kind: "weather";
  place: string;
  unit: "F" | "C";
  now?: { temp: number; condition?: string };
  days: WeatherDay[];
}

export type RichCard = PlaceCard | ProductCard | WeatherCard;
export type Sky = "sun" | "partly" | "cloud" | "rain" | "storm" | "snow" | "fog" | "wind";

const MAX_DAYS = 10;

function words(value: unknown, max = 200): string | undefined {
  if (typeof value !== "string") return undefined;
  const flat = value.replace(/\s+/g, " ").trim();
  return flat ? flat.slice(0, max) : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value.trim().replace(/°[CF]?$/i, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function webAddress(value: unknown): string | undefined {
  const raw = words(value, 2000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function object(source: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(source);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function place(data: Record<string, unknown>): PlaceCard | null {
  const name = words(data.name);
  const address = words(data.address, 300);
  const lat = numeric(data.lat);
  const lon = numeric(data.lon);
  const located = lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  if (!name || (!address && !located)) return null;
  return { kind: "place", name, ...(address ? { address } : {}), ...(located ? { lat, lon } : {}) };
}

function product(data: Record<string, unknown>): ProductCard | null {
  const name = words(data.name);
  if (!name) return null;
  const price = words(data.price, 40) ?? (numeric(data.price) !== undefined ? String(numeric(data.price)) : undefined);
  const store = words(data.store, 80);
  const url = webAddress(data.url);
  const image = webAddress(data.image);
  return { kind: "product", name, ...(price ? { price } : {}), ...(store ? { store } : {}), ...(url ? { url } : {}), ...(image ? { image } : {}) };
}

function weather(data: Record<string, unknown>): WeatherCard | null {
  const where = words(data.place);
  if (!where) return null;
  const unit = typeof data.unit === "string" && data.unit.trim().toUpperCase().startsWith("C") ? "C" : "F";
  const current = data.now && typeof data.now === "object" ? data.now as Record<string, unknown> : null;
  const temp = numeric(current?.temp);
  const now = temp === undefined ? undefined : { temp, ...(words(current?.condition, 60) ? { condition: words(current?.condition, 60)! } : {}) };
  const days = (Array.isArray(data.days) ? data.days : []).slice(0, MAX_DAYS).flatMap((entry): WeatherDay[] => {
    if (!entry || typeof entry !== "object") return [];
    const day = entry as Record<string, unknown>;
    const label = words(day.day, 24);
    if (!label) return [];
    const high = numeric(day.high);
    const low = numeric(day.low);
    const condition = words(day.condition, 60);
    return [{ day: label, ...(high !== undefined ? { high } : {}), ...(low !== undefined ? { low } : {}), ...(condition ? { condition } : {}) }];
  });
  if (!now && !days.length) return null;
  return { kind: "weather", place: where, unit, ...(now ? { now } : {}), days };
}

const DIAGRAM_TYPES = new Set([
  "flowchart", "graph", "sequencediagram", "classdiagram", "classdiagram-v2", "statediagram", "statediagram-v2", "erdiagram",
  "journey", "gantt", "pie", "quadrantchart", "requirementdiagram", "gitgraph", "mindmap", "timeline", "sankey", "sankey-beta",
  "xychart", "xychart-beta", "block", "block-beta", "packet", "packet-beta", "kanban", "architecture", "architecture-beta",
  "radar-beta", "treemap-beta",
]);

export function mermaidCode(lang: string, code: string): string | null {
  const kind = lang.trim();
  if (kind.toLowerCase() === "mermaid") return code;
  if (!DIAGRAM_TYPES.has(kind.toLowerCase())) return null;
  const first = code.split("\n").find((line) => line.trim() && !line.trim().startsWith("%%"))?.trim().toLowerCase() ?? "";
  return first.startsWith(kind.toLowerCase()) ? code : `${kind}\n${code}`;
}

export function richCard(lang: string, source: string): RichCard | null {
  const kind = lang.trim().toLowerCase();
  if (kind !== "place" && kind !== "product" && kind !== "weather") return null;
  const data = object(source);
  if (!data) return null;
  return kind === "place" ? place(data) : kind === "product" ? product(data) : weather(data);
}

export function directions(card: PlaceCard): { apple: string; google: string } {
  const target = card.address ?? (card.lat !== undefined && card.lon !== undefined ? `${card.lat},${card.lon}` : card.name);
  return {
    apple: `https://maps.apple.com/?daddr=${encodeURIComponent(target)}&q=${encodeURIComponent(card.name)}`,
    google: `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(target)}`,
  };
}

export function sky(condition: string | undefined): Sky {
  const text = (condition ?? "").toLowerCase();
  if (/thunder|storm|lightning/.test(text)) return "storm";
  if (/snow|sleet|flurr|ice|hail/.test(text)) return "snow";
  if (/rain|shower|drizzle/.test(text)) return "rain";
  if (/fog|mist|haze|smoke/.test(text)) return "fog";
  if (/wind|breez|gust/.test(text)) return "wind";
  if (/partly|mostly sunny|mostly clear|few clouds|scattered/.test(text)) return "partly";
  if (/cloud|overcast|grey|gray/.test(text)) return "cloud";
  return "sun";
}

export function degrees(value: number | undefined, unit: "F" | "C"): string {
  return value === undefined ? "–" : `${Math.round(value)}°${unit}`;
}
