export const DARK_PIE = {
  pie1: "#5B8DEF", pie2: "#E5A84B", pie3: "#4FBF8B", pie4: "#D9667A", pie5: "#9B7FE6", pie6: "#4AB8C9",
  pie7: "#C98D5B", pie8: "#8A99AD", pie9: "#E07E4F", pie10: "#6FAE5E", pie11: "#B57FB3", pie12: "#7C8BD9",
  pieStrokeColor: "#1F1F1F", pieOuterStrokeColor: "#3A3A3A", pieSectionTextColor: "#FFFFFF",
} as const;

const EXPORT_SETTINGS = { theme: "default", htmlLabels: false, flowchart: { htmlLabels: false } } as const;
const FRONT_MATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)/;

export function exportableDiagram(code: string): string {
  const directive = `%%{init: ${JSON.stringify(EXPORT_SETTINGS)}}%%\n`;
  const front = FRONT_MATTER.exec(code);
  return front ? `${front[1]}${directive}${code.slice(front[1]!.length)}` : `${directive}${code}`;
}

export function svgSize(svg: string): { width: number; height: number } {
  const box = /<svg\b[^>]*\sviewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*"/i.exec(svg);
  if (box) return { width: Number(box[1]), height: Number(box[2]) };
  const width = /<svg\b[^>]*\swidth="([\d.]+)(?:px)?"/i.exec(svg);
  const height = /<svg\b[^>]*\sheight="([\d.]+)(?:px)?"/i.exec(svg);
  return { width: width ? Number(width[1]) : 800, height: height ? Number(height[1]) : 600 };
}

export function sizedSvg(svg: string, size: { width: number; height: number }): string {
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attributes: string) =>
    `<svg${attributes.replace(/\s(?:width|height)="[^"]*"/gi, "").replace(/\sstyle="[^"]*"/i, "")} width="${size.width}" height="${size.height}">`);
}

export async function diagramPng(svg: string, scale = 2): Promise<Blob> {
  const size = svgSize(svg);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sizedSvg(svg, size))}`;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width * scale));
  canvas.height = Math.max(1, Math.round(size.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This window can't draw images.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be made."))), "image/png");
  });
}

export function saveBlob(filename: string, blob: Blob): void {
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  try {
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
