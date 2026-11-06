const GRANTS_REASON = /\b(?:Accessibility|Screen Recording)(?: and (?:Accessibility|Screen Recording))? required\b/;

export function cuaStartsAfterGrant({ platform, checklist, connection }) {
  if (platform !== "darwin") return false;
  if (checklist?.accessibility !== "granted" || checklist?.screen !== "granted") return false;
  if (!connection || connection.mode === "embedded" || connection.mode === "standalone") return false;
  return typeof connection.reason === "string" && GRANTS_REASON.test(connection.reason);
}

export const CUA_RETRY_MS = 30_000;

export function cuaRetriesForUse({ platform, checklist, connection, now, lastTry }) {
  if (platform !== "darwin") return false;
  if (checklist?.accessibility !== "granted" || checklist?.screen !== "granted") return false;
  if (connection?.mcpCommand) return false;
  return !(typeof lastTry === "number" && now - lastTry < CUA_RETRY_MS);
}

export function cuaOffReason(connection) {
  const reason = typeof connection?.reason === "string" ? connection.reason.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  return reason ? ` (${reason})` : "";
}
