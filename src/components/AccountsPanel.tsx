import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, GripVertical, Loader2, RefreshCw, X } from "lucide-react";
import { api, useStore, type ConfigStatus, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { requestAccountSignIn, requestAddAccount } from "@/lib/add-account-request";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { Switch } from "./SettingsPrimitives";
import { ClaudeMark, CodexMark } from "./ProviderIcons";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { DeviceSignIn } from "./DeviceSignIn";
import { USAGE_TEXT, UsageBar, usageLines, usageReading, usageTone, usePlanUsage, type PlanProvider, resetDistance } from "./PlanUsage";
import { backAt, rechargeProgress, RechargeLine, restSummary, SleepingDog, usageLeft } from "./AccountCharge";
import { useAccountDrag, type AccountDrag } from "./account-drag";
import { MoreProviders, ProviderKeyFields, keyProviders, keyStepTitle } from "./AddAccountProviders";

type Battery = NonNullable<ConfigStatus["accountBattery"]>;
type Rest = NonNullable<Battery["resting"]>[string];
export type AccountKind = "claudeAgent" | "codex";

export const ACCOUNT_ENGINES: ReadonlyArray<{ kind: AccountKind; name: string; route: string; defaultId: string }> = [
  { kind: "claudeAgent", name: "Claude", route: "/api/instances/claude-accounts", defaultId: "claude" },
  { kind: "codex", name: "ChatGPT", route: "/api/instances/chatgpt-accounts", defaultId: "chatgpt" },
];

const DEFAULT_ACCOUNT_IDS = new Set(["claude", "chatgpt", "codex"]);

export const pill = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover disabled:opacity-45";
const primary = cn(pill, "bg-accent text-white hover:bg-accent");
const ROW = "flex min-h-16 items-center gap-3 px-4 py-3";

export function signedIn(instance: InstanceInfo): boolean {
  return instance.snapshot.state !== "unavailable" && instance.snapshot.authenticated !== false;
}

export function subscriptionAccounts(instances: readonly InstanceInfo[], battery: Pick<Battery, "order" | "sequence"> | undefined): InstanceInfo[] {
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
  const rank = new Map(battery?.sequence?.map((id, index) => [id, index]));
  return rows.sort((a, b) => (rank.get(a.instanceId) ?? rank.size) - (rank.get(b.instanceId) ?? rank.size));
}

function eligible(instance: InstanceInfo): boolean {
  return instance.instanceId !== "claudeApi" && !instance.readOnly && !instance.managed && !instance.policy
    && (instance.access ?? "subscription") === "subscription" && instance.snapshot.account?.method !== "api-key";
}

export function removable(instance: InstanceInfo): boolean {
  return !DEFAULT_ACCOUNT_IDS.has(instance.instanceId) && instance.claudeAccount?.isDefault !== true;
}

export function addedAccount(instance: InstanceInfo): boolean {
  return removable(instance) && (instance.driverKind === "claudeAgent" || instance.snapshot.chatgptPlan === true);
}

export function realAccount(instance: InstanceInfo): boolean {
  return signedIn(instance) || addedAccount(instance);
}

export function unusedDefault(instances: readonly InstanceInfo[], kind: AccountKind): InstanceInfo | undefined {
  const id = ACCOUNT_ENGINES.find((engine) => engine.kind === kind)?.defaultId;
  return subscriptionAccounts(instances, undefined).find((instance) =>
    instance.instanceId === id && !signedIn(instance) && instance.authentication !== undefined);
}

type RowUsage =
  | { text: string; detail: string; rest: Rest }
  | { text: string; detail: string; rest?: undefined; used: number; label: string };

function rowUsage(provider: PlanProvider | undefined, rest: Rest | undefined, now: number): RowUsage | null {
  if (rest && Date.parse(rest.until) > now) return { text: backAt(rest, now), detail: restSummary(rest, now), rest };
  const reading = usageReading(provider);
  return reading ? {
    text: t("planUsage.left", { left: usageLeft(reading.used) }),
    detail: usageLines(provider, now).join("\n"),
    used: reading.used,
    label: reading.label,
  } : null;
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
  const save = async (enabled: boolean, order: Record<string, string[]>, shown?: ConfigStatus, auto = battery?.auto === true, sequence = accounts.map((account) => account.instanceId)) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    if (shown) dispatch({ type: "configStatus", config: shown });
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ accountBattery: { enabled, auto, order, sequence } }) });
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
    if (!battery || !state.config || (battery.enabled && battery.auto)) return;
    const order = shownOrder(accounts, shown);
    const sequence = [...shown.filter((id) => accounts.some((account) => account.instanceId === id)), ...accounts.map((account) => account.instanceId).filter((id) => !shown.includes(id))];
    await save(battery.enabled, order, { ...state.config, accountBattery: { ...battery, order, sequence } }, false, sequence);
  };
  const setAuto = (auto: boolean) => save(battery?.enabled === true, accountOrder(accounts), undefined, auto);
  return { on: battery?.enabled === true, auto: battery?.enabled === true && battery.auto === true, saving, error, set, setAuto, reorder, canReorder: battery !== undefined && !(battery.enabled && battery.auto) };
}

function AccountMark({ kind, size = 20 }: { kind: string; size?: number }) {
  return kind === "codex" ? <CodexMark size={size} /> : <ClaudeMark size={size} />;
}

function AccountRow({ instance, provider, rest, now, only, drag, onSignIn, onGone }: {
  instance: InstanceInfo;
  provider: PlanProvider | undefined;
  rest: Rest | undefined;
  now: number;
  only: boolean;
  drag: AccountDrag;
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
  const dragRow = drag.row(instance.instanceId);

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
    <li
      data-account={instance.instanceId}
      {...dragRow}
      draggable={draft === null && !asking ? dragRow.draggable : undefined}
      className={cn("group relative", drag.dragging === instance.instanceId && "opacity-50")}
    >
      {drag.movable(instance.instanceId) && !asking && (
        <button
          type="button"
          data-account-grip
          aria-label={t("accounts.move", { name })}
          aria-keyshortcuts="ArrowUp ArrowDown"
          title={t("accounts.dragHint")}
          onKeyDown={(event) => drag.step(event, instance.instanceId, true)}
          className="absolute inset-y-0 left-0 flex w-4 cursor-grab items-center justify-center rounded-md text-ink-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus touch:opacity-100"
        >
          <GripVertical size={12} />
        </button>
      )}
      <div data-account-row className={ROW}>
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink">
          {usage && (usage.rest || usage.used >= 100) ? <SleepingDog size={25} /> : <AccountMark kind={instance.driverKind} />}
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
            <div data-account-text className="relative min-w-0 flex-1">
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
              <div data-account-meter className="mt-1 flex h-3 items-center gap-2">
                {usage?.rest ? <><RechargeLine progress={usage.rest.estimated ? null : rechargeProgress(usage.rest, now)} /><span className="text-[11px] text-ink-secondary">{t("accounts.recharging")}</span></>
                  : usage && <UsageBar used={usage.used} label={usage.label} />}
              </div>
              <p data-account-resets className="mt-1 h-4 truncate text-[11px] leading-4 text-ink-secondary">{provider?.ok ?
                ([[t("planUsage.fiveHour"), provider.fiveHour], [t("planUsage.weekly"), provider.weekly]] as const).flatMap(([label, window]) => {
                  const when = window.available ? resetDistance(window.resetsAt, now) : null;
                  return when ? [`${label} ${t("planUsage.resetsIn", { when })}`] : [];
                }).join(" · ") : ""
              }</p>
            </div>
            {usage && (
              <span
                data-account-usage
                title={usage.detail}
                className={cn("flex shrink-0 items-center gap-1.5 text-[12px] tabular-nums", usage.rest ? "text-ink-secondary" : USAGE_TEXT[usageTone(usage.used)])}
              >
                {usage.text}
              </span>
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
  | { step: "pick"; more?: boolean }
  | { step: "name"; kind: AccountKind }
  | { step: "signIn"; instanceId: string }
  | { step: "key"; instanceId: string };

export function AddAccountSheet({ sheet, instances, onStep, onClose, onSignedIn }: {
  sheet: SheetStep;
  instances: readonly InstanceInfo[];
  onStep: (next: SheetStep) => void;
  onClose: () => void;
  onSignedIn: (instanceId: string) => void;
}) {
  const { dispatch } = useStore();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useModalDialog(dialogRef, onClose);
  const stepKey = sheet.step === "pick" ? `pick:${sheet.more === true}` : sheet.step === "name" ? `name:${sheet.kind}` : `${sheet.step}:${sheet.instanceId}`;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) dialog.focus();
  }, [stepKey]);
  const engine = sheet.step === "name" ? ACCOUNT_ENGINES.find((candidate) => candidate.kind === sheet.kind) : undefined;
  const instance = sheet.step === "signIn" || sheet.step === "key" ? instances.find((candidate) => candidate.instanceId === sheet.instanceId) : undefined;
  const providers = keyProviders(instances);

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
    : sheet.step === "key" ? keyStepTitle(instance)
    : t("accounts.sheet.signInTitle", { name: instance?.displayName ?? "" });

  return createPortal(
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 outline-none sm:items-center" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-panel p-5 text-ink shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {sheet.step === "pick" && (
          <div className="mt-4 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              {ACCOUNT_ENGINES.map((candidate) => (
                <button
                  key={candidate.kind}
                  type="button"
                  data-account-engine={candidate.kind}
                  onClick={() => {
                    const unused = unusedDefault(instances, candidate.kind);
                    onStep(unused ? { step: "signIn", instanceId: unused.instanceId } : { step: "name", kind: candidate.kind });
                  }}
                  className="flex flex-col items-center gap-2 rounded-xl bg-card px-3 py-4 text-[13px] font-medium text-ink ring-1 ring-inset ring-hairline/30 transition-colors hover:bg-raised-hover hover:ring-hairline/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
                >
                  <AccountMark kind={candidate.kind} size={28} />
                  {candidate.name}
                </button>
              ))}
            </div>
            {sheet.more && providers.length > 0 && (
              <MoreProviders providers={providers} onPick={(provider) => onStep({ step: "key", instanceId: provider.instanceId })} />
            )}
            <div className="flex items-center justify-between gap-3">
              {providers.length > 0 ? (
                <button
                  type="button"
                  data-more-providers-toggle
                  aria-expanded={sheet.more === true}
                  onClick={() => onStep({ step: "pick", more: !sheet.more })}
                  className="-ml-1.5 flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] text-ink-tertiary transition-colors hover:bg-raised-hover hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
                >
                  {t("accounts.sheet.more")}
                  <ChevronDown size={13} aria-hidden="true" className={cn("transition-transform motion-reduce:transition-none", sheet.more && "rotate-180")} />
                </button>
              ) : <span />}
              <button type="button" onClick={onClose} className={pill}>{t("common.cancel")}</button>
            </div>
          </div>
        )}
        {sheet.step === "key" && (
          <div className="mt-4 flex flex-col gap-4">
            {instance ? <ProviderKeyFields instance={instance} /> : <p role="alert" className="text-[13px] text-danger">{t("accounts.sheet.gone")}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => onStep({ step: "pick", more: true })} className={pill}>{t("accounts.sheet.back")}</button>
              <button type="button" onClick={onClose} className={primary}>{t("accounts.sheet.done")}</button>
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
    </div>,
    document.body,
  );
}

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
  const { state } = useStore();
  const battery = state.config?.accountBattery;
  const { listed: accounts, forget } = useListedAccounts(subscriptionAccounts(state.instances, battery));
  const loaded = state.instances.length > 0;
  const signedInCount = accounts.filter(signedIn).length;
  const { report, now } = usePlanUsage();
  const carryOn = useCarryOn();
  const drag = useAccountDrag(
    accounts.map((instance) => ({
      id: instance.instanceId,
      kind: "account",
      movable: carryOn.canReorder && accounts.length > 1,
    })),
    (ids) => void carryOn.reorder(ids),
  );
  const rows = drag.order.flatMap((id) => accounts.filter((instance) => instance.instanceId === id));

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
          <ul className="divide-y divide-hairline/40" {...drag.list}>
            {rows.map((instance) => (
              <AccountRow
                key={instance.instanceId}
                instance={instance}
                provider={report?.providers.find((provider) => provider.id === instance.instanceId)}
                rest={battery?.resting?.[instance.instanceId]}
                now={now}
                only={signedIn(instance) && signedInCount === 1}
                drag={drag}
                onSignIn={() => requestAccountSignIn(instance.instanceId)}
                onGone={() => forget(instance.instanceId)}
              />
            ))}
          </ul>
        )}
        <div className="flex items-center gap-3 border-t border-hairline/40 px-4 py-3">
          <button type="button" data-accounts-add onClick={() => requestAddAccount()} className={pill}>{t("accounts.add")}</button>
        </div>
        {(signedInCount >= 2 || carryOn.on) && (
          <div className="flex items-center justify-between gap-3 border-t border-hairline/40 px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] text-ink">{t("accounts.carryOn")}</div>
              <div className="text-[12px] text-ink-secondary">{t("accounts.carryOnHint")}</div>
            </div>
            <Switch checked={carryOn.on} disabled={carryOn.saving} aria-label={t("accounts.carryOn")} onClick={() => void carryOn.set(!carryOn.on)} />
          </div>
        )}
        {carryOn.on && <div className="flex items-center justify-between gap-3 border-t border-hairline/40 px-4 py-3">
          <div><div className="text-[13px] text-ink">{t("accounts.mostLeft")}</div><p className="text-[12px] text-ink-secondary">{t(carryOn.auto ? "accounts.automatic" : "accounts.manualOrder")}</p></div>
          <Switch checked={carryOn.auto} disabled={carryOn.saving} aria-label={t("accounts.mostLeft")} onClick={() => void carryOn.setAuto(!carryOn.auto)} />
        </div>}
        {carryOn.error && <p role="alert" className="px-4 pb-3 text-[12px] text-danger">{carryOn.error}</p>}
      </div>
    </section>
  );
}

export function AccountsRefresh() {
  const { refreshInstances, dispatch } = useStore();
  const { loading, reload } = usePlanUsage();
  const [refreshing, setRefreshing] = useState(false);
  return <button type="button" data-accounts-refresh disabled={loading || refreshing} aria-label={t("planUsage.refresh")} title={t("planUsage.refresh")}
    onClick={() => { setRefreshing(true); void Promise.allSettled([reload(true), refreshInstances(), api<ConfigStatus>("/api/config").then((config) => dispatch({ type: "configStatus", config }))]).finally(() => setRefreshing(false)); }}
    className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-40">
    <RefreshCw size={14} className={cn((loading || refreshing) && "animate-spin motion-reduce:animate-none")} />
  </button>;
}
