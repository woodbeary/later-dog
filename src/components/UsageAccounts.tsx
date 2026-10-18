import { Loader2, RefreshCw } from "lucide-react";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { realAccount, signedIn, subscriptionAccounts } from "./AccountsPanel";
import { AccountUsage, usageLines, usePlanUsage, type PlanProvider } from "./PlanUsage";
import type { AccountRest } from "./AccountCharge";

export function usageShown(provider: PlanProvider | undefined, now: number, loading: boolean, resting: AccountRest | undefined): boolean {
  if (resting && Date.parse(resting.until) > now) return true;
  if (!provider) return loading;
  return usageLines(provider, now).length > 0;
}

export function UsageAccounts() {
  const { state } = useStore();
  const battery = state.config?.accountBattery;
  const accounts = subscriptionAccounts(state.instances, battery).filter(realAccount);
  const { report, loading, error, now, reload } = usePlanUsage();
  return (
    <section data-plan-usage="" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between pl-4">
        <h3 className="text-[12px] font-medium text-ink-secondary">{t("accounts.title")}</h3>
        <button
          type="button"
          onClick={() => void reload(true)}
          disabled={loading}
          aria-label={t("planUsage.refresh")}
          title={t("planUsage.refresh")}
          className="rounded-md p-1.5 text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-45"
        >
          {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
      </div>
      <div className="rounded-xl bg-card">
        {error && <p role="alert" className="px-4 py-3 text-[13px] text-danger">{error}</p>}
        {accounts.length === 0 && <p className="px-4 py-3 text-[13px] text-ink-secondary">{t("planUsage.empty")}</p>}
        {accounts.map((account, index) => {
          const provider = report?.providers.find((candidate) => candidate.id === account.instanceId);
          return (
            <div key={account.instanceId} data-usage-account={account.instanceId} className={cn("flex flex-col gap-2 px-4 py-3", index > 0 && "border-t border-hairline/40")}>
              <div className="flex min-w-0 items-baseline gap-2">
                <span className="truncate text-[13px] font-medium text-ink">{account.displayName}</span>
                {provider?.plan && <span className="truncate text-[12px] text-ink-secondary">{provider.plan}</span>}
              </div>
              {!signedIn(account)
                ? <p className="text-[12px] text-ink-secondary">{t("accounts.signedOut")}</p>
                : usageShown(provider, now, loading, battery?.resting?.[account.instanceId])
                  ? <AccountUsage provider={provider} loading={loading} now={now} resting={battery?.resting?.[account.instanceId]} />
                  : <p data-usage-unavailable="" className="text-[12px] text-ink-secondary">{t("planUsage.unavailable")}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
