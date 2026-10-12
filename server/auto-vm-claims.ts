export interface AutoVmClaimOwner {
  threadId: string;
  generation: string;
}

export interface AutoVmClaimSlot {
  owner: AutoVmClaimOwner;
  claim: () => Promise<void>;
  begin?: Promise<void>;
  failed?: boolean;
  failure?: string;
  claimed?: boolean;
  lazy?: boolean;
  label?: string;
  localVm?: boolean;
  graceMs?: number;
  pendingReason?: string;
  boxId?: string;
  startsComputer?: true;
  onRejected?: (failure: string, error?: unknown) => void;
}

export type AutoVmClaimTable = Map<string, AutoVmClaimSlot>;

export function startAutoVmClaim(table: AutoVmClaimTable, threadId: string, generation: string): void {
  const slot = table.get(threadId);
  if (!slot || slot.owner.threadId !== threadId || slot.owner.generation !== generation || slot.begin) return;
  slot.begin = slot.claim().then(
    () => { slot.claimed = true; },
    (error: unknown) => {
      slot.failed = true;
      slot.failure = error instanceof Error ? error.message : String(error);
      slot.onRejected?.(slot.failure, error);
    },
  );
}

export function lazyClaimWaitMs(slot: AutoVmClaimSlot | undefined, defaultGraceMs: number): number | null {
  if (!slot?.lazy) return null;
  if (!slot.begin) return slot.graceMs ?? defaultGraceMs;
  if (slot.graceMs !== undefined && !slot.claimed && !slot.failed) return slot.graceMs;
  return null;
}
