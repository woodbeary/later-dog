import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Loader2 } from "lucide-react";
import { api, useStore, type ConfigStatus, type InstanceInfo } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { subscribeAddAccount } from "@/lib/add-account-request";
import { Switch } from "./SettingsPrimitives";
import { ClaudeMark, CodexMark } from "./ProviderIcons";
import { ConfirmDialog } from "./ConfirmDialog";
import { ClaudeSignIn } from "./ClaudeSignIn";
import { DeviceSignIn } from "./DeviceSignIn";
import { AccountUsage, usePlanUsage, type PlanProvider } from "./PlanUsage";

type Battery = NonNullable<ConfigStatus["accountBattery"]>;
type Rest = NonNullable<Battery["resting"]>[string];
export type AccountKind = "claudeAgent" | "codex";

export const ACCOUNT_ENGINES: ReadonlyArray<{ kind: AccountKind; name: string; route: string }> = [
  { kind: "claudeAgent", name: "Claude", route: "/api/instances/claude-accounts" },
  { kind: "codex", name: "ChatGPT", route: "/api/instances/chatgpt-accounts" },
];

const DEFAULT_ACCOUNT_IDS = new Set(["claude", "chatgpt", "codex"]);

export const pill = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45";

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

export function accountOrder(accounts: readonly InstanceInfo[]): Record<string, string[]> {
  const order: Record<string, string[]> = {};
  for (const engine of ACCOUNT_ENGINES) order[engine.kind] = accounts.filter((account) => account.driverKind === engine.kind).map((account) => account.instanceId);
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

function AccountMark({ kind, size = 20 }: { kind: string; size?: number }) {
  return kind === "codex" ? <CodexMark size={size} /> : <ClaudeMark size={size} />;
}

function AccountRow({ instance, provider, loading, rest, now, onSignIn }: {
  instance: InstanceInfo;
  provider: PlanProvider | undefined;
  loading: boolean;
  rest: Rest | undefined;
  now: number;
  onSignIn: () => void;
}) {
  const { dispatch } = useStore();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<"rename" | "signOut" | "remove" | null>(null);
  const [confirm, setConfirm] = useState<"signOut" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isSignedIn = signedIn(instance);
  const email = isSignedIn ? instance.snapshot.account?.email : undefined;
  const plan = provider?.plan ?? (instance.snapshot.chatgptPlan ? "ChatGPT" : null);
  const canSignOut = isSignedIn && instance.authentication?.signOut === true;
  const id = encodeURIComponent(instance.instanceId);

  const rename = async () => {
    const name = draft?.trim() ?? "";
    setDraft(null);
    if (!name || name === instance.displayName || busy) return;
    setBusy("rename");
    setError(null);
    try {
      const { instances } = await api<{ instances: InstanceInfo[] }>(`/api/instances/${id}`, { method: "PATCH", body: JSON.stringify({ displayName: name }) });
      dispatch({ type: "instances", instances });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    setConfirm(null);
    if (busy || !canSignOut) return;
    setBusy("signOut");
    setError(null);
    try {
      const { instances } = await api<{ instances: InstanceInfo[] }>(`/api/instances/${id}/auth/sign-out`, { method: "POST" });
      dispatch({ type: "instances", instances });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setConfirm(null);
    if (busy || !removable(instance)) return;
    setBusy("remove");
    setError(null);
    try {
      const { instances } = await api<{ instances: InstanceInfo[] }>(`/api/instances/${id}`, { method: "DELETE" });
      dispatch({ type: "instances", instances });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") { event.preventDefault(); void rename(); }
    if (event.key === "Escape") { event.preventDefault(); setDraft(null); }
  };

  return (
    <li className="flex flex-col gap-2 px-4 py-3" data-account={instance.instanceId}>
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink">
          <AccountMark kind={instance.driverKind} />
        </span>
        <div className="min-w-0 flex-1">
          {draft === null ? (
            <button
              type="button"
              onClick={() => setDraft(instance.displayName)}
              aria-label={t("accounts.rename", { name: instance.displayName })}
              title={t("accounts.rename", { name: instance.displayName })}
              className="max-w-full truncate rounded-md text-left text-[13px] font-medium text-ink hover:bg-control"
            >
              {busy === "rename" ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}{instance.displayName}
            </button>
          ) : (
            <input
              autoFocus
              value={draft}
              aria-label={t("accounts.nameLabel")}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKey}
              onBlur={() => void rename()}
              className="w-full max-w-xs rounded-md border border-hairline/40 bg-inset px-2 py-0.5 text-[13px] text-ink outline-none focus:border-accent-border"
            />
          )}
          <p className="truncate text-[12px] text-ink-secondary">
            {isSignedIn ? [email, plan].filter(Boolean).join(" · ") || t("accounts.signedIn") : t("accounts.signedOut")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!isSignedIn && (
            <button type="button" onClick={onSignIn} className={pill}>{t("accounts.signIn")}</button>
          )}
          {canSignOut && (
            <button type="button" disabled={busy !== null} onClick={() => setConfirm("signOut")} className={pill}>
              {busy === "signOut" ? t("engines.account.signingOut") : t("accounts.signOut")}
            </button>
          )}
          {removable(instance) && (
            <button type="button" disabled={busy !== null} onClick={() => setConfirm("remove")} className="rounded-full px-2 py-1.5 text-[13px] font-medium text-danger/70 hover:bg-control hover:text-danger disabled:opacity-45">
              {t("accounts.remove")}
            </button>
          )}
        </div>
      </div>
      {isSignedIn && (
        <div className="pl-11">
          <AccountUsage provider={provider} loading={loading} now={now} resting={rest} />
        </div>
      )}
      {error && <p role="alert" className="pl-11 text-[12px] text-danger">{error}</p>}
      <ConfirmDialog
        open={confirm === "signOut"}
        title={t("accounts.signOutTitle", { name: instance.displayName })}
        body={t("accounts.signOutBody")}
        confirmLabel={t("accounts.signOut")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void signOut()}
      />
      <ConfirmDialog
        open={confirm === "remove"}
        title={t("accounts.removeTitle", { name: instance.displayName })}
        body={t("accounts.removeBody")}
        confirmLabel={t("accounts.remove")}
        tone="neutral"
        onCancel={() => setConfirm(null)}
        onConfirm={() => void remove()}
      />
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
                  onClick={() => onStep({ step: "name", kind: candidate.kind })}
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
              <button type="submit" disabled={creating || !name.trim()} className={cn(pill, "bg-accent text-white hover:bg-accent")}>
                {creating ? t("accounts.sheet.adding") : t("accounts.sheet.continue")}
              </button>
            </div>
          </form>
        )}
        {sheet.step === "signIn" && (
          <div className="mt-4">
            {!instance ? (
              <p role="alert" className="text-[13px] text-danger">{t("accounts.sheet.gone")}</p>
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

export function AccountsPanel() {
  const { state, dispatch } = useStore();
  const battery = state.config?.accountBattery;
  const accounts = subscriptionAccounts(state.instances, battery);
  const { report, loading, now } = usePlanUsage();
  const [sheet, setSheet] = useState<SheetStep | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const instancesRef = useRef(state.instances);
  instancesRef.current = state.instances;

  useEffect(() => subscribeAddAccount(() => setSheet({ step: "pick" })), []);

  const setCarryOn = async (enabled: boolean) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const config = await api<ConfigStatus>("/api/config", { method: "PUT", body: JSON.stringify({ accountBattery: { enabled, order: accountOrder(accounts) } }) });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("accounts.carryOnError"));
    } finally {
      setSaving(false);
    }
  };

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
        {accounts.length === 0 ? (
          <p className="px-4 py-3 text-[13px] text-ink-secondary">{t("accounts.empty")}</p>
        ) : (
          <ul className="divide-y divide-hairline/40">
            {accounts.map((instance) => (
              <AccountRow
                key={instance.instanceId}
                instance={instance}
                provider={report?.providers.find((provider) => provider.id === instance.instanceId)}
                loading={loading}
                rest={battery?.resting?.[instance.instanceId]}
                now={now}
                onSignIn={() => setSheet({ step: "signIn", instanceId: instance.instanceId })}
              />
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-3 border-t border-hairline/40 px-4 py-3">
          <button type="button" onClick={() => setSheet({ step: "pick" })} className={pill}>{t("accounts.add")}</button>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-hairline/40 px-4 py-3">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">{t("accounts.carryOn")}</div>
            <div className="text-[12px] text-ink-secondary">{t("accounts.carryOnHint")}</div>
          </div>
          <Switch checked={battery?.enabled === true} disabled={saving} aria-label={t("accounts.carryOn")} onClick={() => void setCarryOn(!(battery?.enabled === true))} />
        </div>
        {error && <p role="alert" className="px-4 pb-3 text-[12px] text-danger">{error}</p>}
      </div>
      {sheet && (
        <AddAccountSheet sheet={sheet} instances={state.instances} onStep={setSheet} onClose={() => setSheet(null)} onSignedIn={(instanceId) => void finished(instanceId)} />
      )}
    </section>
  );
}
