export interface Sponsor {
  name: string;
  tagline: string;
  url: string;
  icon?: string;
  color?: string;
}

export const SPONSORS: readonly Sponsor[] = [];

export const SPONSOR_URL: string | null = null;

export type SponsorSlot =
  | { kind: "none" }
  | { kind: "open"; url: string }
  | { kind: "sponsors"; sponsors: Sponsor[]; url: string | null };

export function sponsorLink(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function sponsorIcon(icon: string | undefined): string | undefined {
  const value = icon?.trim();
  if (!value) return undefined;
  if (value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")) return value;
  return /^data:image\/(?:png|jpeg|webp|gif|svg\+xml)[;,]/i.test(value) ? value : undefined;
}

function sponsorColor(color: string | undefined): string | undefined {
  const value = color?.trim().toLowerCase();
  if (!value) return undefined;
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  return /^#[0-9a-f]{3}$/.test(value) ? value.replace(/[0-9a-f]/g, (digit) => digit + digit) : undefined;
}

export function sponsorSlot(sponsors: readonly Sponsor[] = SPONSORS, url: string | null = SPONSOR_URL): SponsorSlot {
  const link = sponsorLink(url);
  const listed = sponsors.flatMap((sponsor): Sponsor[] => {
    const name = sponsor.name.trim();
    const href = sponsorLink(sponsor.url);
    if (!name || !href) return [];
    const icon = sponsorIcon(sponsor.icon);
    const color = sponsorColor(sponsor.color);
    return [{ name, tagline: sponsor.tagline.trim(), url: href, ...(icon ? { icon } : {}), ...(color ? { color } : {}) }];
  });
  if (listed.length > 0) return { kind: "sponsors", sponsors: listed, url: link };
  return link ? { kind: "open", url: link } : { kind: "none" };
}
