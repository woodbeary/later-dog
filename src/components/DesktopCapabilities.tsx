import { createContext, useContext, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { cacheDesktopCapabilities, initialDesktopCapabilities, loadDesktopCapabilities } from "@/lib/desktop";

type DesktopState = {
  capabilities: DesktopCapabilities;
  ready: boolean;
};

const DesktopContext = createContext<DesktopState>({
  capabilities: initialDesktopCapabilities(),
  ready: typeof window === "undefined" || !window.laterdog,
});

export function DesktopCapabilitiesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DesktopState>(() => ({
    capabilities: initialDesktopCapabilities(),
    ready: typeof window === "undefined" || !window.laterdog,
  }));

  useEffect(() => {
    let alive = true;
    let eventRevision = 0;
    const unsubscribe = window.laterdog?.onCapabilitiesChanged?.((capabilities) => {
      eventRevision += 1;
      if (alive) setState({ capabilities: cacheDesktopCapabilities(capabilities), ready: true });
    });
    const initialRevision = eventRevision;
    void loadDesktopCapabilities().then((capabilities) => {
      if (alive && eventRevision === initialRevision) {
        setState({ capabilities, ready: true });
      }
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, []);

  return <DesktopContext.Provider value={state}>{children}</DesktopContext.Provider>;
}

export function useDesktopCapabilities(): DesktopState {
  return useContext(DesktopContext);
}

export function useCaptionChrome() {
  const { capabilities } = useDesktopCapabilities();
  const windowsCaption = capabilities.windowChrome === "win-caption";
  return {
    windowsCaption,
    dragStyle: windowsCaption ? ({ WebkitAppRegion: "drag" } as CSSProperties) : undefined,
    noDragStyle: windowsCaption ? ({ WebkitAppRegion: "no-drag" } as CSSProperties) : undefined,
    controlsShiftStyle: windowsCaption
      ? ({ WebkitAppRegion: "no-drag", marginTop: "16px", marginBottom: "-16px" } as CSSProperties)
      : undefined,
    padClass: windowsCaption ? "pt-[28px]" : undefined,
  };
}
