const GRANTS_REASON = /\b(?:Accessibility|Screen Recording)(?: and (?:Accessibility|Screen Recording))? required\b/;

export function cuaStartsAfterGrant({ platform, remote = false, checklist, connection }) {
  if (platform !== "darwin" || remote) return false;
  if (checklist?.accessibility !== "granted" || checklist?.screen !== "granted") return false;
  if (!connection || connection.mode === "embedded" || connection.mode === "standalone") return false;
  return typeof connection.reason === "string" && GRANTS_REASON.test(connection.reason);
}
