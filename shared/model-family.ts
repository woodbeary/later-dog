const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

export function modelFamily(model: string): string {
  const lower = model.trim().toLowerCase();
  const words = lower.split(/[^a-z]+/);
  return FAMILIES.find((family) => words.includes(family)) ?? lower.replace(/\[[^\]]*\]$/, "");
}

export function sameModel(a: string, b: string): boolean {
  return modelFamily(a) === modelFamily(b);
}
