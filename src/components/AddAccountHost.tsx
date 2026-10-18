import { useEffect, useRef, useState } from "react";
import { api, useStore, type InstanceInfo } from "@/state/store";
import { subscribeAddAccount, type AddAccountRequest } from "@/lib/add-account-request";
import { ACCOUNT_ENGINES, AddAccountSheet, pollSignedIn, signedIn, unusedDefault, type SheetStep } from "./AccountsPanel";

export function sheetFor(request: AddAccountRequest, instances: readonly InstanceInfo[]): SheetStep {
  if (request.instanceId) return { step: "signIn", instanceId: request.instanceId };
  if (!request.kind) return { step: "pick" };
  const unused = unusedDefault(instances, request.kind);
  if (unused) return { step: "signIn", instanceId: unused.instanceId };
  return ACCOUNT_ENGINES.some((engine) => engine.kind === request.kind && engine.route) ? { step: "name", kind: request.kind } : { step: "pick" };
}

export function AddAccountHost() {
  const { state, dispatch } = useStore();
  const [sheet, setSheet] = useState<SheetStep | null>(null);
  const instancesRef = useRef(state.instances);
  instancesRef.current = state.instances;

  useEffect(() => subscribeAddAccount((request) => setSheet(sheetFor(request, instancesRef.current))), []);

  const finished = async (instanceId: string) => {
    const isSignedIn = (instances: readonly InstanceInfo[]) => instances.some((candidate) => candidate.instanceId === instanceId && signedIn(candidate));
    const fetchSignedIn = async () => {
      try {
        const { instances } = await api<{ instances: InstanceInfo[] }>("/api/instances");
        dispatch({ type: "instances", instances });
        return isSignedIn(instances);
      } catch {
        return false;
      }
    };
    await pollSignedIn(() => isSignedIn(instancesRef.current), fetchSignedIn);
    setSheet((current) => (current?.step === "signIn" && current.instanceId === instanceId ? null : current));
  };

  if (!sheet) return null;
  return (
    <AddAccountSheet
      sheet={sheet}
      instances={state.instances}
      onStep={setSheet}
      onClose={() => setSheet(null)}
      onSignedIn={(instanceId) => void finished(instanceId)}
    />
  );
}
