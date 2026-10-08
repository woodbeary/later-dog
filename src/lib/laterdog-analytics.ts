// later.dog ships with no analytics project. An operator who builds with their
// own VITE_LATERDOG_ANALYTICS_TOKEN gets the Settings switch; everyone else sees
// nothing and nothing loads. This lives outside analytics.ts so a screen can ask
// "is analytics configured?" without loading the client, and without depending
// on how a test mocks it.
export const ANALYTICS_TOKEN: string = import.meta.env.VITE_LATERDOG_ANALYTICS_TOKEN ?? "";

export function analyticsConfigured(): boolean {
  return Boolean(ANALYTICS_TOKEN);
}
