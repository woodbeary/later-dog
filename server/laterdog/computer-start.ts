export interface StartWatch {
  waking(id: string): void;
  starting(id: string, generation?: number): void;
  settled(id: string): void;
  leftMs(id: string): number;
  spent(id: string): boolean;
  exhaust(id: string): void;
}

export function createStartWatch(budgetMs: () => number, now: () => number = () => Date.now()): StartWatch {
  const attempts = new Map<string, { since: number; generation?: number }>();
  const leftMs = (id: string) => {
    const attempt = attempts.get(id);
    return attempt === undefined ? budgetMs() : budgetMs() - (now() - attempt.since);
  };
  return {
    waking: (id) => { attempts.set(id, { since: now() }); },
    starting: (id, generation) => {
      const attempt = attempts.get(id);
      if (!attempt || (generation !== undefined && attempt.generation !== undefined && attempt.generation !== generation)) {
        attempts.set(id, { since: now(), ...(generation !== undefined ? { generation } : {}) });
      } else if (generation !== undefined && attempt.generation === undefined) attempt.generation = generation;
    },
    settled: (id) => { attempts.delete(id); },
    leftMs,
    spent: (id) => attempts.has(id) && leftMs(id) <= 0,
    exhaust: (id) => { attempts.set(id, { ...attempts.get(id), since: now() - budgetMs() }); },
  };
}

export const START_RAN_OUT = "the cloud computer didn't start in time";

export function startRanOutOfTime(error: unknown): boolean {
  return error instanceof Error && error.message === START_RAN_OUT;
}

export const DID_NOT_START_CODE = "did_not_start" as const;

const BOOT_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/did not become ready/i, "It did not finish starting within 5 minutes."],
  [/stopped while restoring its snapshot/i, "It stopped while bringing back its saved files."],
  [/stopped while starting/i, "It stopped while starting."],
  [/^the computer could not start/i, "The cloud could not start it."],
];
export const UNKNOWN_START_FAILURE = "The computer could not start.";

export function bootFailure(reason: string | undefined): string | null {
  return BOOT_FAILURES.find(([words]) => words.test(reason?.trim() ?? ""))?.[1] ?? null;
}

export function didNotStartText(reason?: string): string {
  return `Your cloud computer did not start. ${bootFailure(reason) ?? UNKNOWN_START_FAILURE} Nothing was run, and waiting longer will not help. `
    + "Choose one instead: do light work in your folder here; call run_on_computer again with fresh: true to replace it with a new cloud computer "
    + "(your folders here stay, and are sent again; only what lived on the old computer alone, such as installed packages, is gone); "
    + "or tell the person what you could not do.";
}

export function didNotStart(reason?: string): Error & { code: typeof DID_NOT_START_CODE } {
  return Object.assign(new Error(didNotStartText(reason)), { code: DID_NOT_START_CODE });
}


export const SCREEN_DID_NOT_START_TEXT = "Your cloud computer did not start, so this call was not performed, and its screen tools will not work in this turn; waiting longer will not help. "
  + "Carry on without the screen: do light work in your folder here; for a heavy command, call run_on_computer with fresh: true to get a new cloud computer "
  + "(your folders here stay); or tell the person what you could not do.";

export function cloudDidNotStart(failure: unknown): boolean {
  const row = (failure as { place?: unknown; row?: { state?: unknown } } | null)?.row;
  return (failure as { place?: unknown } | null)?.place === "cloud" && row?.state === "cc-no-start";
}
