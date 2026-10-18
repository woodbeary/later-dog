export const SHOWN_ENGINES = ["claudeAgent", "codex", "grokAgent", "cursorAgent", "laterdogAi", "laterdogGrok"] as const;
export type ShownEngine = (typeof SHOWN_ENGINES)[number];

export const INCLUDED_ENGINES = ["laterdogAi", "laterdogGrok"] as const satisfies readonly ShownEngine[];
export type IncludedEngine = (typeof INCLUDED_ENGINES)[number];
export type AccountEngine = Exclude<ShownEngine, IncludedEngine>;

export function isShownEngine(driverKind: string | undefined): driverKind is ShownEngine {
  return (SHOWN_ENGINES as readonly string[]).includes(driverKind ?? "");
}

export function isIncludedEngine(driverKind: string | undefined): driverKind is IncludedEngine {
  return (INCLUDED_ENGINES as readonly string[]).includes(driverKind ?? "");
}
