import type { AccountsNote, CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";

const RUNNING = new Set<CloudMoveState["phase"]>(["preparing", "growing", "exporting", "uploading", "checking", "replacing", "restarting"]);
const FINISHING = new Set<CloudMoveState["phase"]>(["replacing", "restarting"]);
const NO_RETRY = new Set(["shared_workspace", "same_computer", "too_large", "busy_elsewhere", "cloud_grow_unsupported", "cancelled"]);
export const DONE_LINE_MS = 10_000;

export type MoveLine =
  | { kind: "moving"; percent: number | null }
  | { kind: "finishing" }
  | { kind: "done"; accounts?: AccountsNote }
  | { kind: "accounts"; accounts: AccountsNote }
  | { kind: "kept" }
  | { kind: "failed"; retry: boolean };

export type AccountsSentence =
  | { key: "cloudMoveLine.accountsBoth" | "cloudMoveLine.accountsClaude" | "cloudMoveLine.accountsClaudeMany" | "cloudMoveLine.accountsChatgpt" }
  | { key: "cloudMoveLine.accountsStayed"; names: string };

export function accountsSentences(note: AccountsNote | undefined): AccountsSentence[] {
  if (!note) return [];
  const sentences: AccountsSentence[] = [];
  const { claude, chatgpt } = note.moved;
  if (claude > 0 && chatgpt > 0) sentences.push({ key: "cloudMoveLine.accountsBoth" });
  else if (claude > 1) sentences.push({ key: "cloudMoveLine.accountsClaudeMany" });
  else if (claude === 1) sentences.push({ key: "cloudMoveLine.accountsClaude" });
  else if (chatgpt > 0) sentences.push({ key: "cloudMoveLine.accountsChatgpt" });
  const names = [...new Set(note.stayed.filter(Boolean))];
  if (names.length) sentences.push({ key: "cloudMoveLine.accountsStayed", names: new Intl.ListFormat(undefined, { type: "conjunction" }).format(names) });
  return sentences;
}

export function moveLine(overview: Pick<CloudMoveOverview, "automatic"> | null, state: CloudMoveState): MoveLine | null {
  if (overview?.automatic !== true || state.action === "restore") return null;
  const accounts = accountsSentences(state.accounts).length ? state.accounts : undefined;
  if (RUNNING.has(state.phase)) {
    if (FINISHING.has(state.phase)) return { kind: "finishing" };
    const progress = state.progress;
    const percent = state.phase === "uploading" && progress && progress.totalBytes > 0
      ? Math.min(99, Math.floor((progress.bytesTransferred / progress.totalBytes) * 100)) : null;
    return { kind: "moving", percent };
  }
  if (state.phase === "done") return accounts ? { kind: "done", accounts } : { kind: "done" };
  if (state.phase === "idle" && accounts) return { kind: "accounts", accounts };
  if (state.phase === "failed") {
    const code = state.error?.code ?? "";
    if (code === "not_empty") return { kind: "kept" };
    if (code === "cancelled") return null;
    return { kind: "failed", retry: !NO_RETRY.has(code) };
  }
  return null;
}
