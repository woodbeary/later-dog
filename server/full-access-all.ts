import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class FullAccessAllSwitch {
  private on: boolean;

  constructor(private readonly file: string) {
    this.on = this.load();
  }

  enabled(): boolean {
    return this.on;
  }

  set(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, enabled: on }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }

  private load(): boolean {
    if (!existsSync(this.file)) return false;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { enabled?: unknown };
      return parsed.enabled === true;
    } catch {
      return false;
    }
  }
}

export interface FullAccessDog {
  id: string;
  approvalMode?: string;
  tasks?: ReadonlyArray<{ approvalMode?: string }>;
}

export const onFullEverywhere = (dog: FullAccessDog): boolean =>
  dog.approvalMode === "full" && (dog.tasks ?? []).every((task) => task.approvalMode === "full");

export const onFullAnywhere = (dog: FullAccessDog): boolean =>
  dog.approvalMode === "full" || (dog.tasks ?? []).some((task) => task.approvalMode === "full");

export function planFullAccess<T extends FullAccessDog>(
  dogs: readonly T[],
  rules: { busy(dog: T): boolean; supported(dog: T): boolean },
): { move: T[]; waiting: T[] } {
  const move: T[] = [];
  const waiting: T[] = [];
  for (const dog of dogs) {
    if (onFullEverywhere(dog) || !rules.supported(dog)) continue;
    (rules.busy(dog) ? waiting : move).push(dog);
  }
  return { move, waiting };
}
