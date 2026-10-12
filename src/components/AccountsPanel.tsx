import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Loader2, X } from "lucide-react";
import { api, useStore, type ConfigStatus, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { subscribeAddAccount } from "@/lib/add-account-request";
import { Switch } from "./SettingsPrimitives";
import { ClaudeMark, CodexMark } from "./ProviderIcons";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { DeviceSignIn } from "./DeviceSignIn";
import { resetClock, usageLines, usageReading, usePlanUsage, type PlanProvider } from "./PlanUsage";

type Battery = NonNullable<ConfigStatus["accountBattery"]>;
type Rest = NonNullable<Battery["resting"]>[string];
export type AccountKind = "claudeAgent" | "codex";

export const ACCOUNT_ENGINES: ReadonlyArray<{ kind: AccountKind; name: string; route: string; defaultId: string }> = [
  { kind: "claudeAgent", name: "Claude", route: "/api/instances/claude-accounts", defaultId: "claude" },
  { kind: "codex", name: "ChatGPT", route: "/api/instances/chatgpt-accounts", defaultId: "chatgpt" },
];

const DEFAULT_ACCOUNT_IDS = new Set(["claude", "chatgpt", "codex"]);

export const pill = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45";
const primary = cn(pill, "bg-accent text-white hover:bg-accent");
const ROW = "flex h-14 items-center gap-3 px-4";

export function signedIn(instance: InstanceInfo): boolean {
  return instance.snapshot.state !== "unavailable" && instance.snapshot.authenticated !== false;
}

export function subscriptionAccounts(instances: readonly InstanceInfo[], battery: Pick<Battery, "order"> | undefined): InstanceInfo[] {
  const rows: InstanceInfo[] = [];
  for (const engine of ACCOUNT_ENGINES) {
    for (const id of battery?.order?.[engine.kind] ?? []) {
      const instance = instances.find((candidate) => candidate.instanceId === id);
      if (instance && instance.driverKind === engine.kind && eligible(instance) && !rows.includes(instance)) rows.push(instance);
    }
    for (const instance of instances) {
      if (instance.driverKind !== engine.kind || rows.includes(instance)) continue;
      if (eligible(instance)) rows.push(instance);
    }
  }
  return rows;
}

function eligible(instance: InstanceInfo): boolean {
  return instance.instanceId !== "claudeApi" && !instance.readOnly && !instance.managed && !instance.policy
    && (instance.access ?? "subscription") === "subscription" && instance.snapshot.account?.method !== "api-key";
}

export function removable(instance: InstanceInfo): boolean {
  return !DEFAULT_ACCOUNT_IDS.has(instance.instanceId) && instance.claudeAccount?.isDefault !== true;
}

export function realAccount(instance: InstanceInfo): boolean {
  return signedIn(instance) || removable(instance);
}

function unusedDefault(instances: readonly InstanceInfo[], kind: AccountKind): InstanceInfo | undefined {
  const id = ACCOUNT_ENGINES.find((engine) => engine.kind === kind)?.defaultId;
  return subscriptionAccounts(instances, undefined).find((instance) =>
    instance.instanceId === id && !signedIn(instance) && instance.authentication !== undefined);
}

function rowUsage(provider: PlanProvider | undefined, rest: Rest | undefined, now: number): { text: string; detail: string } | null {
  if (rest && Date.parse(rest.until) > now) {
    const text = t("accounts.resting", { time: resetClock(rest.until, now) });
    return { text, detail: text };
  }
  const reading = usageReading(provider);
  return reading ? { text: t("planUsage.used", { used: Math.round(reading.used) }), detail: usageLines(provider, now).join("\n") } : null;
}

function useListedAccounts(accounts: readonly InstanceInfo[]) {
  const [kept, setKept] = useState<ReadonlySet<string>>(() => new Set());
  const real = accounts.filter(realAccount).map((account) => account.instanceId).join("\n");
  useEffect(() => {
    if (!real) return;
    const ids = real.split("\n");
    setKept((previous) => (ids.every((id) => previous.has(id)) ? previous : new Set([...previous, ...ids])));
  }, [real]);
  const forget = (instanceId: string) => setKept((previous) => {
    if (!previous.has(instanceId)) return previous;
    const next = new Set(previous);
    next.delete(instanceId);
    return next;
  });
  return { listed: accounts.filter((account) => realAccount(account) || kept.has(account.instanceId)), forget };
}

export function accountOrder(accounts: readonly InstanceInfo[]): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  for (const engine of ACCOUNT_ENGINES) order[engine.kind] = accounts.filter((account) => account.driverKind === engine.kind).map((account) => account.instanceId);
  return order;
}

export function shownOrder(accounts: readonly InstanceInfo[], shown: readonly string[]): Record<string, string[]> {
  const order = accountOrder(accounts);
  for (const [kind, ids] of Object.entries(order)) {
    const moved = shown.filter((id) => ids.includes(id));
    let next = 0;
    order[kind] = ids.map((id) => (moved.includes(id) ? moved[next++]! : id));
  }
  return order;
}

export async function pollSignedIn(isSignedIn: () => boolean, fetchSignedIn: () => Promise<boolean>, delays: readonly number[] = [500, 1000, 2000, 4000]): Promise<boolean> {
  if (isSignedIn()) return true;
  for (const delay of delays) {
    await new Promise<void>((done) => window.setTimeout(done, delay));
    if (await fetchSignedIn()) return true;
  }
  return false;
}

export function useCarryOn() {
  const { state, dispatch } = useStore();
  const battery = state.config?.accountBattery;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const accounts = subscriptionAccounts(state.instances, battery);
  const save = async (enabled: boolean, order: Record<string, string[]>, shown?: ConfigStatus) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    if (shown) dispatch({ type: "configStatus", config: shown });
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ accountBattery: { enabled, order } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      if (shown && state.config) dispatch({ type: "configStatus", config: state.config });
      setError(cause instanceof Error ? cause.message : t("accounts.carryOnError"));
    } finally {
      setSaving(false);
    }
  };
  const set = (enabled: boolean) => save(enabled, accountOrder(accounts));
  const reorder = async (shown: readonly string[]) => {
    if (!battery || !state.config) return;
    const order = shownOrder(accounts, shown);
    await save(battery.enabled, order, { ...state.config, accountBattery: { ...battery, order } });
  };
  return { on: battery?.enabled === true, saving, error, set, reorder, canReorder: battery !== undefined };
}

function AccountMark({ kind, size = 20 }: { kind: string; size?: number }) {
  return kind === "codex" ? <CodexMark size={size} /> : <ClaudeMark size={size} />;
}

function AccountRow({ instance, provider, rest, now, only, onSignIn, onGone }: {
  instance: InstanceInfo;
  provider: PlanProvider | undefined;
  rest: Rest | undefined;
  now: number;
  only: boolean;
  onSignIn: () => void;
  onGone: () => void;
}) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<"rename" | "remove" | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const isSignedIn = signedIn(instance);
  const email = isSignedIn ? instance.snapshot.account?.email : undefined;
  const plan = provider?.plan ?? (instance.snapshot.chatgptPlan ? "ChatGPT" : null);
  const signsOut = isSignedIn && instance.authentication?.signOut === true;
  const canRemove = removable(instance) || !isSignedIn || signsOut;
  const usage = isSignedIn ? rowUsage(provider, rest, now) : null;
  const name = instance.displayName;
  const id = encodeURIComponent(instance.instanceId);

  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    removeButton.current?.focus();
  }, [asking]);

  const rename = async () => {
    const next = draft?.trim() ?? "";
    setDraft(null);
    if (!next || next === name || busy) return;
    setBusy("rename");
    setError(null);
    try {
      const { instances } = await api<{ instances: InstanceInfo[] }>(`/api/instances/${id}`, { method: "PATCH", body: JSON.stringify({ displayName: next }) });
      dispatch({ type: "instances", instances });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setAsking(false);
    if (busy || !canRemove) return;
    setBusy("remove");
    setError(null);
    let instances: InstanceInfo[] | null = null;
    try {
      if (signsOut) instances = (await api<{ instances: InstanceInfo[] }>(`/api/instances/${id}/auth/sign-out`, { method: "POST" })).instances;
      if (removable(instance)) instances = (await api<{ instances: InstanceInfo[] }>(`/api/instances/${id}`, { method: "DELETE" })).instances;
      onGone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (instances) dispatch({ type: "instances", instances });
      setBusy(null);
    }
  };

  const cancel = () => {
    refocus.current = true;
    setAsking(false);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); void rename(); }
    if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
  };

  return (
    <li data-account={instance.instanceId}>
      <div data-account-row className={ROW}>
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink">
          <AccountMark kind={instance.driverKind} />
        </span>
        {asking ? (
          <div
            role="group"
            aria-label={t("accounts.removeTitle", { name })}
            onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); cancel(); } }}
            className="flex min-w-0 flex-1 items-center gap-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium leading-5 text-ink">{t("accounts.removeTitle", { name })}</p>
              <p className="truncate text-[12px] leading-4 text-ink-secondary">{only ? t("accounts.onlyAccount") : t("accounts.signsOutHere", { name })}</p>
            </div>
            <button type="button" autoFocus onClick={cancel} className={pill}>{t("common.cancel")}</button>
            <button type="button" onClick={() => void remove()} className={primary}>{t("accounts.remove")}</button>
          </div>
        ) : (
          <>
            <div data-account-text className="min-w-0 flex-1">
              <div className="flex h-5 items-center">
                {draft === null ? (
                  <button
                    type="button"
                    onClick={() => setDraft(name)}
                    aria-label={t("accounts.rename", { name })}
                    title={t("accounts.rename", { name })}
                    className="max-w-full truncate rounded-md text-left text-[13px] font-medium leading-5 text-ink hover:bg-control"
                  >
                    {busy === "rename" ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}{name}
                  </button>
                ) : (
                  <input
                    autoFocus
                    value={draft}
                    aria-label={t("accounts.nameLabel")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKey}
                    onBlur={() => void rename()}
                    className="h-5 w-full max-w-xs rounded-md border border-hairline/40 bg-inset px-1.5 text-[13px] text-ink outline-none focus:border-accent-border"
                  />
                )}
              </div>
              <p className="h-4 truncate text-[12px] leading-4 text-ink-secondary">
                {isSignedIn ? [email, plan].filter(Boolean).join(" · ") || t("accounts.signedIn") : t("accounts.signedOut")}
              </p>
            </div>
            {usage && (
              <span data-account-usage title={usage.detail} className="shrink-0 text-[12px] tabular-nums text-ink-secondary">{usage.text}</span>
            )}
            {!isSignedIn && (
              <button type="button" disabled={busy !== null} onClick={onSignIn} className={pill}>{t("accounts.signIn")}</button>
            )}
            {canRemove && (
              <button
                ref={removeButton}
                type="button"
                disabled={busy !== null}
                onClick={() => (only || signsOut ? setAsking(true) : void remove())}
                aria-label={t("accounts.removeLabel", { name })}
                title={t("accounts.removeLabel", { name })}
                className="ui-icon-button shrink-0"
              >
                {busy === "remove" ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
              </button>
            )}
          </>
        )}
      </div>
      {error && <p role="alert" className="pb-3 pl-15 pr-4 text-[12px] text-danger">{error}</p>}
    </li>
  );
}

export type SheetStep =
  | { step: "pick" }
  | { step: "name"; kind: AccountKind }
  | { step: "signIn"; instanceId: string };

export function AddAccountSheet({ sheet, instances, onStep, onClose, onSignedIn }: {
  sheet: SheetStep;
  instances: readonly InstanceInfo[];
  onStep: (next: SheetStep) => void;
  onClose: () => void;
  onSignedIn: (instanceId: string) => void;
}) {
  const { dispatch } = useStore();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = sheet.step === "name" ? ACCOUNT_ENGINES.find((candidate) => candidate.kind === sheet.kind) : undefined;
  const instance = sheet.step === "signIn" ? instances.find((candidate) => candidate.instanceId === sheet.instanceId) : undefined;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = name.trim();
    if (!engine || !displayName || creating) return;
    setCreating(true);
    setError(null);
    try {
      const { instanceId, instances: next } = await api<{ instanceId: string; instances: InstanceInfo[] }>(engine.route, { method: "POST", body: JSON.stringify({ displayName }) });
      dispatch({ type: "instances", instances: next });
      onStep({ step: "signIn", instanceId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const title = sheet.step === "pick" ? t("accounts.sheet.title")
    : sheet.step === "name" ? t("accounts.sheet.nameTitle", { engine: engine?.name ?? "" })
    : t("accounts.sheet.signInTitle", { name: instance?.displayName ?? "" });

  return (
    <div role="dialog" aria-modal="true" aria-label={title} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-panel p-5 text-ink shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {sheet.step === "pick" && (
          <div className="mt-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              {ACCOUNT_ENGINES.map((candidate) => (
                <button
                  key={candidate.kind}
                  type="button"
                  onClick={() => {
                    const unused = unusedDefault(instances, candidate.kind);
                    onStep(unused ? { step: "signIn", instanceId: unused.instanceId } : { step: "name", kind: candidate.kind });
                  }}
                  className="flex flex-col items-center gap-2 rounded-xl bg-card px-3 py-4 text-[13px] font-medium text-ink hover:bg-raised-hover"
                >
                  <AccountMark kind={candidate.kind} size={28} />
                  {candidate.name}
                </button>
              ))}
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={onClose} className={pill}>{t("common.cancel")}</button>
            </div>
          </div>
        )}
        {sheet.step === "name" && (
          <form className="mt-4 flex flex-col gap-3" onSubmit={(event) => void create(event)}>
            <input
              autoFocus
              value={name}
              aria-label={t("accounts.nameLabel")}
              placeholder={t("accounts.sheet.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              disabled={creating}
              className="w-full rounded-md border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent-border"
            />
            {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => onStep({ step: "pick" })} disabled={creating} className={pill}>{t("accounts.sheet.back")}</button>
              <button type="submit" disabled={creating || !name.trim()} className={primary}>
                {creating ? t("accounts.sheet.adding") : t("accounts.sheet.continue")}
              </button>
            </div>
          </form>
        )}
        {sheet.step === "signIn" && (
          <div className="mt-4">
            {!instance ? (
              <p role="alert" className="text-[13px] text-danger">{t("accounts.sheet.gone")}</p>
            ) : instance.snapshot.state !== "available" ? (
              <InstallFirst instance={instance} onCancel={onClose} />
            ) : instance.driverKind === "claudeAgent" ? (
              <ClaudeSignIn key={instance.instanceId} instanceId={instance.instanceId} autoStart compact onSignedIn={() => onSignedIn(instance.instanceId)} onCancelled={onClose} />
            ) : (
              <DeviceSignIn
                key={instance.instanceId}
                instanceId={instance.instanceId}
                browserPkce={instance.authentication?.method !== "device-code"}
                autoStart
                compact
                onSignedIn={() => onSignedIn(instance.instanceId)}
                onCancelled={onClose}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A provider whose app isn't on this computer yet: it is fetched from its
 * maker first (the server checks it), then the sign-in takes over. */
function InstallFirst({ instance, onCancel }: { instance: InstanceInfo; onCancel: () => void }) {
  const { dispatch } = useStore();
  const [error, setError] = useState<string | null>(null);
  const installable = Boolean((instance as { install?: { server?: unknown } }).install?.server);
  useEffect(() => {
    if (!installable) return;
    let cancelled = false;
    void api<{ instances?: InstanceInfo[] }>(`/api/instances/${encodeURIComponent(instance.instanceId)}/install`, { method: "POST" })
      .then(({ instances }) => { if (!cancelled && instances) dispatch({ type: "instances", instances }); })
      .catch(() => { if (!cancelled) setError(t("onboarding.engines.setupFailed", { name: instance.displayName })); });
    return () => { cancelled = true; };
  }, [instance.instanceId, installable, instance.displayName, dispatch]);
  return (
    <div className="space-y-3">
      {error || !installable ? (
        <p role="alert" className="text-[13px] text-danger">{error ?? t("onboarding.engines.unavailable")}</p>
      ) : (
        <p role="status" className="flex items-center gap-1.5 text-[13px] text-ink-secondary">
          <Loader2 size={13} className="animate-spin" /> {t("accounts.sheet.gettingReady", { name: instance.displayName })}
        </p>
      )}
      <div className="flex justify-end">
        <button type="button" onClick={onCancel} className={pill}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}

export function AccountsPanel() {
  const { state, dispatch } = useStore();
  const battery = state.config?.accountBattery;
  const { listed: accounts, forget } = useListedAccounts(subscriptionAccounts(state.instances, battery));
  const loaded = state.instances.length > 0;
  const signedInCount = accounts.filter(signedIn).length;
  const { report, now } = usePlanUsage();
  const [sheet, setSheet] = useState<SheetStep | null>(null);
  const carryOn = useCarryOn();
  const instancesRef = useRef(state.instances);
  instancesRef.current = state.instances;

  useEffect(() => subscribeAddAccount((kind) => {
    if (!kind) { setSheet({ step: "pick" }); return; }
    const unused = unusedDefault(instancesRef.current, kind);
    setSheet(unused ? { step: "signIn", instanceId: unused.instanceId } : { step: "name", kind });
  }), []);

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
    setSheet(null);
  };

  return (
    <section className="flex flex-col" data-accounts-panel>
      <div className="rounded-xl bg-card">
        {!loaded ? (
          <div aria-hidden="true" data-account-skeleton className={ROW}>
            <span className="size-8 shrink-0 rounded-lg bg-control" />
            <span className="flex min-w-0 flex-1 flex-col gap-2">
              <span className="h-3 w-24 rounded-full bg-control" />
              <span className="h-2.5 w-40 max-w-full rounded-full bg-control" />
            </span>
          </div>
        ) : accounts.length === 0 ? (
          <div data-accounts-empty className={ROW}>
            <p className="min-w-0 text-[13px] leading-5 text-ink-secondary">{t("accounts.empty")}</p>
          </div>
        ) : (
          <ul className="divide-y divide-hairline/40">
            {accounts.map((instance) => (
              <AccountRow
                key={instance.instanceId}
                instance={instance}
                provider={report?.providers.find((provider) => provider.id === instance.instanceId)}
                rest={battery?.resting?.[instance.instanceId]}
                now={now}
                only={signedIn(instance) && signedInCount === 1}
                onSignIn={() => setSheet({ step: "signIn", instanceId: instance.instanceId })}
                onGone={() => forget(instance.instanceId)}
              />
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3 border-t border-hairline/40 px-4 py-3">
          <button type="button" onClick={() => setSheet({ step: "pick" })} className={pill}>{t("accounts.add")}</button>
        </div>
        {/* switching to the next account means there is a next one */}
        {(signedInCount >= 2 || carryOn.on) && (
          <div className="flex items-center justify-between gap-3 border-t border-hairline/40 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">{t("accounts.carryOn")}</div>
              <div className="text-[12px] text-ink-secondary">{t("accounts.carryOnHint")}</div>
            </div>
            <Switch checked={carryOn.on} disabled={carryOn.saving} aria-label={t("accounts.carryOn")} onClick={() => void carryOn.set(!carryOn.on)} />
          </div>
        )}
        {carryOn.error && <p role="alert" className="px-4 pb-3 text-[12px] text-danger">{carryOn.error}</p>}
      </div>
      {sheet && (
        <AddAccountSheet sheet={sheet} instances={state.instances} onStep={setSheet} onClose={() => setSheet(null)} onSignedIn={(instanceId) => void finished(instanceId)} />
      )}
    </section>
  );
}
