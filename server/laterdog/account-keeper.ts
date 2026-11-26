export type KeptSignIn = "fresh" | "renewed" | "signed-out" | "unrenewed";
export type KeepSignIn = () => Promise<KeptSignIn>;

export const ACCOUNT_KEEPER_EVERY_MS = 60_000;

export interface AccountKeeper {
  keep(instanceId: string, renew: KeepSignIn): Promise<KeptSignIn>;
  watch(instanceId: string, renew: KeepSignIn): () => void;
  check(): Promise<void>;
  signedOut(instanceId: string): boolean;
  onChange(listener: (instanceId: string, outcome: KeptSignIn) => void): void;
}

export function createAccountKeeper(options: { everyMs?: number; enabled?: () => boolean } = {}): AccountKeeper {
  const everyMs = options.everyMs ?? ACCOUNT_KEEPER_EVERY_MS;
  const enabled = options.enabled ?? (() => true);
  const running = new Map<string, Promise<KeptSignIn>>();
  const watched = new Map<string, KeepSignIn>();
  const out = new Set<string>();
  const last = new Map<string, KeptSignIn>();
  const listeners = new Set<(instanceId: string, outcome: KeptSignIn) => void>();
  let timer: NodeJS.Timeout | null = null;

  const record = (instanceId: string, outcome: KeptSignIn) => {
    const was = last.get(instanceId);
    last.set(instanceId, outcome);
    if (outcome === "signed-out") out.add(instanceId);
    else if (outcome !== "unrenewed") out.delete(instanceId);
    if (was !== outcome && !(was === undefined && outcome === "fresh")) for (const listener of listeners) listener(instanceId, outcome);
    return outcome;
  };

  const keep = (instanceId: string, renew: KeepSignIn): Promise<KeptSignIn> => {
    if (!enabled()) return Promise.resolve("fresh");
    const current = running.get(instanceId);
    if (current) return current;
    const started = Promise.resolve().then(renew).catch((): KeptSignIn => "unrenewed").then(outcome => record(instanceId, outcome))
      .finally(() => { if (running.get(instanceId) === started) running.delete(instanceId); });
    running.set(instanceId, started);
    return started;
  };

  const check = async () => {
    if (!enabled()) return;
    await Promise.all([...watched].map(([instanceId, renew]) => keep(instanceId, renew)));
  };

  return {
    keep,
    check,
    watch(instanceId, renew) {
      watched.set(instanceId, renew);
      if (!timer) {
        timer = setInterval(() => { void check(); }, everyMs);
        timer.unref?.();
      }
      return () => {
        if (watched.get(instanceId) !== renew) return;
        watched.delete(instanceId);
        out.delete(instanceId);
        last.delete(instanceId);
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
