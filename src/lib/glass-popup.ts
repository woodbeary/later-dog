import type { CSSProperties } from "react";
import { initialDesktopCapabilities } from "@/lib/desktop";


export const GLASS_POPUP_CHROME_TOP = 56;
export const GLASS_POPUP_GUTTER = 24;

export function glassPopupTopInset(windowChrome = initialDesktopCapabilities().windowChrome): number {
  return windowChrome === "mac-inset" || windowChrome === "win-caption" ? GLASS_POPUP_CHROME_TOP : GLASS_POPUP_GUTTER;
}

export function glassPopupFrameStyle(): CSSProperties {
  return { "--glass-popup-top": `${glassPopupTopInset()}px` } as CSSProperties;
}
