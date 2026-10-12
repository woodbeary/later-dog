
export function groupTurnCwd(
  memberDefault: string | undefined,
  pinRoomCwd: () => string | null,
): string | undefined {
  if (memberDefault === undefined) return undefined;
  return pinRoomCwd() ?? memberDefault;
}
