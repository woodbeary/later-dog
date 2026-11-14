export interface StartWatch {
  waking(id: string): void;
  starting(id: string): void;
  settled(id: string): void;
  leftMs(id: string): number;
  spent(id: string): boolean;
}

export function createStartWatch(budgetMs: () => number, now: () => number = () => Date.now()): StartWatch {
  const since = new Map<string, number>();
  const leftMs = (id: string) => {
    const begun = since.get(id);
    return begun === undefined ? budgetMs() : budgetMs() - (now() - begun);
  };
  return {
    waking: (id) => { since.set(id, now()); },
    starting: (id) => { if (!since.has(id)) since.set(id, now()); },
    settled: (id) => { since.delete(id); },
    leftMs,
    spent: (id) => since.has(id) && leftMs(id) <= 0,
  };
}

export const DID_NOT_START_CODE = "did_not_start" as const;

const plainReason = (reason: string | undefined) => {
  const text = reason?.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  return text ? ` (${text.charAt(0).toLowerCase()}${text.slice(1)})` : "";
};

export function didNotStartText(reason?: string): string {
  return `Your cloud computer did not start${plainReason(reason)}, so nothing was run, and waiting longer will not help. `
    + "Choose one instead: do light work in your folder here; call run_on_computer again with fresh: true to replace it with a new cloud computer "
    + "(your folders here stay, and are sent again; only what lived on the old computer alone, such as installed packages, is gone); "
    + "or tell the person what you could not do.";
}

export function didNotStart(reason?: string): Error & { code: typeof DID_NOT_START_CODE } {
  return Object.assign(new Error(didNotStartText(reason)), { code: DID_NOT_START_CODE });
}

