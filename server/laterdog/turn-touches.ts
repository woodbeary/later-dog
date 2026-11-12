import type { TurnResultFile, TurnResultLink, ToolTouch } from "../../shared/turn-results.ts";
import { cloudJobRecord } from "./job-receipt.ts";
import { writtenChange } from "./tool-touches.ts";

export interface ObservedTurn {
  files: TurnResultFile[];
  commands: number;
  links: TurnResultLink[];
}

const CLOUD_JOB_TOOL = /(?:^|__|[.:/])(?:delegate|correct|review|publish|inspect)_cloud_job$/;

export function pullRequestLink(toolName: string | undefined, output: string | undefined): TurnResultLink | undefined {
  if (!toolName || !CLOUD_JOB_TOOL.test(toolName)) return undefined;
  const job = cloudJobRecord(output);
  const url = typeof job?.prUrl === "string" ? job.prUrl.trim() : "";
  const title = typeof job?.title === "string" ? job.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return /^https:\/\/\S+$/.test(url) ? { kind: "pull-request", label: title || url, url } : undefined;
}

export class TurnTouches {
  private readonly pending = new Map<string, ToolTouch>();
  private readonly turns = new Map<string, ObservedTurn>();

  begin(threadId: string): void {
    this.turns.delete(threadId);
    for (const key of this.pending.keys()) if (key.startsWith(`${threadId}\0`)) this.pending.delete(key);
  }

  start(threadId: string, itemId: string | undefined, touch: ToolTouch | undefined): void {
    if (itemId && touch && (touch.command || touch.files?.length)) this.pending.set(`${threadId}\0${itemId}`, touch);
  }

  finish(threadId: string, itemId: string | undefined, done: { ok: boolean; output?: string; toolName?: string }): void {
    const key = `${threadId}\0${itemId ?? ""}`;
    const touch = itemId ? this.pending.get(key) : undefined;
    this.pending.delete(key);
    const link = done.ok ? pullRequestLink(done.toolName, done.output) : undefined;
    if (!touch && !link) return;
    const turn = this.turns.get(threadId) ?? { files: [], commands: 0, links: [] };
    if (touch?.command) turn.commands += 1;
    if (done.ok) {
      for (const file of touch?.files ?? []) {
        turn.files.push({ path: file.path, change: file.change === "written" ? writtenChange(done.output) : file.change });
      }
    }
    if (link) turn.links.push(link);
    this.turns.set(threadId, turn);
  }

  observed(threadId: string): ObservedTurn | undefined {
    return this.turns.get(threadId);
  }
}
