import { Check, Plus, Repeat2, Gauge } from "lucide-react";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { requestAddAccount } from "@/lib/add-account-request";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { currentTaskBot, useStore, type InstanceInfo } from "@/state/store";
import { AccountCharge } from "./AccountBattery";
import { backAt, SleepingDog, usageLeft } from "./AccountCharge";
import { accountInitials, activeRest, shownAccounts } from "./AccountSwitcher";
import { AccountUsageCard } from "./AccountUsageGlance";
import { subscriptionAccounts } from "./AccountsPanel";
import { InitialsAvatar } from "./Avatar";
import { needsCli, needsSignIn } from "./EngineSetup";
import { modelSelectionForPick } from "./ModelPicker";
import { modelForAccount } from "./account-switch";
import { usageReading, usePlanUsage, type PlanProvider } from "./PlanUsage";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";

export function weeklyUsed(provider: PlanProvider | undefined): number | null {
  if (!provider?.ok) return null;
  if (provider.weekly.available && provider.weekly.usedPercent != null) return provider.weekly.usedPercent;
  return usageReading(provider)?.used ?? null;
}

export function useAccountMenuItems(): { usage: SidebarMenuItem | null; accounts: SidebarMenuItem | null; add: SidebarMenuItem | null } {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const battery = state.config?.accountBattery;
  const bot = state.bots.find((candidate) => candidate.id === state.selectedId);
  const target = bot ? currentTaskBot(bot) : undefined;
  const routedId = target ? battery?.routed?.[target.threadId]?.on : undefined;
  const inUseId = routedId ?? target?.modelSelection.instanceId ?? "";
  const listed = shownAccounts(subscriptionAccounts(state.instances, battery), inUseId);
  const usage = usePlanUsage({ enabled: listed.length > 0 });
  const add: SidebarMenuItem | null = listed.length === 0 ? null : {
    key: "add-account",
    label: t("accounts.add"),
    icon: <Plus size={18} />,
    onSelect: () => requestAddAccount(),
  };
  const inUse = listed.find((account) => account.instanceId === inUseId);
  if (!inUse) return { usage: null, accounts: null, add };

  const provider = usage.report?.providers.find((entry) => entry.id === inUse.instanceId);
  const rest = activeRest(battery?.resting, inUse.instanceId, usage.now);
  const used = weeklyUsed(provider);
  const manage = (close: () => void) => {
    close();
    dispatch({ type: "toggleAppSettings", open: true, section: "usage" });
  };

  const usageItem: SidebarMenuItem | null = rest || used !== null ? {
    key: "account-usage",
    label: rest ? inUse.displayName : [provider?.plan, t("planUsage.weekly")].filter(Boolean).join(" · "),
    icon: rest ? <SleepingDog size={18} /> : <Gauge size={18} />,
    trailing: (
      <span data-menu-usage className="shrink-0 text-[12.5px] tabular-nums text-ink-secondary">
        {rest ? backAt(rest, usage.now) : t("planUsage.left", { left: usageLeft(used ?? 0) })}
      </span>
    ),
    submenu: (close) => (
      <AccountUsageCard name={inUse.displayName} plan={provider?.plan} provider={provider} rest={rest} now={usage.now} onManage={() => manage(close)} />
    ),
    onSelect: () => {},
  } : null;

  const driverOf = (instanceId: string) => state.instances.find((candidate) => candidate.instanceId === instanceId)?.driverKind;
  const updateBotDefault = !state.config?.cloudHome || ownerOrAdmin === true;
  const blocked = (account: InstanceInfo) => {
    if (!target || needsCli(account) || needsSignIn(account) || account.policy) return true;
    return modelSwitchNeedsAsk(approvalModeFor(target), driverOf(target.modelSelection.instanceId), account.driverKind);
  };
  const pickAccount = (account: InstanceInfo, close: () => void) => {
    close();
    if (!target || account.instanceId === target.modelSelection.instanceId || blocked(account)) return;
    const model = modelForAccount(target.modelSelection, account);
    if (!model) return;
    dispatch({ type: "setModel", botId: target.id, threadId: target.threadId, updateBotDefault,
      selection: modelSelectionForPick(target.modelSelection, account, model) });
  };

  const accountsItem: SidebarMenuItem | null = listed.length > 1 ? {
    key: "switch-account",
    label: t("accounts.switch"),
    icon: <Repeat2 size={18} />,
    separatorBefore: true,
    submenu: (close) => (
      <div data-switch-accounts className="flex w-80 flex-col p-1">
        {listed.map((account) => {
          const accountRest = activeRest(battery?.resting, account.instanceId, usage.now);
          const accountUsed = usageReading(usage.report?.providers.find((entry) => entry.id === account.instanceId))?.used ?? null;
          const current = account.instanceId === inUse.instanceId;
          const email = account.snapshot.account?.email;
          return (
            <button
              key={account.instanceId}
              type="button"
              role="menuitemradio"
              aria-checked={current}
              data-switch-account={account.instanceId}
              disabled={!current && blocked(account)}
              title={!current && blocked(account) ? t("accounts.switchFromChat") : undefined}
              onClick={() => pickAccount(account, close)}
              className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-raised-hover disabled:opacity-50 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus", current && "bg-control/60")}
            >
              <InitialsAvatar initials={accountInitials(account.displayName)} size={24} />
              <span data-switch-account-name className="flex min-w-0 flex-auto flex-col">
                <span className="truncate text-[13.5px] text-ink">{account.displayName}</span>
                {email && <span className="truncate text-[11.5px] text-ink-secondary">{email}</span>}
              </span>
              <AccountCharge used={accountUsed ?? undefined} rest={accountRest} now={usage.now} />
              <Check size={14} aria-hidden="true" className={cn("shrink-0 text-ink-secondary", !current && "invisible")} />
            </button>
          );
        })}
        <button
          type="button"
          role="menuitem"
          data-switch-add
          onClick={() => { close(); requestAddAccount(); }}
          className="mt-1 flex items-center gap-2.5 rounded-lg border-t border-hairline/40 px-2.5 py-2 text-left text-[13.5px] text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
        >
          <Plus size={16} aria-hidden="true" />
          {t("accounts.add")}
        </button>
      </div>
    ),
    onSelect: () => {},
  } : null;
  return { usage: usageItem, accounts: accountsItem, add };
}
