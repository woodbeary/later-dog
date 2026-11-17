export type SidePanels = {
  botOpen: boolean;
  settingsOpen: boolean;
  cloudTaskOpen: boolean;
  workPanelOpen: boolean;
};

export function sidePanelOpen({ botOpen, settingsOpen, cloudTaskOpen, workPanelOpen }: SidePanels): boolean {
  return (botOpen && settingsOpen) || cloudTaskOpen || (botOpen && workPanelOpen);
}

export function foldSidebarToRail(panels: SidePanels, sidebarAndPanelFit: boolean): boolean {
  return sidePanelOpen(panels) && !sidebarAndPanelFit;
}
