import type { RoutineCronSchedule } from "./routine-schedule.ts";

export type RoutineRequestRunOn = "dog" | "cloud";

export interface RoutineRequestIntervalWindow {
  start: string;
  end: string;
}

export type RoutineRequestSchedule =
  | { type: "once"; at: number }
  | { type: "daily"; time: string; weekdays: number[] }
  | RoutineCronSchedule
  | {
    type: "interval";
    everyMinutes: number;
    anchorAt?: number;
    weekdays?: number[];
    window?: RoutineRequestIntervalWindow;
    endsAt?: number;
  };

export type RoutineRequestScheduleChanges =
  | Exclude<RoutineRequestSchedule, { type: "interval" }>
  | {
    type: "interval";
    everyMinutes: number;
    anchorAt?: number;
    weekdays?: number[] | null;
    window?: RoutineRequestIntervalWindow | null;
    endsAt?: number | null;
  };

export interface RoutineRequestDefinition {
  name: string;
  instructions: string;
  schedule: RoutineRequestSchedule;
  runOn: RoutineRequestRunOn;
  durationMinutes: number;
  timeoutMinutes?: number;
  continuity?: boolean;
  overlap?: "skip" | "queue";
}

export type RoutineRequestChanges =
  & Omit<Partial<RoutineRequestDefinition>, "schedule" | "timeoutMinutes">
  & {
    schedule?: RoutineRequestScheduleChanges;
    timeoutMinutes?: number | null;
  };

export interface RoutineRequestTargetBot {
  botId: string;
  name: string;
}

export type RoutineRequestOperation =
  | { action: "create"; routine: RoutineRequestDefinition; forBot?: RoutineRequestTargetBot }
  | { action: "update"; routineId: string; expectedUpdatedAt: number; changes: RoutineRequestChanges; forBot?: RoutineRequestTargetBot }
  | { action: "pause"; routineId: string; expectedUpdatedAt: number; forBot?: RoutineRequestTargetBot }
  | { action: "resume"; routineId: string; expectedUpdatedAt: number; forBot?: RoutineRequestTargetBot }
  | { action: "run_now"; routineId: string; expectedUpdatedAt: number; forBot?: RoutineRequestTargetBot }
  | { action: "delete"; routineId: string; expectedUpdatedAt: number; forBot?: RoutineRequestTargetBot };

export interface RoutineRequestSnapshot extends RoutineRequestDefinition {
  enabled: boolean;
  target?: "room-goal";
  groupId?: string;
  resultsThreadId?: string;
}

export interface RoutineRequestUndo {
  name: string;
  schedule?: RoutineRequestSchedule;
  appliedUpdatedAt?: number;
  before?: RoutineRequestSnapshot;
  ownersBefore?: boolean;
}

export interface RoutineRequestCardData {
  version: 1;
  requestId: string;
  botId: string;
  threadId: string;
  createdAt: number;
  operation: RoutineRequestOperation;
  appliedAt?: number;
  resultId?: string;
  undo?: RoutineRequestUndo;
}
