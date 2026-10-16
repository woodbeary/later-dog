export function sameEngineAcrossAccounts(driverKindOf: (instanceId: string) => string | undefined) {
  return (saved: string, current: string): boolean => {
    if (saved === current) return true;
    const kind = driverKindOf(saved);
    return kind !== undefined && kind === driverKindOf(current);
  };
}
