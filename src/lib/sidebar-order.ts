let order: readonly string[] = [];

export function publishSidebarOrder(ids: readonly string[]): void {
  order = ids;
}

export function sidebarOrder(): readonly string[] {
  return order;
}
