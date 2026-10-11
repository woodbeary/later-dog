type OrganizationBridge = { settingsOpened?: () => Promise<unknown> };

export function acknowledgeOrganizationSettings(section: string | null | undefined, bridge: OrganizationBridge | undefined, remoteClient: boolean) {
  if (section !== "organization" || remoteClient) return;
  void bridge?.settingsOpened?.().catch(() => {});
}
