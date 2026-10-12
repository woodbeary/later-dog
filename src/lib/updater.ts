import { useEffect, useState } from "react";
import type { UpdaterState } from "@/types/laterdog";

export type { UpdaterState };

export function useUpdaterState(): UpdaterState | null {
  const [state, setState] = useState<UpdaterState | null>(null);
  useEffect(() => window.laterdog?.updater?.onState(setState), []);
  return window.laterdog?.updater ? state : null;
}
