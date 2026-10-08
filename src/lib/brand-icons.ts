// Brand marks for the connector catalog (lib/mcp-connectors.ts), drawn by
// components/BrandIcon.tsx.
//
// Source: Simple Icons (https://simpleicons.org,
// https://github.com/simple-icons/simple-icons), npm simple-icons@16.32.0,
// released 2026-09-20 (tarball integrity sha512-BwqATHxAulx7X6kNdTkecy7PBjLkgtAHcgrwYLd9iA+cD2At9DzhJwdwaSELk2+aZe01IfiM/Wxtyp68Dvup2A==).
// Each `path` is the one <path d> of icons/<slug>.svg (a 24×24 viewBox),
// copied unchanged; `title`, `hex`, `source` and `guidelines` come from that
// slug's entry in data/simple-icons.json. All ten are identical in 16.34.0,
// the latest release on 2026-10-08.
//
// License: Simple Icons is released under CC0-1.0, and its data gives none of
// these ten an icon license of its own. The marks are their owners'
// trademarks. later.dog shows them only to identify the service a connector
// signs in to, beside its name, with the shape unchanged, in the brand's own
// colour or, where that colour would vanish on the white tile, in black (see
// markColor). `guidelines` keeps each brand's usage rules where Simple Icons
// links them; `source` is where Simple Icons took the mark from.
//
// The simple-icons package is not a dependency: the app ships these ten
// paths and nothing else. To refresh a mark, copy it from a newer release and
// update the version above.

export interface BrandMark {
  /** The brand's name, as Simple Icons titles it. */
  title: string;
  /** The brand colour: six hex digits, no "#". */
  hex: string;
  /** The mark: SVG path data on a 24×24 viewBox. */
  path: string;
  /** Where Simple Icons took the mark from. */
  source: string;
  /** The brand's usage guidelines, where Simple Icons links them. */
  guidelines?: string;
}

/** Keyed by connector id, which for each of these is its Simple Icons slug. */
export const BRAND_MARKS: Readonly<Record<string, BrandMark>> = {
  atlassian: {
    title: "Atlassian",
    hex: "0052CC",
    path: "M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z",
    source: "https://atlassian.design/resources/logo-library",
    guidelines: "https://atlassian.design/foundations/logos",
  },
  cloudflare: {
    title: "Cloudflare",
    hex: "F38020",
    path: "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727",
    source: "https://www.cloudflare.com/logo/",
    guidelines: "https://www.cloudflare.com/trademark/",
  },
  intercom: {
    title: "Intercom",
    hex: "6AFDEF",
    path: "M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z",
    source: "https://www.intercom.com/press",
    guidelines: "https://www.intercom.com/press",
  },
  linear: {
    title: "Linear",
    hex: "5E6AD2",
    path: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
    source: "https://linear.app",
  },
  neon: {
    title: "Neon",
    hex: "34D59A",
    path: "M24 0V24l-9.365-8.045V24H0V0ZM2.942 21.087h8.751V9.563l9.365 8.204V2.919L2.942 2.914Z",
    source: "https://neon.com/brand",
    guidelines: "https://neon.com/brand",
  },
  notion: {
    title: "Notion",
    hex: "000000",
    path: "M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z",
    source: "https://www.notion.so",
  },
  paypal: {
    title: "PayPal",
    hex: "002991",
    path: "M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z",
    source: "https://www.paypal.com/us",
    guidelines: "https://newsroom.paypal-corp.com/media-resources",
  },
  sentry: {
    title: "Sentry",
    hex: "362D59",
    path: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
    source: "https://sentry.io/branding/",
  },
  stripe: {
    title: "Stripe",
    hex: "635BFF",
    path: "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z",
    source: "https://stripe.com/newsroom/information",
  },
  webflow: {
    title: "Webflow",
    hex: "146EF5",
    path: "m24 4.515-7.658 14.97H9.149l3.205-6.204h-.144C9.566 16.713 5.621 18.973 0 19.485v-6.118s3.596-.213 5.71-2.435H0V4.515h6.417v5.278l.144-.001 2.622-5.277h4.854v5.244h.144l2.72-5.244H24Z",
    source: "https://brand-at.webflow.io/resources#logos",
    guidelines: "https://brand-at.webflow.io",
  },
};

/** The mark for a connector id or toolkit slug; undefined when there is none. */
export function brandMark(id: string): BrandMark | undefined {
  return Object.hasOwn(BRAND_MARKS, id) ? BRAND_MARKS[id] : undefined;
}

/** Every mark sits on this tile in every skin, light or dark: brand colours
 * are chosen to stand on white, and a white tile reads on dark glass too. */
export const BRAND_TILE = "#ffffff";

/** A mark's one-colour form, for a brand colour too pale for the tile. */
export const BRAND_INK = "#000000";

/** Below this contrast with the tile, a brand colour leaves only a ghost of
 * its mark: Intercom's #6AFDEF is 1.24:1 on white. Such a mark is drawn in
 * BRAND_INK rather than in a darkened brand colour. Neon's #34D59A, at
 * 1.89:1, still reads as its green mark and keeps it. */
export const MIN_MARK_CONTRAST = 1.5;

function luminance(hex: string): number {
  const digits = hex.replace(/^#/, "");
  const [red, green, blue] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

/** WCAG contrast ratio of two six-digit hex colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter! + 0.05) / (darker! + 0.05);
}

/** The colour a mark is drawn in on BRAND_TILE: its brand colour, or its
 * one-colour form where the brand colour would vanish on the tile. */
export function markColor(mark: BrandMark): string {
  const brand = `#${mark.hex}`;
  return contrastRatio(brand, BRAND_TILE) >= MIN_MARK_CONTRAST ? brand : BRAND_INK;
}
