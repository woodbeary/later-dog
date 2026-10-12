export type HookCoverage = "full" | "preview" | "none";

export interface DigestFiles {
  changed: string[];
  added: string[];
  deleted: string[];
  truncated?: number;
}

export interface DigestTool {
  name: string;
  count: number;
  failed: number;
  sample?: string;
}

export interface TurnDigest {
  turnId: string;
  botId: string;
  threadId: string;
  at: number;
  durationMs: number;
  tools: DigestTool[];
  toolCalls?: number;
  toolsDropped?: number;
  files?: DigestFiles;
  memory: Array<{ path: string; kind: "created" | "updated" | "deleted" }>;
  memoryDropped?: number;
  reply: string;
  usage?: { input: number; output: number; cachedInput?: number; costUsd?: number | null };
  hookCoverage: HookCoverage;
}
