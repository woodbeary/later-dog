import { useEffect, useId, useState } from "react";
import { Hourglass, RefreshCw } from "lucide-react";
import { api, useStore, type InstanceInfo, type Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { failedTurnCause } from "@/lib/failed-turn";
import { requestAddAccount } from "@/lib/add-account-request";
import { Switch } from "./SettingsPrimitives";
import { pill, signedIn, subscriptionAccounts, useCarryOn } from "./AccountsPanel";
import { resetClock, resetDistance } from "./PlanUsage";

function limitHeadline(kind: string | undefined, name: string): string {
  switch (kind) {
    case "session": return t("chat.limit.session", { name });
    case "daily": return t("chat.limit.daily", { name });
    case "weekly": return t("chat.limit.weekly", { name });
    case "monthly": return t("chat.limit.monthly", { name });
    case "opus": return t("chat.limit.opus", { name });
    case "sonnet": return t("chat.limit.sonnet", { name });
    default: return t("chat.limit.out", { name });
  }
}

function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function LimitRow({ tool, onRetry, botId, threadId }: {
  tool: NonNullable<Message["tool"]>;
  onRetry?: () => void;
  botId?: string;
  threadId?: string;
}) {
  const { state, dispatch } = useStore();
  const now = useNow();
  const carryOn = useCarryOn();
  const pickId = useId();
  const [pick, setPick] = useState<string>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quota = tool.quota ?? {};
  const battery = state.config?.accountBattery;
  const instance = state.instances.find((candidate) => candidate.instanceId === quota.instanceId);
  const accounts = subscriptionAccounts(state.instances, battery);
  const limited = accounts.find((account) => account.instanceId === quota.instanceId);
  const rest = quota.instanceId ? battery?.resting?.[quota.instanceId] : undefined;
  const until = rest ? (rest.estimated ? undefined : rest.until) : quota.resetsAt;
  const over = rest ? !(Date.parse(rest.until) > now) : battery && limited ? true : Boolean(until && !(Date.parse(until) > now));
  const cause = failedTurnCause(tool.name) ?? tool.name;
  const actionable = Boolean(onRetry && botId && threadId);

  const model = state.bots.find((bot) => bot.id === botId)?.modelSelection.model;
  const offers = (account: InstanceInfo) => !model || !limited?.models.options.some((option) => option.id === model)
    || account.models.options.some((option) => option.id === model);
  const resting = (account: InstanceInfo) => {
    const other = battery?.resting?.[account.instanceId];
    return Boolean(other && Date.parse(other.until) > now);
  };
  const others = limited ? accounts.filter((account) => account.driverKind === limited.driverKind && account !== limited) : [];
  const free = others.filter((account) => signedIn(account) && offers(account) && !resting(account));
  const chosen = free.find((account) => account.instanceId === pick) ?? free[0];
  const waiting = threadId ? state.pendingQueued[threadId]?.length ?? 0 : 0;

  const continueOn = async (account: InstanceInfo) => {
    if (sending || !botId || !threadId) return;
    setSending(true);
    setError(null);
    try {
      const { continued } = await api<{ continued: boolean }>(`/api/bots/${botId}/continue-on`, {
        method: "POST",
        body: JSON.stringify({ threadId, instanceId: account.instanceId }),
      });
      if (!continued) onRetry?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("chat.limit.continueError"));
    } finally {
      setSending(false);
    }
  };

  const addAccount = () => {
    dispatch({ type: "toggleAppSettings", open: true, section: "general" });
    requestAddAccount();
  };

  return (
    <div className="flex justify-start" data-limit-row="">
      <div className="w-fit max-w-[min(42rem,78%)] rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2.5 text-[13.5px] text-ink">
        <div className="flex items-start gap-2">
          <Hourglass size={15} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="break-words font-medium">{limitHeadline(quota.kind, instance?.displayName || t("chat.limit.thisAccount"))}</p>
            {actionable && (
              <p className="text-[12.5px] text-ink-secondary">
                {over ? t("chat.limit.resetDone")
                  : until ? t("chat.limit.resets", { time: resetClock(until, now), when: resetDistance(until, now) ?? t("planUsage.lessThanMinute") })
                  : t("chat.limit.resetUnknown")}
              </p>
            )}
          </div>
        </div>
        {actionable && (over || !limited ? (
          <button type="button" onClick={onRetry} className={`mt-2.5 flex items-center gap-1.5 ${pill}`}>
            <RefreshCw size={12} /> {t("chat.retry")}
          </button>
        ) : chosen ? (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            {free.length > 1 ? (
              <>
                <label htmlFor={pickId} className="text-[12.5px] text-ink-secondary">{t("chat.limit.continueOn")}</label>
                <select id={pickId} value={chosen.instanceId} disabled={sending} onChange={(event) => setPick(event.target.value)}
                  className="min-w-0 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink disabled:opacity-50">
                  {free.map((account) => <option key={account.instanceId} value={account.instanceId}>{account.displayName}</option>)}
                </select>
                <button type="button" disabled={sending} onClick={() => void continueOn(chosen)} className={pill}>
                  {sending ? t("chat.limit.continuing") : t("chat.limit.continue")}
                </button>
              </>
            ) : (
              <button type="button" disabled={sending} onClick={() => void continueOn(chosen)} className={pill}>
                {sending ? t("chat.limit.continuing") : t("chat.limit.continueOnName", { name: chosen.displayName })}
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-ink-secondary">{others.length > 0 ? t("chat.limit.noneFree") : t("chat.limit.noOther")}</span>
            <button type="button" onClick={addAccount} className={pill}>{t("accounts.add")}</button>
          </div>
        ))}
        {actionable && others.length > 0 && (
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <span className="text-[12.5px] text-ink-secondary">{t("accounts.carryOn")}</span>
            <Switch checked={carryOn.on} disabled={carryOn.saving} aria-label={t("accounts.carryOn")} onClick={() => void carryOn.set(!carryOn.on)} />
          </div>
        )}
        {actionable && waiting > 0 && <p className="mt-2 text-[12.5px] text-ink-secondary">{t("chat.limit.waiting", { count: waiting })}</p>}
        {(error ?? carryOn.error) && <p role="alert" className="mt-2 text-[12px] text-danger">{error ?? carryOn.error}</p>}
        <details className="mt-2 text-[12px] text-ink-secondary">
          <summary className="cursor-pointer">{t("chat.error.details")}</summary>
          <p className="mt-1 break-words">{cause}</p>
        </details>
      </div>
    </div>
  );
}
