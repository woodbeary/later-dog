import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "../atomic.ts";

export interface HeldRoutines {
  listRoutines(): Array<{ id: string; enabled: boolean }>;
  update(id: string, patch: { enabled: boolean }): unknown;
}

interface HoldFile { held: boolean; pausedRoutineIds: string[] }

export class CloudHold {
  private state: HoldFile = { held: false, pausedRoutineIds: [] };

  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    try {
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (value !== null && typeof value === "object") {
        const { held, pausedRoutineIds } = value as Partial<HoldFile>;
        this.state = { held: held === true, pausedRoutineIds: Array.isArray(pausedRoutineIds) ? pausedRoutineIds.filter((id) => typeof id === "string") : [] };
      }
    } catch {}
  }

  get held(): boolean { return this.state.held; }

  assertAvailable(): void {
    if (this.state.held) throw Object.assign(new Error("This computer's dogs are working in My Cloud while you are signed in."), { status: 503 });
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 });
  }

  hold(routines: HeldRoutines | null): { held: true; paused: number } {
    const paused = new Set(this.state.pausedRoutineIds);
    let count = 0;
    for (const routine of routines?.listRoutines() ?? []) {
      if (!routine.enabled) continue;
      try { routines!.update(routine.id, { enabled: false }); paused.add(routine.id); count++; } catch {}
    }
    this.state = { held: true, pausedRoutineIds: [...paused] };
    this.save();
    return { held: true, paused: count };
  }

  release(routines: HeldRoutines | null): { held: false; resumed: number } {
    const known = new Map((routines?.listRoutines() ?? []).map((routine) => [routine.id, routine.enabled]));
    let resumed = 0;
    for (const id of this.state.pausedRoutineIds) {
      if (known.get(id) !== false) continue;
      try { routines!.update(id, { enabled: true }); resumed++; } catch {}
    }
    this.state = { held: false, pausedRoutineIds: [] };
    this.save();
    return { held: false, resumed };
  }
}
