import { useEffect, useState } from "react";

export const COLLAPSE_MS = 200;
const PAINT_MS = 20;

export interface CollapsePhase {
  mounted: boolean;
  open: boolean;
  settled: boolean;
}

export function useCollapsePhase(wanted: boolean, ms: number = COLLAPSE_MS): CollapsePhase {
  const [mounted, setMounted] = useState(wanted);
  const [open, setOpen] = useState(wanted);
  const [settled, setSettled] = useState(wanted);
  useEffect(() => {
    if (wanted) {
      setMounted(true);
      setSettled(false);
      const paint = setTimeout(() => setOpen(true), PAINT_MS);
      const done = setTimeout(() => setSettled(true), PAINT_MS + ms);
      return () => {
        clearTimeout(paint);
        clearTimeout(done);
      };
    }
    setOpen(false);
    setSettled(false);
    const gone = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(gone);
  }, [wanted, ms]);
  return { mounted: mounted || wanted, open: open && wanted, settled: settled && wanted };
}
