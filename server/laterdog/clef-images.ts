export const CLEF_IMAGE_MAX_BYTES = 190 * 1024;
export const CLEF_IMAGE_MAX_COUNT = 4;

const MIME_OF_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  webp: "image/webp",
};
const ALLOWED_MIMES = new Set(Object.values(MIME_OF_FORMAT));
const DATA_URL = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i;

export type ImageRefusal = "unsupported_type" | "malformed" | "too_large" | "too_many";

export type PreparedImages =
  | { ok: true; images: string[] }
  | { ok: false; reason: ImageRefusal };

export interface ImageShrinker {
  (bytes: Buffer, mime: string, maxBytes: number): Promise<{ bytes: Buffer; mime: string } | null>;
}

export interface ImageSource {
  data: string;
  format?: string;
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function normalise(source: ImageSource): { mime: string; base64: string } | ImageRefusal {
  const text = source.data.trim();
  const url = DATA_URL.exec(text);
  if (url) {
    const mime = url[1]!.toLowerCase() === "image/jpg" ? "image/jpeg" : url[1]!.toLowerCase();
    return ALLOWED_MIMES.has(mime) ? { mime, base64: url[2]! } : "unsupported_type";
  }
  const mime = MIME_OF_FORMAT[(source.format ?? "").toLowerCase().replace(/^image\//, "")];
  if (!mime) return "unsupported_type";
  return /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? { mime, base64: text } : "malformed";
}

export async function prepareClefImages(
  sources: readonly ImageSource[],
  options: { maxBytes?: number; shrink?: ImageShrinker } = {},
): Promise<PreparedImages> {
  if (sources.length > CLEF_IMAGE_MAX_COUNT) return { ok: false, reason: "too_many" };
  const maxBytes = options.maxBytes ?? CLEF_IMAGE_MAX_BYTES;
  const images: string[] = [];
  for (const source of sources) {
    const parsed = normalise(source);
    if (typeof parsed === "string") return { ok: false, reason: parsed };
    let { mime, base64 } = parsed;
    if (decodedBytes(base64) > maxBytes) {
      const shrunk = options.shrink ? await options.shrink(Buffer.from(base64, "base64"), mime, maxBytes).catch(() => null) : null;
      if (!shrunk || shrunk.bytes.length > maxBytes || !ALLOWED_MIMES.has(shrunk.mime)) return { ok: false, reason: "too_large" };
      mime = shrunk.mime;
      base64 = shrunk.bytes.toString("base64");
    }
    images.push(`data:${mime};base64,${base64}`);
  }
  return { ok: true, images };
}
