const ASKS = [
  /\bneed (?:your|\{name\}'s) (?:decision|answer|call|ok|okay|go-ahead|input|approval)\b/i,
  /\bwaiting (?:on|for) (?:you|\{name\})\b/i,
  /\b(?:still )?need \{name\}(?:'s)? (?:decision|answer|call|ok|okay|go-ahead|input|approval)\b/i,
  /\byour call\b/i,
  /\b(?:can|could|should|do|would) you\b[^.!\n]*\?/i,
  /\b(?:should|shall|can) I\b[^.!\n]*\?/i,
  /\b(?:want|wants) (?:me|it) to\b[^.!\n]*\?/i,
];

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function personAsk(result: string | undefined, ownerName: string | undefined): string | null {
  const text = result?.trim();
  if (!text) return null;
  const name = ownerName?.trim();
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    for (const pattern of ASKS) {
      const source = name ? pattern.source.replaceAll("\\{name\\}", escape(name)).replaceAll("{name}", escape(name)) : pattern.source.replaceAll("\\{name\\}", "(?!)").replaceAll("{name}", "(?!)");
      if (new RegExp(source, pattern.flags).test(sentence)) return oneLine(sentence);
    }
  }
  return null;
}

export function oneLine(text: string, max = 140): string {
  const flat = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
