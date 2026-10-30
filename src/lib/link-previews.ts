import { api } from "@/state/store";

export interface LinkPreview {
  url: string;
  title: string;
  description?: string;
  image?: string;
  site?: string;
}

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const LINK = /(!?)\[[^\]]*\]\((https:\/\/[^\s)]+)\)|(https:\/\/[^\s<>()[\]"'`]+)/g;
const NOT_A_PAGE = /\.(?:png|jpe?g|gif|webp|svg|avif|heic|pdf|zip|mp4|mov|mp3)(?:[?#]|$)/i;
const asked = new Map<string, Promise<LinkPreview | null>>();

export function previewLinks(text: string, max = 2): string[] {
  const found: string[] = [];
  for (const match of text.replace(CODE, " ").matchAll(LINK)) {
    if (match[1]) continue;
    const url = (match[2] ?? match[3] ?? "").replace(/[.,;:!?]+$/, "");
    if (!url || NOT_A_PAGE.test(url) || found.includes(url)) continue;
    found.push(url);
    if (found.length >= max) break;
  }
  return found;
}

export function linkHost(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

export function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  let pending = asked.get(url);
  if (!pending) {
    pending = api<{ preview: LinkPreview | null }>(`/api/link-preview?url=${encodeURIComponent(url)}`)
      .then((answer) => answer.preview)
      .catch(() => { asked.delete(url); return null; });
    asked.set(url, pending);
  }
  return pending;
}
