import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPublicDomainAddress } from "../custom-domain.ts";

export interface LinkPreview {
  url: string;
  title: string;
  description?: string;
  image?: string;
  site?: string;
}

export interface FetchedPage {
  status: number;
  location?: string;
  contentType?: string;
  body: string;
}

export interface LinkPreviewDependencies {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  fetchPage?: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<FetchedPage>;
  now?: () => number;
}

const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 6_000;
const MAX_REDIRECTS = 3;
const KEPT_MS = 60 * 60 * 1000;
const KEPT_MAX = 500;
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/", "#47": "/" };

export function previewTarget(raw: string): URL | null {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || isIP(host.replace(/^\[|\]$/g, "")) || /(?:^|\.)(?:localhost|local|internal|invalid|test|home|lan|corp)$/.test(host)) return null;
  url.hash = "";
  return url;
}

function decode(text: string): string {
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      const known = ENTITIES[name] ?? ENTITIES[name.toLowerCase()];
      if (known) return known;
      const code = name.startsWith("#x") || name.startsWith("#X") ? Number.parseInt(name.slice(2), 16) : name.startsWith("#") ? Number(name.slice(1)) : NaN;
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(tag);
  return match ? match[2] ?? match[3] ?? match[4] : undefined;
}

export function pageMeta(html: string, base: URL): Omit<LinkPreview, "url"> | null {
  const head = html.slice(0, MAX_BYTES).split(/<\/head\s*>/i)[0] ?? "";
  const meta = new Map<string, string>();
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (attribute(tag, "property") ?? attribute(tag, "name"))?.toLowerCase();
    const content = attribute(tag, "content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decode(content));
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = (meta.get("og:title") || meta.get("twitter:title") || (titleTag ? decode(titleTag) : ""))?.slice(0, 200);
  if (!title) return null;
  const description = (meta.get("og:description") || meta.get("twitter:description") || meta.get("description"))?.slice(0, 300);
  const site = meta.get("og:site_name")?.slice(0, 80);
  let image: string | undefined;
  const rawImage = meta.get("og:image") || meta.get("og:image:url") || meta.get("twitter:image");
  if (rawImage) {
    try {
      const resolved = new URL(rawImage, base);
      if (resolved.protocol === "https:") image = resolved.toString();
    } catch {}
  }
  return { title, ...(description ? { description } : {}), ...(image ? { image } : {}), ...(site ? { site } : {}) };
}

async function publicAddress(hostname: string, lookup: (hostname: string) => Promise<LookupAddress[]>): Promise<LookupAddress | null> {
  const addresses = await lookup(hostname);
  if (!addresses.length || !addresses.every((address) => isPublicDomainAddress(address.address))) return null;
  return addresses[0]!;
}

function fetchPinned(url: URL, address: LookupAddress, signal: AbortSignal): Promise<FetchedPage> {
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    const request = httpsRequest(url, {
      method: "GET", agent: false, lookup, signal, rejectUnauthorized: true,
      headers: { Accept: "text/html,application/xhtml+xml", "User-Agent": "Mozilla/5.0 (compatible; later.dog link preview)", "Accept-Encoding": "identity" },
    }, (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      const contentType = String(response.headers["content-type"] ?? "");
      if (status >= 300 && status < 400 || !/text\/html|application\/xhtml/i.test(contentType)) {
        response.destroy();
        resolve({ status, ...(response.headers.location ? { location: String(response.headers.location) } : {}), contentType, body: "" });
        return;
      }
      let body = "";
      let size = 0;
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        size += Buffer.byteLength(chunk);
        body += chunk;
        if (size >= MAX_BYTES || /<\/head\s*>/i.test(body)) response.destroy();
      });
      response.on("close", () => resolve({ status, contentType, body }));
      response.on("error", () => resolve({ status, contentType, body }));
    });
    request.on("error", reject);
    request.end();
  });
}

export class LinkPreviews {
  private readonly kept = new Map<string, { at: number; preview: LinkPreview | null }>();
  private readonly lookup: (hostname: string) => Promise<LookupAddress[]>;
  private readonly fetchPage: (url: URL, address: LookupAddress, signal: AbortSignal) => Promise<FetchedPage>;
  private readonly now: () => number;

  constructor(deps: LinkPreviewDependencies = {}) {
    this.lookup = deps.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
    this.fetchPage = deps.fetchPage ?? fetchPinned;
    this.now = deps.now ?? Date.now;
  }

  async preview(raw: string): Promise<LinkPreview | null> {
    const target = previewTarget(raw);
    if (!target) return null;
    const key = target.toString();
    const kept = this.kept.get(key);
    if (kept && this.now() - kept.at < KEPT_MS) return kept.preview;
    const preview = await this.read(target).catch(() => null);
    this.kept.delete(key);
    this.kept.set(key, { at: this.now(), preview });
    while (this.kept.size > KEPT_MAX) this.kept.delete(this.kept.keys().next().value!);
    return preview;
  }

  private async read(start: URL): Promise<LinkPreview | null> {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let url = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const address = await publicAddress(url.hostname, this.lookup);
      if (!address) return null;
      const page = await this.fetchPage(url, address, signal);
      if (page.status >= 300 && page.status < 400 && page.location) {
        let next: URL | null;
        try { next = previewTarget(new URL(page.location, url).toString()); } catch { next = null; }
        if (!next) return null;
        url = next;
        continue;
      }
      if (page.status !== 200 || !page.body) return null;
      const meta = pageMeta(page.body, url);
      return meta ? { url: start.toString(), ...meta } : null;
    }
    return null;
  }
}
