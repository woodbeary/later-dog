export type NativeActorState = "running" | "waiting" | "paused" | "done" | "failed" | "stopped";
export type NativeActivityKind = "tool" | "search" | "reasoning" | "message" | "plan" | "hook" | "compaction" | "request" | "notice";

export interface NativeActor {
  id: string;
  parentId?: string;
  kind: "parent" | "subagent" | "task" | "workflow";
  label: string;
  state: NativeActorState;
  nativeId?: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  generation?: string;
  task?: string;
  activity?: string;
  summary?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  background?: boolean;
  ambient?: boolean;
  canStop?: boolean;
  usage?: { input?: number; output?: number; cost?: number };
}

export interface NativeActivity {
  id: string;
  actorId: string;
  kind: NativeActivityKind;
  label: string;
  state: NativeActorState;
  startedAt: number;
  endedAt?: number;
  input?: string;
  output?: string;
  text?: string;
  links?: Array<{ title: string; url: string }>;
  requestId?: string;
  truncated?: boolean;
}

export type NativeObservation =
  | { kind: "actor"; actor: NativeActor }
  | { kind: "activity"; activity: NativeActivity; append?: "text" | "output" }
  | { kind: "capabilities"; version?: string; limitations: string[]; handlesParentActivity?: boolean };

export interface NativeRun {
  id: string;
  threadId: string;
  turnId: string;
  botId?: string;
  provider: string;
  providerInstanceId?: string;
  providerVersion?: string;
  sessionId?: string;
  revision: number;
  startedAt: number;
  endedAt?: number;
  state: NativeActorState;
  observation: "live" | "complete" | "interrupted" | "partial";
  actors: NativeActor[];
  activityCount: number;
  failureCount: number;
  limitations: string[];
  truncated?: boolean;
  nativeActivity?: boolean;
  nativeParentActivity?: boolean;
  currentActivity?: Pick<NativeActivity, "id" | "actorId" | "kind" | "label" | "state">;
}

export interface NativeRunDetail {
  run: NativeRun;
  activities: NativeActivity[];
  nextCursor?: string;
}

export interface NativeRunList {
  runs: NativeRun[];
  historyIncomplete?: boolean;
  nextCursor?: string;
}
