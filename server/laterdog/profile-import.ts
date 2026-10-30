import { appendAboutMe, commitLearned, planLearned } from "../profile-learned.ts";

export const IMPORT_SOURCE = { botId: "import", botName: "another assistant" } as const;
export const MAX_IMPORT_CHARS = 50_000;
const MAX_FACTS = 200;
const PREAMBLE = /^(?:sure|certainly|of course|okay|ok|absolutely|got it|here(?:'s| is| are)|below (?:is|are))\b/i;

export function importedFacts(text: string): string[] {
  const facts: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, "")
      .replace(/^#+\s*/, "")
      .replace(/\*\*|__/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length < 3 || line.endsWith(":") || PREAMBLE.test(line)) continue;
    facts.push(line);
    if (facts.length >= MAX_FACTS) break;
  }
  return facts;
}

export interface ImportResult {
  added: number;
  skipped: number;
  full: boolean;
  aboutMe: string;
}

export function importIntoAboutMe(text: string, aboutMe: string, today: string, save: (next: string) => void): ImportResult {
  const facts = importedFacts(text);
  const planned = planLearned(IMPORT_SOURCE, facts, aboutMe, today);
  let fitting = planned;
  let next = appendAboutMe(aboutMe, fitting.map((fact) => fact.line));
  while (next === null && fitting.length > 0) {
    fitting = fitting.slice(0, -1);
    next = appendAboutMe(aboutMe, fitting.map((fact) => fact.line));
  }
  if (!fitting.length || next === null) return { added: 0, skipped: facts.length, full: planned.length > 0, aboutMe };
  save(next);
  commitLearned(fitting);
  return { added: fitting.length, skipped: facts.length - fitting.length, full: fitting.length < planned.length, aboutMe: next };
}
