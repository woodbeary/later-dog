const DESKTOP_COMPANION_FIELD = "desktopCompanionRemote";

export const savedDesktopCompanion = credentials =>
  Boolean(credentials) && typeof credentials === "object" && Object.hasOwn(credentials, DESKTOP_COMPANION_FIELD);

export function withoutDesktopCompanion(credentials) {
  const next = { ...credentials };
  delete next[DESKTOP_COMPANION_FIELD];
  return next;
}
