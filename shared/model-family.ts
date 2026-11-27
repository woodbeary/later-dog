const FAMILIES = ["fable", "opus", "sonnet", "haiku"] as const;

export function modelFamily(model: string): string {
  const lower = model.trim().toLowerCase();
  const words = lower.split(/[^a-z]+/);
  const named = FAMILIES.find((family) => words.includes(family));
  if (named) return named;
  const plain = lower.replace(/\[[^\]]*\]$/, "");
  return words.includes("gemini") ? plain.replace(/-(?:minimal|low|medium|high)$/, "") : plain;
}

export function sameModel(a: string, b: string): boolean {
  return modelFamily(a) === modelFamily(b);
}
