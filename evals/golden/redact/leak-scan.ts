export interface LeakFinding {
  category: string;
  occurrences: number;
  path?: string;
}

const PATTERNS: Array<{ category: string; pattern: RegExp }> = [
  { category: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { category: "url", pattern: /https?:\/\/\S+|\bwww\.[A-Za-z0-9-]+\.[A-Za-z]{2,}\S*/ },
  {
    category: "absolute-path",
    pattern: /(?:^|[\s"'(=,])(?:\/(?:Users|home|private|var|tmp|opt|etc|root)\/[A-Za-z0-9@._-]+(?:\/[A-Za-z0-9@._-]+)*)|[A-Za-z]:\\(?:Users|Windows|Program Files)/,
  },
  { category: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ },
  { category: "secret-or-id", pattern: /\b[A-Za-z0-9_-]{24,}\b|\b(?:sk|ghp|gho|tok|key)[-_:][A-Za-z0-9_-]{8,}\b/ },
  { category: "hex-blob", pattern: /\b[0-9a-fA-F]{16,}\b/ },
];

const SAFE_TOKENS = new Set(["coordinate_bots"]);

function jsonPaths(value: unknown, prefix = "$"): Array<{ path: string; text: string }> {
  if (typeof value === "string") return [{ path: prefix, text: value }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => jsonPaths(entry, prefix + "[" + index + "]"));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, entry]) => jsonPaths(entry, prefix + "." + key));
  }
  return [];
}

export function scanStrings(value: unknown): LeakFinding[] {
  const findings = new Map<string, LeakFinding>();
  for (const { path, text } of jsonPaths(value)) {
    for (const { category, pattern } of PATTERNS) {
      if (SAFE_TOKENS.has(text)) continue;
      const occurrences = text.match(new RegExp(pattern.source, "g"))?.length ?? 0;
      if (occurrences === 0) continue;
      const existing = findings.get(category);
      if (existing === undefined) findings.set(category, { category, occurrences, path });
      else existing.occurrences += occurrences;
    }
  }
  return [...findings.values()];
}

export function scanSerialized(json: string): LeakFinding[] {
  const findings = new Map<string, LeakFinding>();
  for (const { category, pattern } of PATTERNS) {
    const occurrences = json.match(new RegExp(pattern.source, "g"))?.length ?? 0;
    if (occurrences > 0) findings.set(category, { category, occurrences });
  }
  return [...findings.values()];
}

export function survivorsOf(sourceTexts: string[], redactedJson: string): string[] {
  const redacted = redactedJson.toLowerCase();
  return sourceTexts
    .map((text) => text.toLowerCase().replaceAll(/\s+/g, " ").trim())
    .filter((text) => text.length >= 8)
    .filter((text) => redacted.includes(text));
}

export function formatFindings(findings: LeakFinding[]): string {
  return findings
    .map((finding) => finding.category + " x" + finding.occurrences + (finding.path ? " at " + finding.path : ""))
    .join("; ");
}
