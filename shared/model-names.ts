export function baseModelId(model: string): string {
  return model.trim().replace(/\[[^\]]*\]$/, "").toLowerCase();
}

export function sameModelId(a: string, b: string): boolean {
  return baseModelId(a) === baseModelId(b);
}

const FAMILY = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;

export function modelName(model: string, catalogLabel?: string): string {
  const label = catalogLabel?.trim().replace(/^Claude\s+/i, "");
  if (label) return label;
  const match = FAMILY.exec(baseModelId(model));
  if (!match) return model;
  const family = match[1]!.charAt(0).toUpperCase() + match[1]!.slice(1);
  return `${family} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
}
