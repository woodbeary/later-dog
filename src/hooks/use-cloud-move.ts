import { useEffect, useRef, useState } from "react";
import type { CloudMoveBridge, CloudMoveOverview, CloudMoveState } from "../../electron/cloud-move.mjs";

export type MoveActionKind = "start" | "dismiss";

export function useCloudMove(bridge: CloudMoveBridge | undefined) {
  const [overview, setOverview] = useState<CloudMoveOverview | null>(null);
  const [live, setLive] = useState<CloudMoveState | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const known = useRef<string | null>(null);
  const load = () => {
    const current = generation.current;
    void bridge?.state().then(next => {
      if (generation.current !== current) return;
      known.current = next.destination?.origin ?? null;
      setOverview(next);
    }).catch(() => {});
  };
  useEffect(() => {
    if (!bridge) return;
    const current = ++generation.current;
    const unsubscribe = bridge.onState(next => {
      if (generation.current !== current) return;
      const finished = next.phase === "done" || next.phase === "failed";
      if (next.destination && next.destination.origin !== known.current) {
        if (finished) load();
        return;
      }
      setLive(next);
      if (finished) load();
    });
    load();
    return () => { generation.current++; unsubscribe(); };
  }, [bridge]);
  const act = (action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(true);
    void action().catch(() => load()).finally(() => setPending(false));
  };
  const state: CloudMoveState = live ?? overview ?? { phase: "idle" };
  const run = (kind: MoveActionKind) => {
    if (!bridge) return;
    if (kind === "start") act(() => bridge.start());
    else act(() => bridge.dismiss().then(next => { setLive(null); setOverview(next); }));
  };
  return { overview, state, pending, run };
}
