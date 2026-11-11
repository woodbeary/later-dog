export const SIDEBAR_ROW_KINDS = ["plain", "titled", "icon"] as const;

export type SidebarRowKind = (typeof SIDEBAR_ROW_KINDS)[number];

export function sidebarRowKind({ iconOnly, titled }: { iconOnly: boolean; titled: boolean }): SidebarRowKind {
  if (iconOnly) return "icon";
  return titled ? "titled" : "plain";
}
