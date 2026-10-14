import type { CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";

const RUNNING = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking", "replacing", "restarting"]);
const FINISHING = new Set<CloudMoveState["phase"]>(["replacing", "restarting"]);
const NO_RETRY = new Set(["shared_workspace", "same_computer", "too_large", "busy_elsewhere", "cloud_grow_unsupported", "cancelled"]);
export const DONE_LINE_MS = 10_000;

export type MoveLine =
  | { kind: "moving"; percent: number | null }
  | { kind: "finishing" }
  | { kind: "done" }
  | { kind: "kept" }
  | { kind: "failed"; retry: boolean };

export function moveLine(overview: Pick<CloudMoveOverview, "automatic"> | null, state: CloudMoveState): MoveLine | null {
  if (overview?.automatic !== true || state.action === "restore") return null;
  if (RUNNING.has(state.phase)) {
    if (FINISHING.has(state.phase)) return { kind: "finishing" };
    const progress = state.progress;
    const percent = state.phase === "uploading" && progress && progress.totalBytes > 0
      ? Math.min(99, Math.floor((progress.bytesTransferred / progress.totalBytes) * 100)) : null;
    return { kind: "moving", percent };
  }
  if (state.phase === "done") return { kind: "done" };
  if (state.phase === "failed") {
    const code = state.error?.code ?? "";
    if (code === "not_empty") return { kind: "kept" };
    if (code === "cancelled") return null;
    return { kind: "failed", retry: !NO_RETRY.has(code) };
  }
  return null;
}
