import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CURATED_TOOLKITS } from "../server/composio.ts";
import { brandMark } from "../src/lib/brand-icons.ts";
import { MCP_CONNECTORS } from "../src/lib/mcp-connector-catalog.ts";

const ICON_DIR = "public/app-icons";
const LIST_FILE = "src/lib/app-icon-files.ts";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);
const SIZE = 64;

export function domainsNeedingIcons(): string[] {
  const domains = new Set<string>();
  for (const connector of MCP_CONNECTORS) if (!brandMark(connector.id)) domains.add(connector.domain);
  for (const card of CURATED_TOOLKITS) if (card.domain && !brandMark(card.slug)) domains.add(card.domain);
  return [...domains].sort();
}

function pngWidth(bytes: Buffer): number {
  return bytes.length > 24 && bytes.subarray(0, 8).equals(PNG) ? bytes.readUInt32BE(16) : 0;
}

function extension(bytes: Buffer): "png" | "jpg" | null {
  if (pngWidth(bytes) > 0) return "png";
  return bytes.subarray(0, 3).equals(JPEG) ? "jpg" : null;
}

async function fetchIcon(domain: string): Promise<{ bytes: Buffer; ext: "png" | "jpg" } | null> {
  for (const host of [domain, `www.${domain}`]) {
    const response = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=${SIZE}`, { redirect: "follow" });
    if (!response.ok) continue;
    const bytes = Buffer.from(await response.arrayBuffer());
    const ext = extension(bytes);
    if (ext) return { bytes, ext };
  }
  return null;
}

if (import.meta.main) {
  const domains = domainsNeedingIcons();
  mkdirSync(ICON_DIR, { recursive: true });
  for (const file of readdirSync(ICON_DIR)) rmSync(join(ICON_DIR, file));
  const saved: Array<[string, string]> = [];
  const missing: string[] = [];
  const small: string[] = [];
  for (const domain of domains) {
    const icon = await fetchIcon(domain);
    if (!icon) {
      missing.push(domain);
      continue;
    }
    const file = `${domain}.${icon.ext}`;
    writeFileSync(join(ICON_DIR, file), icon.bytes);
    saved.push([domain, file]);
    const width = pngWidth(icon.bytes);
    if (icon.ext === "png" && width < 32) small.push(`${domain} (${width}px)`);
  }
  const entries = saved.map(([domain, file]) => `  ${JSON.stringify(domain)}: ${JSON.stringify(file)},`).join("\n");
  writeFileSync(LIST_FILE, `export const APP_ICON_FILES: Readonly<Record<string, string>> = {\n${entries}\n};\n`);
  console.log(JSON.stringify({ needed: domains.length, saved: saved.length, missing, small }, null, 2));
}
