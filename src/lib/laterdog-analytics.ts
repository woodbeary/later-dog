export const ANALYTICS_TOKEN: string = import.meta.env.VITE_LATERDOG_ANALYTICS_TOKEN ?? "";

export function analyticsConfigured(): boolean {
  return Boolean(ANALYTICS_TOKEN);
}
