export type Part = "cold" | "timed" | "counted" | "landing" | "calibration";

export interface PerfResult {
  cold?: { composerReadyMs?: { p50?: number } };
  timed?: Record<string, any>;
  counted?: Record<string, any>;
  landing?: { cases?: LandingResultCase[] };
  calibration?: { ms?: number };
}

export interface LandingResultCase {
  follow: string;
  mainThread?: { longestTaskMs?: number; longTasks?: number };
  content?: { mostPx?: number };
  viewport?: { mostPx?: number };
}

interface Measure {
  part: Part;
  read(result: PerfResult): number | undefined;
}

function maximum(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length === 0 ? undefined : Math.max(...present);
}

function total(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number");
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0);
}

function cases(result: PerfResult, follow?: string): LandingResultCase[] {
  return (result.landing?.cases ?? []).filter((entry) => follow === undefined || entry.follow === follow);
}

const counted = (section: string, field: "commits" | "rendered"): Measure => ({ part: "counted", read: (result) => result.counted?.[section]?.[field] });
const timed = (read: (timed: Record<string, any>) => number | undefined): Measure => ({ part: "timed", read: (result) => (result.timed ? read(result.timed) : undefined) });

export const measures: Record<string, Measure> = {
  "calibration.ms": { part: "calibration", read: (result) => result.calibration?.ms },
  "counted.working.commits": counted("streaming", "commits"),
  "counted.working.rendered": counted("streaming", "rendered"),
  "counted.workingWithSettings.commits": counted("streamingWithSettingsOpen", "commits"),
  "counted.workingWithSettings.rendered": counted("streamingWithSettingsOpen", "rendered"),
  "counted.otherDogsWorking.commits": counted("otherDogsWorking", "commits"),
  "counted.otherDogsWorking.rendered": counted("otherDogsWorking", "rendered"),
  "counted.typing.commits": counted("typing", "commits"),
  "counted.typing.rendered": counted("typing", "rendered"),
  "timed.working.longTasks": timed((section) => section.streaming?.longTasks),
  "timed.working.slowFrames": timed((section) => section.streaming?.slowFrames),
  "timed.workingWithSettings.slowFrames": timed((section) => section.streamingWithSettingsOpen?.slowFrames),
  "timed.workingWithSettings.longTasks": timed((section) => section.streamingWithSettingsOpen?.longTasks),
  "timed.typing.slowFrames": timed((section) => section.typing?.slowFrames),
  "timed.otherDogsWorking.longTasks": timed((section) => section.otherDogsWorking?.longTasks),
  "timed.typingKeyToFrameMs.p95": timed((section) => section.typingKeyToFrameMs?.p95),
  "timed.switchToLongMs.p50": timed((section) => section.switchToLongMs?.p50),
  "timed.switchToShortMs.p50": timed((section) => section.switchToShortMs?.p50),
  "landing.tasksOver50Ms": { part: "landing", read: (result) => total(cases(result).map((entry) => entry.mainThread?.longTasks)) },
  "landing.longestTaskMs": { part: "landing", read: (result) => maximum(cases(result).map((entry) => entry.mainThread?.longestTaskMs)) },
  "landing.scrolledUp.rowsAboveMovedPx": { part: "landing", read: (result) => maximum(cases(result, "scrolledUp").map((entry) => entry.content?.mostPx)) },
  "landing.scrolledUp.rowsInViewMovedPx": { part: "landing", read: (result) => maximum(cases(result, "scrolledUp").map((entry) => entry.viewport?.mostPx)) },
  "landing.following.rowsAboveMovedPx": { part: "landing", read: (result) => maximum(cases(result, "followingTheBottom").map((entry) => entry.content?.mostPx)) },
};

export function readMeasures(result: PerfResult): Record<string, number | undefined> {
  return Object.fromEntries(Object.entries(measures).map(([name, measure]) => [name, measure.read(result)]));
}

export function partsNeeded(names: readonly string[]): Set<Part> {
  const parts = new Set<Part>();
  for (const name of names) {
    const measure = measures[name];
    if (measure) parts.add(measure.part);
  }
  return parts;
}

export function calibrate(runs = 5): number {
  const samples: number[] = [];
  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    let checksum = 0;
    for (let round = 0; round < 40; round += 1) {
      const rows = Array.from({ length: 4_000 }, (_, index) => ({ id: index, text: `row ${index * 7919 % 4_001}`, nested: { a: index % 13, b: [index, index + 1] } }));
      checksum += JSON.parse(JSON.stringify(rows)).sort((left: { text: string }, right: { text: string }) => left.text.localeCompare(right.text)).length;
    }
    if (checksum === 0) throw new Error("calibration did no work");
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return Math.round(samples[Math.floor(samples.length / 2)]! * 10) / 10;
}
