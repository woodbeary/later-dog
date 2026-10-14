import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const TILE_TOP = '<stop offset="0" stop-color="#21634C"/>';
const TILE_BOTTOM = '<stop offset="1" stop-color="#103629"/>';
export const SHEET_SIZES = [16, 32, 128, 512];

function retint(svg, top, bottom) {
  if (!svg.includes(TILE_TOP) || !svg.includes(TILE_BOTTOM)) throw new Error("The app icon no longer has the tile gradient this script retints.");
  return svg.replace(TILE_TOP, `<stop offset="0" stop-color="${top}"/>`).replace(TILE_BOTTOM, `<stop offset="1" stop-color="${bottom}"/>`);
}

function withOverlay(svg, overlay, defs = "") {
  const closing = svg.lastIndexOf("</svg>");
  const withDefs = defs ? svg.replace("</defs>", `${defs}</defs>`) : svg;
  const offset = withDefs.lastIndexOf("</svg>");
  if (closing < 0 || offset < 0) throw new Error("The app icon is not an SVG document.");
  return `${withDefs.slice(0, offset)}${overlay}${withDefs.slice(offset)}`;
}

function indigoBadge(svg) {
  const tinted = retint(svg, "#5560E8", "#222885");
  const badge = [
    '<g transform="translate(790 790)">',
    '<circle r="150" fill="#101440" opacity="0.35" cx="0" cy="10"/>',
    '<circle r="146" fill="#F2B134" stroke="#ffffff" stroke-width="22"/>',
    '<path d="M-48 -52L-92 0L-48 52M48 -52L92 0L48 52M18 -66L-18 66" fill="none" stroke="#2A1D05" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/>',
    "</g>",
  ].join("");
  return withOverlay(tinted, badge);
}

function hazardRibbon(svg) {
  const defs = '<clipPath id="dev-tile"><rect x="64" y="64" width="896" height="896" rx="200"/></clipPath>';
  const ribbon = [
    '<g clip-path="url(#dev-tile)">',
    '<polygon points="420,960 960,420 960,620 620,960" fill="#F2B134"/>',
    '<path d="M420 960L960 420M620 960L960 620" stroke="#2A1D05" stroke-width="14" fill="none"/>',
    '<text transform="translate(790 790) rotate(-45)" text-anchor="middle" dominant-baseline="central" font-family="-apple-system, Helvetica, Arial, sans-serif" font-weight="900" font-size="104" letter-spacing="6" fill="#2A1D05">DEV</text>',
    "</g>",
  ].join("");
  return withOverlay(svg, ribbon, defs);
}

function nightRing(svg) {
  const dark = retint(svg, "#3A3A42", "#0D0D10");
  const ring = [
    '<rect x="92" y="92" width="840" height="840" rx="172" fill="none" stroke="#FF7A1A" stroke-width="40"/>',
    '<circle cx="826" cy="198" r="64" fill="#FF7A1A" stroke="#ffffff" stroke-width="16"/>',
  ].join("");
  return withOverlay(dark, ring);
}

export function devIconSamples(svg) {
  return [
    { id: "indigo-badge", label: "A: Indigo tile with a code badge", svg: indigoBadge(svg) },
    { id: "hazard-ribbon", label: "B: Same green, hazard DEV ribbon", svg: hazardRibbon(svg) },
    { id: "night-ring", label: "C: Night tile with an orange ring", svg: nightRing(svg) },
  ];
}

const dataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export function sheetHtml(releaseSvg, samples) {
  const row = (name, svg) => `<section><h2>${name}</h2><div class="row">${SHEET_SIZES.map((size) => `<figure><img src="${dataUri(svg)}" width="${size}" height="${size}" alt="${name} at ${size}px"><figcaption>${size}px</figcaption></figure>`).join("")}</div></section>`;
  const beside = (svg) => `<div class="dock">${[releaseSvg, svg, releaseSvg].map((one) => `<img src="${dataUri(one)}" width="64" height="64" alt="">`).join("")}</div>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>later.dog Dev icon samples</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light dark;--bg:#f4f2ee;--ink:#1c1816;--card:#ffffff;--line:#d9d3ca}
@media (prefers-color-scheme:dark){:root{--bg:#161412;--ink:#f3eee6;--card:#211e1b;--line:#3a352f}}
body{margin:0;padding:32px 16px 64px;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,system-ui,sans-serif}
main{max-width:960px;margin:0 auto}h1{font-size:24px;margin:0 0 4px}p.note{margin:0 0 28px;opacity:.7}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin:0 0 20px}
h2{font-size:17px;margin:0 0 14px}.row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:24px}
figure{margin:0;text-align:center}figcaption{font-size:12px;opacity:.6;margin-top:6px}
.dock{margin-top:18px;display:flex;gap:14px;align-items:center;padding:12px 16px;border-radius:20px;background:rgba(127,127,127,.18);width:fit-content}
.dock::after{content:"release, Dev, release";font-size:12px;opacity:.6;margin-left:8px}
</style></head><body><main><h1>later.dog Dev icon samples</h1><p class="note">Each sample at 16, 32, 128 and 512 px, then in a Dock-like row between two release icons. The first sample (A) is wired in as the placeholder.</p>
${row("Release (current)", releaseSvg)}
${samples.map((sample) => `${row(sample.label, sample.svg)}${beside(sample.svg)}`).join("\n")}
</main></body></html>`;
}

function main() {
  const releaseSvg = readFileSync(join(root, "public/app-icon.svg"), "utf8");
  const samples = devIconSamples(releaseSvg);
  const sheetFlag = process.argv.indexOf("--sheet");
  if (sheetFlag > 0) {
    const out = resolve(process.argv[sheetFlag + 1]);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "index.html"), sheetHtml(releaseSvg, samples));
    for (const sample of samples) writeFileSync(join(out, `${sample.id}.svg`), sample.svg);
    console.log(`Wrote ${join(out, "index.html")}`);
  }
  if (process.argv.includes("--wire-first")) {
    writeFileSync(join(root, "public/app-icon-dev.svg"), samples[0].svg);
    console.log("Wrote public/app-icon-dev.svg from the first sample.");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
