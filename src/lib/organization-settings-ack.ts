type OrganizationBridge = { settingsOpened?: () => Promise<unknown> };

export function acknowledgeOrganizationSettings(section: string | null | undefined, bridge: OrganizationBridge | undefined) {
  if (section !== "organization") return;
  void bridge?.settingsOpened?.().catch(() => {});
}
