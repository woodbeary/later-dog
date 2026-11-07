export const SAFE_STOP_GRACE_MS = 2 * 60_000;

export function safeStopWords(by: string, why?: string): string {
  return `${by}, acting for the owner, asked you to stop${why ? ` (${why})` : ""}. Stop at a safe point: if you are in the middle of a step that must not be left half done, such as publishing an app update, a merge, a push, a deploy or a migration, finish it or roll it back first. Then start nothing new, say in one line what is done and what isn't, and end your turn. If you are still working in two minutes, later.dog stops you.`;
}

export function stoppedByLine(by: string, owner: string | undefined, why?: string): string {
  return `Stopped by ${by} for ${owner || "the owner"}${why ? `: ${why}` : ""}`;
}
