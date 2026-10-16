import type { ModelSelection } from "../../shared/wire.ts";

export interface RemovalCandidate {
  instanceId: string;
  driverKind: string;
  available: boolean;
  signedIn: boolean;
  models: readonly string[];
  defaultModel: string;
}

export interface DescribedAccount {
  instanceId: string;
  driverKind: string;
  snapshot: { state: string; authenticated?: boolean | null };
  models: { default: string; options: readonly { id: string }[] };
}

export function removalCandidateOf(account: DescribedAccount): RemovalCandidate {
  return {
    instanceId: account.instanceId,
    driverKind: account.driverKind,
    available: account.snapshot.state === "available",
    signedIn: account.snapshot.authenticated !== false,
    models: account.models.options.map((option) => option.id),
    defaultModel: account.models.default,
  };
}

export function replacementAccount(leaving: RemovalCandidate | undefined, accounts: readonly RemovalCandidate[]): RemovalCandidate | undefined {
  const ready = accounts.filter((account) => account.instanceId !== leaving?.instanceId && account.available && account.signedIn && account.defaultModel);
  return ready.find((account) => account.driverKind === leaving?.driverKind) ?? ready[0];
}

export function selectionMovedTo(selection: ModelSelection, leavingKind: string | undefined, to: RemovalCandidate): ModelSelection {
  if (to.driverKind !== leavingKind) return { instanceId: to.instanceId, model: to.defaultModel };
  return { ...selection, instanceId: to.instanceId, model: to.models.includes(selection.model) ? selection.model : to.defaultModel };
}
