export type WorkStopCause = "infrastructure" | "engine" | "you";

export type WorkStopDetail = "stalled" | "closed";

export interface WorkDog {
  id: string;
  name: string;
  ask?: string;
}

export type WorkState =
  | { kind: "running"; dogs?: WorkDog[]; helpers?: number; computerJobs?: number; computerSince?: number }
  | { kind: "waiting-on-dog"; dogs: WorkDog[] }
  | { kind: "needs-you"; what?: string }
  | { kind: "waiting-for-usage"; account?: string; until?: number }
  | { kind: "waiting-for-computer"; holder?: string }
  | { kind: "retrying"; attempt?: number }
  | { kind: "stopped"; cause: WorkStopCause; detail?: WorkStopDetail }
  | { kind: "idle" };

export type WorkKind = WorkState["kind"];

export const WORK_PRIORITY: readonly WorkKind[] = [
  "needs-you", "waiting-for-usage", "waiting-on-dog", "waiting-for-computer", "retrying", "running", "stopped", "idle",
];
