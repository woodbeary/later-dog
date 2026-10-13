
export interface ControlSnapshot {
  held: boolean;
  helpReason: string | null;
  heldSinceMs: number | null;
}

export interface ControlLeaseResult {
  snapshot: ControlSnapshot;
  owned: boolean;
  acquired: boolean;
}

export interface ControlLeaseReleaseResult {
  snapshot: ControlSnapshot;
  released: boolean;
}

const NO_CONTROL: ControlSnapshot = { held: false, helpReason: null, heldSinceMs: null };
const MAX_REASON_CHARS = 280;

interface Entry {
  heldSinceMs: number | null;
  helpReason: string | null;
  helpRequestId: string | null;
  controlLeaseId: string | null;
}

export class ComputerControl {
  private entries = new Map<string, Entry>();
  private onChange: (botId: string, snapshot: ControlSnapshot) => void;
  private now: () => number;
  private requestSequence = 0;

  constructor(
    onChange: (botId: string, snapshot: ControlSnapshot) => void = () => {},
    now: () => number = Date.now,
  ) {
    this.onChange = onChange;
    this.now = now;
  }

  snapshot(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (!entry) return NO_CONTROL;
    return {
      held: entry.heldSinceMs !== null,
      helpReason: entry.helpReason,
      heldSinceMs: entry.heldSinceMs,
    };
  }

  take(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (entry?.heldSinceMs != null) return this.snapshot(botId);
    this.entries.set(botId, {
      heldSinceMs: this.now(),
      helpReason: entry?.helpReason ?? null,
      helpRequestId: entry?.helpRequestId ?? null,
      controlLeaseId: null,
    });
    return this.changed(botId);
  }

  acquireLease(botId: string, controlLeaseId: string): ControlLeaseResult {
    const entry = this.entries.get(botId);
    if (entry?.heldSinceMs != null) {
      return {
        snapshot: this.snapshot(botId),
        owned: entry.controlLeaseId === controlLeaseId,
        acquired: false,
      };
    }
    this.entries.set(botId, {
      heldSinceMs: this.now(),
      helpReason: entry?.helpReason ?? null,
      helpRequestId: entry?.helpRequestId ?? null,
      controlLeaseId,
    });
    return { snapshot: this.changed(botId), owned: true, acquired: true };
  }

  ownsLease(botId: string, controlLeaseId: string): boolean {
    const entry = this.entries.get(botId);
    return entry?.heldSinceMs != null && entry.controlLeaseId === controlLeaseId;
  }

  release(botId: string): ControlSnapshot {
    if (!this.entries.has(botId)) return NO_CONTROL;
    this.entries.delete(botId);
    return this.changed(botId);
  }

  releaseLease(botId: string, controlLeaseId: string): ControlLeaseReleaseResult {
    const entry = this.entries.get(botId);
    if (!entry || entry.heldSinceMs === null || entry.controlLeaseId !== controlLeaseId) {
      return { snapshot: this.snapshot(botId), released: false };
    }
    this.entries.delete(botId);
    return { snapshot: this.changed(botId), released: true };
  }

  requestHelp(botId: string, reason: unknown): ControlSnapshot {
    return this.requestHelpLease(botId, reason).snapshot;
  }

  requestHelpLease(botId: string, reason: unknown): { snapshot: ControlSnapshot; requestId: string } {
    const text = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON_CHARS) : "";
    const entry = this.entries.get(botId) ?? {
      heldSinceMs: null,
      helpReason: null,
      helpRequestId: null,
      controlLeaseId: null,
    };
    if (entry.helpReason === null) {
      entry.helpReason = text || "the dog asked you to take over";
      entry.helpRequestId = `${botId}-${++this.requestSequence}`;
    }
    this.entries.set(botId, entry);
    return { snapshot: this.changed(botId), requestId: entry.helpRequestId! };
  }

  restateHelpLease(botId: string, reason: unknown): { snapshot: ControlSnapshot; requestId: string } {
    const text = typeof reason === "string" ? reason.trim().slice(0, MAX_REASON_CHARS) : "";
    const entry = this.entries.get(botId);
    if (!entry || entry.helpReason === null || entry.helpRequestId === null) return this.requestHelpLease(botId, reason);
    if (!text || text === entry.helpReason) return { snapshot: this.snapshot(botId), requestId: entry.helpRequestId };
    entry.helpReason = text;
    return { snapshot: this.changed(botId), requestId: entry.helpRequestId };
  }

  dismissHelp(botId: string): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (!entry || entry.helpReason === null) return this.snapshot(botId);
    entry.helpReason = null;
    entry.helpRequestId = null;
    if (entry.heldSinceMs === null) this.entries.delete(botId);
    return this.changed(botId);
  }

  expireHelp(botId: string, requestId: unknown): ControlSnapshot {
    const entry = this.entries.get(botId);
    if (!entry || entry.helpRequestId !== requestId) return this.snapshot(botId);
    entry.helpReason = null;
    entry.helpRequestId = null;
    if (entry.heldSinceMs === null) this.entries.delete(botId);
    return this.changed(botId);
  }

  forget(botId: string): void {
    if (this.entries.delete(botId)) this.onChange(botId, NO_CONTROL);
  }

  private changed(botId: string): ControlSnapshot {
    const snapshot = this.snapshot(botId);
    this.onChange(botId, snapshot);
    return snapshot;
  }
}
