export const ASK_FIRST_MAX_RULES = 20;
export const ASK_FIRST_RULE_CHARS = 200;

export function askFirstRules(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const rules: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const rule = entry.replace(/\s+/g, " ").trim().slice(0, ASK_FIRST_RULE_CHARS).trim();
    const key = rule.toLowerCase();
    if (!rule || seen.has(key)) continue;
    seen.add(key);
    rules.push(rule);
    if (rules.length === ASK_FIRST_MAX_RULES) break;
  }
  return rules;
}
