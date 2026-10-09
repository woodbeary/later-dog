// When Accessibility and Screen Recording arrive while the app runs, the
// computer-control daemon that launch could not start (cua.mjs reads both
// without prompting and gives up quietly when one is missing) starts without a
// relaunch. main.mjs asks this on every checklist read and prompt answer.
// Pure, so it is unit tested without Electron. Only a daemon that stopped for
// want of those grants is due: one the person stopped, one that never tried,
// one whose binary is missing, a remote server's page, or any platform but
// macOS never starts from here.
const GRANTS_REASON = /\b(?:Accessibility|Screen Recording)(?: and (?:Accessibility|Screen Recording))? required\b/;

/**
 * @param {{ platform: string, remote?: boolean, checklist: { accessibility?: string, screen?: string } | null | undefined, connection: { mode?: string, reason?: unknown } | null | undefined }} input
 * @returns {boolean}
 */
export function cuaStartsAfterGrant({ platform, remote = false, checklist, connection }) {
  if (platform !== "darwin" || remote) return false;
  if (checklist?.accessibility !== "granted" || checklist?.screen !== "granted") return false;
  if (!connection || connection.mode === "embedded" || connection.mode === "standalone") return false;
  return typeof connection.reason === "string" && GRANTS_REASON.test(connection.reason);
}
