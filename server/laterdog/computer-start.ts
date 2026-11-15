export interface StartWatch {
  waking(id: string): void;
  starting(id: string, generation?: number): void;
  settled(id: string): void;
  leftMs(id: string): number;
  spent(id: string): boolean;
  mark(): number;
  exhaust(id: string, since?: number): void;
  failed(id: string, reason: string): void;
  failure(id: string): string | undefined;
}

export function createStartWatch(budgetMs: () => number, now: () => number = () => Date.now()): StartWatch {
  const attempts = new Map<string, { since: number; generation?: number; serial: number; previous: number }>();
  let serials = 0;
  const begin = (id: string, generation?: number) => {
    attempts.set(id, { since: now(), ...(generation !== undefined ? { generation } : {}), serial: ++serials, previous: attempts.get(id)?.serial ?? 0 });
  };
  const failures = new Map<string, string>();
  const leftMs = (id: string) => {
    const attempt = attempts.get(id);
    return attempt === undefined ? budgetMs() : budgetMs() - (now() - attempt.since);
  };
  return {
    waking: (id) => { begin(id); failures.delete(id); },
    starting: (id, generation) => {
      const attempt = attempts.get(id);
      if (!attempt || (generation !== undefined && attempt.generation !== undefined && attempt.generation !== generation)) {
        begin(id, generation);
      } else if (generation !== undefined && attempt.generation === undefined) attempt.generation = generation;
    },
    settled: (id) => { attempts.delete(id); failures.delete(id); },
    leftMs,
    spent: (id) => attempts.has(id) && leftMs(id) <= 0,
    mark: () => serials,
    exhaust: (id, since) => {
      const attempt = attempts.get(id);
      if (since !== undefined && attempt && attempt.previous > since) return;
      attempts.set(id, { serial: ++serials, previous: 0, ...attempt, since: now() - budgetMs() });
    },
    failed: (id, reason) => { failures.set(id, reason); },
    failure: (id) => failures.get(id),
  };
}

export const START_RAN_OUT = "the cloud computer didn't start in time";

export function startRanOutOfTime(error: unknown): boolean {
  return error instanceof Error && error.message === START_RAN_OUT;
}

export const START_REFUSED_CODE = "start_failed";
export const REFUSED_START_TRIES = 3;
export const REFUSED_START_SPACING_MS = 15_000;

export const DID_NOT_START_CODE = "did_not_start" as const;

const BOOT_FAILURES: ReadonlyArray<readonly [RegExp, string]> = [
  [/did not become ready/i, "It did not finish starting within 5 minutes."],
  [/did not finish starting/i, "It did not finish starting."],
  [/stopped while restoring its snapshot/i, "It stopped while bringing back its saved files."],
  [/stopped while starting/i, "It stopped while starting."],
  [/^the computer could not start/i, "The cloud could not start it."],
];
export const UNKNOWN_START_FAILURE = "The computer could not start.";

export function bootFailure(reason: string | undefined): string | null {
  return BOOT_FAILURES.find(([words]) => words.test(reason?.trim() ?? ""))?.[1] ?? null;
}

export const RESET_WHERE = "Settings → Computer → Cloud computers";

export function didNotStartText(reason?: string): string {
  return `Your cloud computer did not start. ${bootFailure(reason) ?? UNKNOWN_START_FAILURE} Nothing was run, and waiting longer will not help. `
    + `Carry on without it: do light work in your folder here, and tell the person what you could not do. If the work needs the computer, ask them to reset it in ${RESET_WHERE}.`;
}

export function didNotStart(reason?: string): Error & { code: typeof DID_NOT_START_CODE } {
  return Object.assign(new Error(didNotStartText(reason)), { code: DID_NOT_START_CODE });
}

export function carryingOnRow(dog: string): string {
  return `${dog}'s cloud computer didn't start; ${dog} is carrying on without it.`;
}

export const SCREEN_DID_NOT_START_TEXT = "Your cloud computer did not start, so this call was not performed, and its screen tools will not work in this turn; waiting longer will not help. "
  + "Carry on without it: do light work in your folder here, and tell the person what you could not do. "
  + `If the work needs the computer, ask them to reset it in ${RESET_WHERE}.`;

export function cloudDidNotStart(failure: unknown): boolean {
  const row = (failure as { place?: unknown; row?: { state?: unknown } } | null)?.row;
  return (failure as { place?: unknown } | null)?.place === "cloud" && row?.state === "cc-no-start";
}
