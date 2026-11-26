export type KeptSignIn = "fresh" | "renewed" | "signed-out" | "unrenewed";
export type KeepSignIn = () => Promise<KeptSignIn>;

export const ACCOUNT_KEEPER_EVERY_MS = 60_000;
export const ACCOUNT_KEEPER_RETRY_MS = 10 * 60_000;

export interface AccountKeeper {
  keep(instanceId: string, renew: KeepSignIn): Promise<KeptSignIn>;
  watch(instanceId: string, renew: KeepSignIn): () => void;
  check(): Promise<void>;
  signedOut(instanceId: string): boolean;
  onChange(listener: (instanceId: string, outcome: KeptSignIn) => void): void;
}

export function createAccountKeeper(options: { everyMs?: number; retryMs?: number; enabled?: () => boolean; now?: () => number } = {}): AccountKeeper {
  const everyMs = options.everyMs ?? ACCOUNT_KEEPER_EVERY_MS;
  const retryMs = options.retryMs ?? ACCOUNT_KEEPER_RETRY_MS;
  const now = options.now ?? Date.now;
  const failedAt = new Map<string, number>();
  const enabled = options.enabled ?? (() => true);
  const running = new Map<string, Promise<KeptSignIn>>();
  const watched = new Map<string, KeepSignIn>();
  const out = new Set<string>();
  const last = new Map<string, KeptSignIn>();
  const strikes = new Map<string, number>();
  const generation = new Map<string, number>();
  const current = (instanceId: string) => generation.get(instanceId) ?? 0;
  const listeners = new Set<(instanceId: string, outcome: KeptSignIn) => void>();
  let timer: NodeJS.Timeout | null = null;

  const record = (instanceId: string, outcome: KeptSignIn, started: number) => {
    if (started !== current(instanceId)) return outcome;
    const was = last.get(instanceId);
    const wasOut = out.has(instanceId);
    last.set(instanceId, outcome);
    if (outcome === "signed-out") {
      strikes.set(instanceId, (strikes.get(instanceId) ?? 0) + 1);
      if ((strikes.get(instanceId) ?? 0) >= 2) out.add(instanceId);
    } else if (outcome !== "unrenewed") { strikes.delete(instanceId); out.delete(instanceId); }
    if (outcome === "signed-out" || outcome === "unrenewed") failedAt.set(instanceId, now());
    else failedAt.delete(instanceId);
    const moved = wasOut !== out.has(instanceId) || (outcome !== "signed-out" && was !== outcome && !(was === undefined && outcome === "fresh"));
    if (moved) for (const listener of listeners) listener(instanceId, outcome);
    return outcome;
  };

  const keep = (instanceId: string, renew: KeepSignIn): Promise<KeptSignIn> => {
    if (!enabled()) return Promise.resolve("fresh");
    const inFlight = running.get(instanceId);
    if (inFlight) return inFlight;
    const at = current(instanceId);
    const started = Promise.resolve().then(renew).catch((): KeptSignIn => "unrenewed").then(outcome => record(instanceId, outcome, at))
      .finally(() => { if (running.get(instanceId) === started) running.delete(instanceId); });
    running.set(instanceId, started);
    return started;
  };

  const check = async () => {
    if (!enabled()) return;
    await Promise.all([...watched].filter(([instanceId]) => now() - (failedAt.get(instanceId) ?? -Infinity) >= retryMs).map(([instanceId, renew]) => keep(instanceId, renew)));
  };

  return {
    keep,
    check,
    watch(instanceId, renew) {
      watched.set(instanceId, renew);
      generation.set(instanceId, current(instanceId) + 1);
      running.delete(instanceId);
      if (!timer) {
        timer = setInterval(() => { void check(); }, everyMs);
        timer.unref?.();
      }
      return () => {
        if (watched.get(instanceId) !== renew) return;
        watched.delete(instanceId);
        out.delete(instanceId);
        last.delete(instanceId);
        failedAt.delete(instanceId);
        strikes.delete(instanceId);
        generation.set(instanceId, current(instanceId) + 1);
        running.delete(instanceId);
        if (!watched.size && timer) { clearInterval(timer); timer = null; }
      };
    },
    signedOut: instanceId => out.has(instanceId),
    onChange(listener) { listeners.add(listener); },
  };
}

export const accountKeeper = createAccountKeeper({
  enabled: () => process.env.LATERDOG_CLOUD_ROLE === "home" && process.platform === "linux",
});
