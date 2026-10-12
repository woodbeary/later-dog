
export interface CloudEngine {
  computerMcp?: boolean;
}

export function canWorkOnCloud(engine: CloudEngine | undefined): boolean {
  return engine?.computerMcp === true;
}
