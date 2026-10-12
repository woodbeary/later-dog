export type ConnectedAppsMode = "managed" | "self-hosted" | "unavailable";

const MANAGED_CUSTOM_AUTH_TOOLKITS = new Set(["twitter", "x"]);

export function managedConnectorUnavailableReason(
  mode: ConnectedAppsMode,
  slug: string,
): string | null {
  if (mode !== "managed" || !MANAGED_CUSTOM_AUTH_TOOLKITS.has(slug.trim().toLowerCase())) return null;
  return "Twitter/X needs your own X Developer app and Composio auth config. Use self-hosted connected apps for now.";
}
