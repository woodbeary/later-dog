
export interface ControlState {
  held: boolean;
  helpOpen: boolean;
  blockedReason?: string;
}

export interface ControlClient {
  state(fresh?: boolean): Promise<ControlState>;
  requestHelp(reason: string): Promise<string | null>;
  expireHelp(requestId: string): Promise<void>;
  readonly configured: boolean;
}

const DISENGAGED: ControlState = { held: false, helpOpen: false };
const UNAVAILABLE: ControlState = { held: true, helpOpen: false };

export function createControlClient(options?: {
  url?: string;
  token?: string;
  cacheMs?: number;
  fetchImpl?: typeof fetch;
}): ControlClient {
  const url = options?.url ?? process.env.LATERDOG_CONTROL_URL ?? "";
  const token = options?.token ?? process.env.LATERDOG_CONTROL_TOKEN ?? "";
  const cacheMs = options?.cacheMs ?? 750;
  const fetchImpl = options?.fetchImpl ?? fetch;
  const configured = Boolean(url && token);
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let cachedAt = 0;
  let cached: ControlState = DISENGAGED;

  async function read(): Promise<ControlState> {
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(2_000) });
      if (!res.ok) return UNAVAILABLE;
      const body: any = await res.json().catch(() => null);
      if (typeof body?.held !== "boolean" || typeof body?.helpOpen !== "boolean") return UNAVAILABLE;
      return {
        held: body.held,
        helpOpen: body.helpOpen,
        ...(typeof body.blockedReason === "string" && body.blockedReason.trim() ? { blockedReason: body.blockedReason } : {}),
      };
    } catch {
      return UNAVAILABLE;
    }
  }

  return {
    configured,
    async state(fresh = false): Promise<ControlState> {
      if (!configured) return DISENGAGED;
      const now = Date.now();
      if (!fresh && now - cachedAt < cacheMs) return cached;
      cached = await read();
      cachedAt = Date.now();
      return cached;
    },
    async requestHelp(reason: string): Promise<string | null> {
      if (!configured) return null;
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ reason }),
          signal: AbortSignal.timeout(2_000),
        });
        if (!res.ok) return null;
        const body: any = await res.json().catch(() => null);
        return typeof body?.requestId === "string" && body.requestId ? body.requestId : null;
      } catch {
        return null;
      }
    },
    async expireHelp(requestId: string): Promise<void> {
      if (!configured || !requestId) return;
      try {
        await fetchImpl(url, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ requestId }),
          signal: AbortSignal.timeout(2_000),
        });
      } catch {}
    },
  };
}

export const CONTROL_REFUSAL_PLAIN =
  "A person has taken control of this computer, so this call was NOT performed. " +
  "Do not retry it — the screen is changing under their hands. " +
  "Pause this task, tell the person you are waiting for them to hand control back, " +
  "and take a fresh screenshot before your next action once they have.";
