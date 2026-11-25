export type SidePanels = {
  botOpen: boolean;
  roomOpen?: boolean;
  settingsOpen: boolean;
  cloudTaskOpen: boolean;
  workPanelOpen: boolean;
};

export function sidePanelOpen({ botOpen, roomOpen = false, settingsOpen, cloudTaskOpen, workPanelOpen }: SidePanels): boolean {
  return (botOpen && settingsOpen) || cloudTaskOpen || ((botOpen || roomOpen) && workPanelOpen);
}

export function foldSidebarToRail(panels: SidePanels, sidebarAndPanelFit: boolean): boolean {
  return sidePanelOpen(panels) && !sidebarAndPanelFit;
}
