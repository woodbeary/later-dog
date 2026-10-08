// Draws later.dog's mark — the default dog (the Retriever in src/components/dog-breeds.ts) on the green tile — into
// public/app-icon.svg (inset, for the OS) and public/laterdog.svg (full-bleed, for the favicon and the in-app logo).
// The dog is the same data the app draws, in fixed golden tones, so the icon and the avatars never drift apart.
// Run: node scripts/laterdog-mark.ts && pnpm laterdog:icons
import { writeFileSync } from "node:fs";
import { BREEDS, type BreedLook, type Tone } from "../src/components/dog-breeds.ts";
import { mouthGeometry, nosePath, round, tonguePath } from "../src/components/dog-geometry.ts";

const hex = (value: string) => [1, 3, 5].map((index) => parseInt(value.slice(index, index + 2), 16));
const mix = (a: string, b: string, share: number) =>
  `#${hex(a).map((channel, index) => Math.round(channel * share + hex(b)[index] * (1 - share)).toString(16).padStart(2, "0")).join("")}`;

const FUR = "#E3A552";
const TONES: Record<Tone, string> = {
  fur: FUR,
  shade: mix(FUR, "#000000", 0.8),
  dark: mix(FUR, "#000000", 0.52),
  deep: mix(FUR, "#100d0c", 0.24),
  light: mix(FUR, "#ffffff", 0.42),
  white: mix(FUR, "#fffaf3", 0.1),
  inner: mix(FUR, "#f4b4ae", 0.35),
  ink: "#1c1816",
};

function dog(look: BreedLook, id: string): string {
  const shapes = (list: { d: string; tone: Tone }[] | undefined) => (list ?? []).map((shape) => `<path fill="${TONES[shape.tone]}" d="${shape.d}"/>`).join("");
  const ears = `<g>${shapes(look.ears.shapes)}</g><g transform="matrix(-1 0 0 1 100 0)">${shapes(look.ears.shapes)}</g>`;
  const { x, y, rx, ry } = look.eyes;
  const eye = (cx: number) =>
    `<ellipse fill="${TONES.ink}" cx="${cx}" cy="${y}" rx="${rx}" ry="${ry}"/>` +
    `<circle fill="#fff" cx="${round(cx - rx * 0.3)}" cy="${round(y - ry * 0.36)}" r="${round(Math.min(rx, ry) * 0.36)}"/>`;
  const mouth = mouthGeometry(look);
  const details = (look.details ?? []).map((line) => `<path fill="none" stroke="${TONES[line.tone]}" stroke-width="${line.width}" stroke-linecap="round" d="${line.d}"/>`).join("");
  return [
    shapes(look.back),
    look.ears.front ? "" : ears,
    `<path fill="${TONES.fur}" d="${look.head}"/>`,
    `<g clip-path="url(#${id}-skull)">${shapes(look.markings)}</g>`,
    `<path fill="url(#${id}-sheen)" d="${look.head}"/>`,
    shapes(look.muzzle),
    shapes(look.front),
    look.ears.front ? ears : "",
    details,
    eye(x),
    eye(100 - x),
    `<path fill="#ef7f93" d="${tonguePath(mouth.join)}"/>`,
    `<path fill="none" stroke="${TONES.ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="${mouth.d}"/>`,
    `<path fill="${TONES.ink}" d="${nosePath(look.nose.y, look.nose.w, look.nose.h)}"/>`,
    `<ellipse fill="#fff" opacity="0.7" cx="${round(50 - look.nose.w * 0.17)}" cy="${round(look.nose.y - look.nose.h * 0.22)}" rx="${round(look.nose.w * 0.15)}" ry="${round(look.nose.h * 0.12)}"/>`,
  ].join("");
}

function mark(viewBox: string, id: string): string {
  const look = BREEDS.dog;
  // the dog fills about three quarters of the tile, tipped a few degrees for a little life
  const scale = 8.4;
  const dx = round(512 - 50 * scale), dy = round(528 - 52 * scale);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><title>later.dog</title><defs>` +
    `<linearGradient id="${id}-tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#21634C"/><stop offset="1" stop-color="#103629"/></linearGradient>` +
    `<radialGradient id="${id}-sheen" cx="0.34" cy="0.24" r="0.78"><stop offset="0" stop-color="#fff" stop-opacity="0.24"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.05"/><stop offset="1" stop-color="#000" stop-opacity="0.08"/></radialGradient>` +
    `<clipPath id="${id}-skull"><path d="${look.head}"/></clipPath>` +
    `<filter id="${id}-shadow" x="-20%" y="-20%" width="140%" height="150%"><feGaussianBlur stdDeviation="2.2"/></filter>` +
    `</defs>` +
    `<rect x="64" y="64" width="896" height="896" rx="200" fill="url(#${id}-tile)"/>` +
    `<g transform="translate(${dx} ${dy}) scale(${scale}) rotate(-6 50 56)">` +
    `<path d="${look.head}" fill="#06231a" opacity="0.38" transform="translate(0 3.2)" filter="url(#${id}-shadow)"/>` +
    dog(look, id) +
    `</g></svg>\n`;
}

writeFileSync(new URL("../public/app-icon.svg", import.meta.url), mark("0 0 1024 1024", "ld"));
writeFileSync(new URL("../public/laterdog.svg", import.meta.url), mark("64 64 896 896", "ldm"));
console.log("wrote public/app-icon.svg and public/laterdog.svg from the Retriever in src/components/dog-breeds.ts");
