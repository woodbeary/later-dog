import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight, KeyRound, Loader2, RefreshCw, Search } from "lucide-react";
import { useStore, currentTaskBot, type Bot, type InstanceInfo, type ModelSelection } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import { fitEffort } from "../../shared/effort";
import type { ModelVariantOption } from "../../shared/runtime-events";
import { filterCustomModels, partitionCustomModels, suggestedModels } from "@/lib/custom-models";
import { signedInModelInstances, isClaudeAccount, isCustomOnly, SIGN_IN_FAMILY_LABEL, signInFamily, splitEngineRail, type SignInFamily } from "@/lib/engine-rail";
import { InstanceProviderMark } from "./ProviderIcons";
import { EngineSetup, EngineUpdateNotice, needsCli, needsSignIn } from "./EngineSetup";
import { EngineGroupLabel } from "./EngineGroupLabel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ChatGptPlanStatus } from "./ChatGptPlanStatus";
import { approvalModeFor, modelSwitchNeedsAsk } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { repeatedModelLabels, SimpleModelPane } from "./SimpleModelPane";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { requestAccountSignIn, requestAddAccount } from "@/lib/add-account-request";
import { fastModeFits } from "@/lib/fast-mode";
import { ACCOUNT_MENU_WIDTH, AccountMenu, type AccountMenuRow } from "./AccountMenu";
import { modelForAccount } from "./account-switch";
import { ModelMenu, type ModelMenuGroup } from "./ModelMenu";
import { declaredEffort, effortLevelsFor, effortName, effortNote, simpleEffortLevels } from "@/lib/model-friendly";
import { t } from "@/lib/i18n";
import { COMPACT_SQUARE } from "@/lib/compact-chip";
import { subscriptionAccounts, useCarryOn } from "./AccountsPanel";
import { SleepingDog } from "./AccountCharge";
import { AccountBadge, AccountSwitcher, accountUsageLines, activeRest, shownAccounts, UsageRing, usageRingFor } from "./AccountSwitcher";
import { usePlanUsage, useRefreshAfterTurn } from "./PlanUsage";

type ModelOption = InstanceInfo["models"]["options"][number];
const COMPACT_MODEL_COUNT = 5;

function modelLabel(instance: InstanceInfo | undefined, model: string): string {
  return instance?.models.options.find((option) => option.id === model)?.label ?? model;
}

function modelProvider(instance: InstanceInfo | undefined, model: string): string | undefined {
  return instance?.models.options.find((option) => option.id === model)?.provider;
}

export function engineStatus(instance: InstanceInfo): string {
  if (needsCli(instance)) return t("model.setupRequired");
  if (needsSignIn(instance)) return t("model.signInRequired");
  return instance.snapshot.version ?? t("model.ready");
}

export const LOCAL_PROBE_TIMEOUT_MS = 5_000;

export function probeLocalModels(
  instanceId: string,
  refreshModels: (instanceId: string) => Promise<void>,
  timeoutMs = LOCAL_PROBE_TIMEOUT_MS,
): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void refreshModels(instanceId)
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
}

export function offersLocalModels(instance: InstanceInfo | undefined, localCount: number): boolean {
  if (!instance) return false;
  return localCount > 0 || (instance.driverKind === "claudeAgent" && !needsCli(instance) && !instance.policy);
}

export function EffortRow({
  bot,
  threadId,
  updateBotDefault,
  className,
  label,
  compact = false,
}: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (instance?.capabilities?.modelVariants) {
    return <ModelVariantRow bot={bot} threadId={threadId} updateBotDefault={updateBotDefault} className={className} label={label} compact={compact} />;
  }
  const levels = effortLevelsFor(instance, selection.model);
  if (!levels.length) return null;
  const name = (level: EffortLevel) => effortName(level, instance?.driverKind);
  const declared = declaredEffort(levels, instance?.models?.options.find((option) => option.id === selection.model)?.defaultEffort);
  const chosen = selection.effort ?? declared;

  if (compact) return (
    <label className={cn("flex items-center justify-between gap-3", className)}>
      {label}
      <select aria-label="Reasoning effort" value={chosen ?? ""}
        onChange={(event) => dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}),
          selection: { ...selection, effort: levels.find((level) => level === event.target.value) } })}
        className="min-w-0 max-w-[65%] rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70">
        {!declared && <option value="">{t("model.effort.auto")}</option>}
        {levels.map((level) => <option key={level} value={level}>{name(level)}</option>)}
      </select>
    </label>
  );

  return (
    <div className={className}>
      {label}
      <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Reasoning effort">
        {(declared ? levels : [undefined, ...levels]).map((level) => (
          <button
            key={level ?? "auto"}
            type="button"
            aria-pressed={chosen === level}
            title={
              level === undefined
                ? "Send no effort level and let the provider decide"
                : effortNote(level) ?? `Ask for ${name(level)} reasoning effort`
            }
            onClick={() => dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}), selection: { ...selection, effort: level } })}
            className={cn(
              "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
              chosen === level
                ? "border-accent/60 bg-control text-ink"
                : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
            )}
          >
            {level === undefined ? t("model.effort.auto") : name(level)}
          </button>
        ))}
      </div>
    </div>
  );
}

function variantLabel(option: ModelVariantOption): string {
  return option.id === "default" ? "OpenCode default" : option.label;
}

export function ModelVariantRow({ bot, threadId, updateBotDefault, className, label, compact = false, wide = false }: {
  bot: Bot;
  threadId?: string;
  updateBotDefault?: boolean;
  className?: string;
  label?: ReactNode;
  compact?: boolean;
  wide?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!instance?.capabilities?.modelVariants) return null;
  const session = state.modelVariantSessions[threadId ?? bot.threadId];
  const reported = session?.instanceId === selection.instanceId && session.model === selection.model ? session.variants : undefined;
  const options = reported?.options ?? instance.models.options.find((option) => option.id === selection.model)?.variants ?? [];
  if (!options.length && selection.variant === undefined) return null;
  const missing = selection.variant !== undefined && !options.some((option) => option.id === selection.variant);
  const unavailable = missing && reported !== undefined;
  const current = reported?.currentValue;
  const choose = (variant?: string) => {
    const { effort: _effort, variant: _variant, ...model } = selection;
    dispatch({ type: "setModel", botId: bot.id, threadId, ...(updateBotDefault ? { updateBotDefault: true } : {}),
      selection: { ...model, ...(variant !== undefined ? { variant } : {}) } });
  };
  if (compact) return (
    <div className={className}>
      <label className="flex items-center justify-between gap-3">
        {label}
        <select aria-label="Reasoning variant" disabled={bot.busy}
          value={selection.variant === undefined ? "unset" : missing ? "missing" : String(options.findIndex((option) => option.id === selection.variant))}
          onChange={(event) => choose(options[Number(event.target.value)]?.id)}
          className={cn("min-w-0 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50",
            wide ? "flex-1" : "max-w-[65%]")}>
          <option value="unset">Use session setting</option>
          {missing && <option value="missing" disabled>{selection.variant} ({unavailable ? "unavailable" : "unverified"})</option>}
          {options.map((option, index) => <option key={option.id} value={String(index)}>{variantLabel(option)}</option>)}
        </select>
      </label>
      {missing && <p className="mt-1 text-[11px] text-ink-secondary">{unavailable ? "Saved variant is unavailable. Choose another or use the session setting." : "Saved variant has not been checked in this session."}</p>}
    </div>
  );
  return (
    <div className={className}>
      {label}
      {(selection.variant === undefined || missing) && (
        <p className="mt-2 text-[12px] text-ink-secondary">
          {unavailable ? `Saved variant “${selection.variant}” is unavailable. Choose an available variant.`
            : missing ? `Saved variant “${selection.variant}” has not been checked in this session.` : "No variant selected."}
          {current !== undefined && ` Session: ${variantLabel(options.find((option) => option.id === current) ?? { id: current, label: current })}.`}
        </p>
      )}
      {selection.variant !== undefined && (
        <button type="button" disabled={bot.busy} onClick={() => choose()}
          title="Send no variant selection; OpenCode keeps its session or configured setting"
          className="mt-2 block text-[12px] text-ink-secondary underline underline-offset-2 hover:text-ink disabled:opacity-50">
          Clear variant selection
        </button>
      )}
      {options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" role="group" aria-label="Reasoning variant">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={bot.busy}
              aria-pressed={selection.variant === option.id}
              title={`Use ${variantLabel(option)} for this model`}
              onClick={() => choose(option.id)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-50",
                selection.variant === option.id ? "border-accent/60 bg-control text-ink" : "border-hairline/40 text-ink-secondary hover:bg-control/60 hover:text-ink",
              )}
            >
              {variantLabel(option)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function modelSelectionForPick(selection: ModelSelection, instance: InstanceInfo, model: string): ModelSelection {
  const next: ModelSelection = { instanceId: instance.instanceId, model };
  if (instance.instanceId === selection.instanceId) {
    if (instance.capabilities?.modelVariants) {
      if (model === selection.model && selection.variant !== undefined) next.variant = selection.variant;
    } else {
      const effort = fitEffort(effortLevelsFor(instance, model), selection.effort);
      if (effort) next.effort = effort;
    }
    if (selection.fast && fastModeFits(instance, model)) next.fast = true;
  }
  return next;
}


function ModelRow({
  option,
  current,
  defaultId,
  onPick,
}: {
  option: ModelOption;
  current: boolean;
  defaultId: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink hover:bg-control/60",
        current && "bg-control",
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="truncate">{option.label}</span>
        {option.provider && (
          <span
            className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary"
            title={t("model.provider", { name: option.provider })}
          >
            {option.provider}
          </span>
        )}
        {option.id === defaultId && (
          <span className="shrink-0 rounded bg-inset px-1.5 py-px text-[10px] text-ink-secondary">Default</span>
        )}
        {option.loaded && (
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[10px] text-accent">Loaded</span>
        )}
      </span>
      {current && <Check size={14} className="shrink-0 text-accent" />}
    </button>
  );
}

function ModelSearch({
  value,
  onChange,
  onEscape,
  local,
}: {
  value: string;
  onChange: (value: string) => void;
  onEscape: () => void;
  local: boolean;
}) {
  return (
    <div className="shrink-0 px-2 pb-2">
      <div className="flex items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 focus-within:border-focus">
        <Search size={13} className="shrink-0 text-ink-secondary" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            onEscape();
          }}
          placeholder={t("model.search")}
          aria-label={local ? t("model.searchLocal") : t("model.search")}
          className="w-full bg-transparent text-[12.5px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
      </div>
    </div>
  );
}

export type RailProvider = {
  instance: InstanceInfo;
  target: InstanceInfo;
  label: string;
  selected: boolean;
};

export function railProviders(instances: InstanceInfo[], selectedInstance: InstanceInfo | undefined,
  claudeInstance: InstanceInfo | undefined, openaiInstance: InstanceInfo | undefined) {
  const firstOf: Record<SignInFamily, InstanceInfo | undefined> = {
    claude: instances.find((instance) => isClaudeAccount(instance) && instance.claudeAccount?.isDefault)
      ?? instances.find(isClaudeAccount),
    openai: instances.find((instance) => signInFamily(instance) === "openai"),
  };
  const opensOn: Record<SignInFamily, InstanceInfo | undefined> = { claude: claudeInstance, openai: openaiInstance };
  const providers = instances.filter((instance) => {
    const family = signInFamily(instance);
    return !family || instance === firstOf[family];
  });
  const entry = (instance: InstanceInfo): RailProvider => {
    const family = signInFamily(instance);
    return {
      instance,
      target: family ? opensOn[family] ?? instance : instance,
      label: family ? SIGN_IN_FAMILY_LABEL[family] : instance.displayName,
      selected: family ? signInFamily(selectedInstance) === family : instance.instanceId === selectedInstance?.instanceId,
    };
  };
  const { subscription, api, custom } = splitEngineRail(providers);
  return { subscription: subscription.map(entry), api: api.map(entry), custom: custom.map(entry) };
}

export function ModelEngineRail({ instances, selectedInstance, claudeInstance, openaiInstance, onSelect }: {
  instances: InstanceInfo[];
  selectedInstance?: InstanceInfo;
  claudeInstance?: InstanceInfo;
  openaiInstance?: InstanceInfo;
  onSelect: (instance: InstanceInfo) => void;
}) {
  const { subscription, api, custom: local } = railProviders(instances, selectedInstance, claudeInstance, openaiInstance);
  const railButton = ({ instance, target, selected, label }: RailProvider) => {
    const attention = needsCli(target) || needsSignIn(target) || Boolean(target.snapshot.update);
    const managedBy = target.policy ? t("policy.managedBy", { organization: target.policy.organizationName }) : undefined;
    return (
      <button
        type="button"
        key={instance.instanceId}
        onClick={() => onSelect(target)}
        aria-label={managedBy ? `${label} · ${managedBy}` : label}
        aria-pressed={selected}
        title={`${label} · ${managedBy ?? engineStatus(target)}`}
        className={cn("relative flex size-9 items-center justify-center rounded-lg", selected ? "bg-control ring-1 ring-hairline/50" : "hover:bg-control/60", managedBy && "opacity-40")}
      >
        <InstanceProviderMark instance={target} size={18} />
        {target.access === "api" && (
          <span data-rail-key-badge className="absolute bottom-0 left-0 flex size-3.5 items-center justify-center rounded-full bg-panel text-ink-secondary">
            <KeyRound size={9} aria-hidden="true" />
          </span>
        )}
        {attention && <span className="absolute bottom-0.5 right-0.5 size-1.5 rounded-full bg-warning ring-2 ring-panel" />}
      </button>
    );
  };
  return (
    <div className="flex w-14 shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/40 bg-panel p-2">
      {subscription.length > 0 && <EngineGroupLabel className="px-0 pb-0.5 pt-0.5 text-center text-[9px]">{t("model.rail.cloud")}</EngineGroupLabel>}
      {subscription.map(railButton)}
      {api.length > 0 && <EngineGroupLabel className={cn("px-0 pb-0.5 text-center text-[9px] leading-tight", subscription.length > 0 ? "pt-2" : "pt-0.5")}>{t("model.rail.apiKeys")}</EngineGroupLabel>}
      {api.map(railButton)}
      {local.length > 0 && <EngineGroupLabel className="px-0 pb-0.5 pt-2 text-center text-[9px]">{t("model.rail.local")}</EngineGroupLabel>}
      {local.map(railButton)}
    </div>
  );
}

export function ClaudeAccountSelect({ accounts, selectedId, onSelect }: {
  accounts: InstanceInfo[];
  selectedId: string;
  onSelect: (instance: InstanceInfo) => void;
}) {
  return (
    <label className="mt-2 flex min-w-0 items-center gap-2 text-[12px] text-ink-secondary">
      <span>{t("model.account")}:</span>
      <select
        aria-label={t("model.account")}
        value={selectedId}
        onChange={(event) => {
          const account = accounts.find((instance) => instance.instanceId === event.target.value);
          if (account) onSelect(account);
        }}
        className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-2 py-1.5 text-[12px] text-ink focus:border-accent/60 focus:outline-none"
      >
        {accounts.map((account) => <option key={account.instanceId} value={account.instanceId}>{account.displayName}</option>)}
      </select>
    </label>
  );
}

const POPOVER_WIDTH = 420;
export const SIMPLE_POPOVER_WIDTH = 380;
export const MODEL_MENU_WIDTH = 240;
const SIMPLE_SEARCH_AFTER = 12;

export function ModelPicker({
  bot,
  threadId,
  className,
  contained = false,
  above = false,
  part,
  label,
}: {
  bot: Bot;
  threadId?: string;
  className?: string;
  contained?: boolean;
  above?: boolean;
  part?: "account" | "model";
  label?: ReactNode;
}) {
  const { state, dispatch, refreshInstances, refreshModels: refreshInstanceModels } = useStore();
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const [railId, setRailId] = useState<string | null>(null);
  const [pane, setPane] = useState<"main" | "custom">("main");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [probingLocal, setProbingLocal] = useState<string | null>(null);
  const ownerOrAdmin = useOwnerOrAdmin();
  const simpleUpdatesBotDefault = !state.config?.cloudHome || ownerOrAdmin === true;
  const [fullView, setFullView] = useState(false);
  const [page, setPage] = useState<"accounts" | "models">("accounts");
  const [cameBack, setCameBack] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<{ botId: string; threadId: string;
    selection: ModelSelection; updateBotDefault: boolean; name: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ left: number; maxHeight: number }>();
  const refreshingRef = useRef(false);
  const lastClaudeIdRef = useRef<string | null>(null);
  const lastOpenaiIdRef = useRef<string | null>(null);

  const simpleView = !fullView;
  const popoverWidth = part === "account" ? ACCOUNT_MENU_WIDTH : part === "model" ? MODEL_MENU_WIDTH
    : simpleView ? SIMPLE_POPOVER_WIDTH : POPOVER_WIDTH;
  useLayoutEffect(() => {
    if (!open || contained) return;
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(popoverWidth, window.innerWidth - 32);
      const left = above ? Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)) : Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16));
      setPlacement({ left: left - rect.left,
        maxHeight: Math.max(0, Math.min(600, above ? rect.top - 24 : window.innerHeight - rect.bottom - 24)) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, contained, popoverWidth, above]);

  const selection = bot.modelSelection;
  const active = state.instances.find((instance) => instance.instanceId === selection.instanceId);
  const pickerInstances = signedInModelInstances(state.instances, selection.instanceId);
  const battery = state.config?.accountBattery;
  const routed = battery?.routed?.[threadId ?? bot.threadId];
  const inUse = state.instances.find((instance) => instance.instanceId === routed?.on) ?? active;
  const switcherAccounts = subscriptionAccounts(state.instances, battery)
    .filter((account) => pickerInstances.some((instance) => instance.instanceId === account.instanceId));
  const usage = usePlanUsage({ enabled: simpleUpdatesBotDefault && switcherAccounts.length > 0 });
  const carryOn = useCarryOn();
  useRefreshAfterTurn(bot.busy);
  const selectedVariantLabel = selection.variant === undefined ? undefined : variantLabel(
    active?.models.options.find((option) => option.id === selection.model)?.variants?.find((option) => option.id === selection.variant)
      ?? { id: selection.variant, label: selection.variant },
  );
  const accountRank = new Map(switcherAccounts.map((account, index) => [account.instanceId, index]));
  const byAccountOrder = (accounts: InstanceInfo[]) => [...accounts].sort((a, b) =>
    (accountRank.get(a.instanceId) ?? accountRank.size) - (accountRank.get(b.instanceId) ?? accountRank.size));
  const claudeAccounts = byAccountOrder(pickerInstances.filter(isClaudeAccount));
  const openaiAccounts = byAccountOrder(pickerInstances.filter((instance) => signInFamily(instance) === "openai"));
  const openaiRailInstance = openaiAccounts.find((instance) => instance.instanceId === lastOpenaiIdRef.current)
    ?? openaiAccounts.find((instance) => instance.instanceId === selection.instanceId) ?? openaiAccounts[0];
  const multipleClaudeAccounts = state.instances.filter(isClaudeAccount).length > 1;
  const showActiveAccount = (multipleClaudeAccounts && isClaudeAccount(active)) || Boolean(active?.snapshot.chatgptPlan);
  const claudeRailInstance = claudeAccounts.find((instance) => instance.instanceId === lastClaudeIdRef.current)
    ?? claudeAccounts.find((instance) => instance.instanceId === selection.instanceId) ?? claudeAccounts[0];
  const railInstance =
    pickerInstances.find((instance) => instance.instanceId === (railId ?? selection.instanceId)) ?? pickerInstances[0];
  const displayedInstanceId = railInstance?.instanceId;
  const hasOfficialModels = Boolean(railInstance?.snapshot.chatgptPlan || railInstance?.models.options.some((option) => !option.custom));
  const customOnly = isCustomOnly(railInstance);
  useEffect(() => {
    if (railId !== null && railId !== displayedInstanceId) {
      setPane(customOnly || !hasOfficialModels ? "custom" : "main");
      setQuery("");
      setShowAll(false);
    } else if (customOnly || !hasOfficialModels) {
      setPane("custom");
    }
  }, [railId, displayedInstanceId, hasOfficialModels, customOnly]);

  const refreshLocalInstances = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    void refreshInstances()
      .catch(() => {})
      .finally(() => {
        refreshingRef.current = false;
        setRefreshing(false);
      });
  }, [refreshInstances]);

  const refreshModels = useCallback(() => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const instanceId = displayedInstanceId;
    void refreshInstances()
      .then(() => instanceId ? refreshInstanceModels(instanceId) : undefined)
      .catch(() => {})
      .finally(() => {
        refreshingRef.current = false;
        setRefreshing(false);
      });
  }, [displayedInstanceId, refreshInstanceModels, refreshInstances]);

  useEffect(() => {
    if (open) refreshLocalInstances();
  }, [open, refreshLocalInstances]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const clickedNode = event.target instanceof Node ? event.target : null;
      if (!rootRef.current?.contains(clickedNode)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (query) setQuery("");
      else if (!simpleView && pane === "custom" && railInstance?.models.options.some((option) => !option.custom)) setPane("main");
      else setOpen(false);
    };
    window.addEventListener("mousedown", closeOnOutsideClick);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsideClick);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, pane, query, railInstance, simpleView]);

  const resetList = () => {
    setQuery("");
    setShowAll(false);
  };

  const openFor = (instance: InstanceInfo | undefined) => {
    const official = instance?.models.options.filter((option) => !option.custom) ?? [];
    const selectedIsCustom = instance?.models.options.some(
      (option) => option.id === selection.model && option.custom,
    );
    setPane(selectedIsCustom || isCustomOnly(instance) || (official.length === 0 && !instance?.snapshot.chatgptPlan) ? "custom" : "main");
    resetList();
  };

  const lookForLocal = (instance: InstanceInfo) => {
    if (needsCli(instance) || instance.policy || probingLocal === instance.instanceId) return;
    setProbingLocal(instance.instanceId);
    void probeLocalModels(instance.instanceId, refreshInstanceModels).then(() =>
      setProbingLocal((current) => (current === instance.instanceId ? null : current)));
  };

  const openLocalModels = (instance: InstanceInfo) => {
    setPane("custom");
    resetList();
    lookForLocal(instance);
  };

  const selectRail = (instance: InstanceInfo) => {
    if (isClaudeAccount(instance)) lastClaudeIdRef.current = instance.instanceId;
    if (signInFamily(instance) === "openai") lastOpenaiIdRef.current = instance.instanceId;
    setRailId(instance.instanceId);
    const official = instance.models.options.filter((option) => !option.custom);
    setPane(isCustomOnly(instance) || (official.length === 0 && !instance.snapshot.chatgptPlan) ? "custom" : "main");
    resetList();
  };

  const profile = state.bots.find((candidate) => candidate.id === bot.id) ?? bot;
  const pick = (instance: InstanceInfo, model: string, keepOpen = false) => {
    if (instance.policy) return;
    const nextSelection = modelSelectionForPick(selection, instance, model);
    const updateBotDefault = !threadId || simpleUpdatesBotDefault;
    const targets = updateBotDefault ? [currentTaskBot(profile, threadId ?? bot.threadId), profile] : [bot];
    if (targets.some((target) => modelSwitchNeedsAsk(approvalModeFor(target),
      state.instances.find((candidate) => candidate.instanceId === target.modelSelection.instanceId)?.driverKind,
      instance.driverKind))) {
      setPendingSwitch({ botId: bot.id, threadId: threadId ?? bot.threadId,
        selection: nextSelection, updateBotDefault, name: modelLabel(instance, model) });
      setOpen(false);
      return;
    }
    dispatch({
      type: "setModel",
      botId: bot.id,
      threadId: threadId ?? bot.threadId,
      updateBotDefault,
      selection: nextSelection,
    });
    if (!keepOpen) setOpen(false);
  };

  const official = railInstance?.models.options.filter((option) => !option.custom) ?? [];
  const custom = railInstance?.models.options.filter((option) => option.custom) ?? [];
  const currentModel = selection.instanceId === railInstance?.instanceId ? selection.model : undefined;
  const filteredOfficial = filterCustomModels(official, query);
  const compactOfficial = railInstance
    ? suggestedModels(official, railInstance.models.default, currentModel, COMPACT_MODEL_COUNT)
    : [];
  const shownOfficial = query ? filteredOfficial : showAll ? official : compactOfficial;
  const filteredCustom = filterCustomModels(custom, query);
  const { pinned, rest } = partitionCustomModels(filteredCustom);
  const blocked = railInstance
    ? pane === "custom"
      ? needsCli(railInstance)
      : needsCli(railInstance) || needsSignIn(railInstance)
    : false;
  const canOpenCustom = Boolean(railInstance && !needsCli(railInstance));
  const canReturnToOfficial = official.length > 0 && !isCustomOnly(railInstance);
  const lookingForLocal = Boolean(railInstance && probingLocal === railInstance.instanceId);
  const lookingForLocalStatus = (
    <span role="status" className="flex items-center justify-center gap-2">
      <Loader2 size={12} className="animate-spin" aria-hidden="true" />
      {t("model.lookingLocal")}
    </span>
  );

  const simpleOpensOn = (accounts: InstanceInfo[], lastId: string | null) =>
    accounts.find((account) => account.instanceId === lastId)
      ?? accounts.find((account) => account.instanceId === selection.instanceId)
      ?? accounts.find((account) => !needsCli(account) && !needsSignIn(account))
      ?? accounts[0];
  const simpleProviders = (() => {
    const groups = railProviders(pickerInstances, railInstance,
      simpleOpensOn(claudeAccounts, lastClaudeIdRef.current), simpleOpensOn(openaiAccounts, lastOpenaiIdRef.current));
    return [...groups.subscription, ...groups.api, ...groups.custom];
  })();
  const simpleFamily = signInFamily(railInstance);
  const simpleAccounts = simpleFamily === "claude" ? claudeAccounts : simpleFamily === "openai" ? openaiAccounts : [];
  const simpleLabel = simpleProviders.find((provider) => provider.selected)?.label ?? railInstance?.displayName ?? "";
  const simpleSignIn = !customOnly && needsSignIn(railInstance);
  const railSignsIn = Boolean(railInstance?.authentication && !railInstance.policy);
  const simpleOfficial = customOnly || (simpleSignIn && part !== "model") ? [] : official;
  const simpleLocal = partitionCustomModels(custom);
  const simpleAll = [...simpleOfficial, ...simpleLocal.pinned, ...simpleLocal.rest];
  const simpleSetup = Boolean(railInstance && (railInstance.policy || needsCli(railInstance) || (simpleSignIn && simpleAll.length === 0)));
  const simpleSuggested = railInstance
    ? suggestedModels(simpleAll, railInstance.models.default, currentModel, COMPACT_MODEL_COUNT)
    : [];
  const simpleOpened = [...simpleSuggested, ...simpleAll.filter((option) => !simpleSuggested.includes(option))];
  const simpleSearch = showAll && simpleAll.length > SIMPLE_SEARCH_AFTER;
  const simpleQuery = simpleSearch ? query : "";
  const simpleModels = simpleQuery ? filterCustomModels(simpleOpened, simpleQuery) : showAll ? simpleOpened : simpleSuggested;
  const lookForLocalIn = (instance: InstanceInfo) => {
    if (offersLocalModels(instance, instance.models.options.filter((option) => option.custom).length)) lookForLocal(instance);
  };
  const browseSimple = (instance: InstanceInfo) => {
    selectRail(instance);
    lookForLocalIn(instance);
  };
  const switchAccount = (account: InstanceInfo) => {
    browseSimple(account);
    if (account.instanceId === selection.instanceId || needsCli(account) || needsSignIn(account)) return;
    const model = [selection.model, account.models.default].find((id) => account.models.options.some((option) => option.id === id))
      ?? account.models.options.find((option) => !option.custom)?.id;
    if (model) pick(account, model, true);
  };
  const signedInNow = (instance: InstanceInfo) => !instance.policy && !needsCli(instance) && !needsSignIn(instance);
  const signsInFromPicker = (instance: InstanceInfo) => Boolean(instance.authentication) && !instance.policy && !signedInNow(instance);
  const familyMembers = (provider: (typeof simpleProviders)[number]) => {
    const family = signInFamily(provider.instance);
    return family === "claude" ? claudeAccounts : family === "openai" ? openaiAccounts : [provider.target];
  };
  const accountRows: AccountMenuRow[] = simpleProviders.flatMap((provider) => {
    const shown = familyMembers(provider).filter((member) => signedInNow(member) || member.instanceId === selection.instanceId);
    const ordered = shown.filter((member) => accountRank.has(member.instanceId));
    return shown.map((member) => ({
      instance: member,
      label: member.displayName,
      selected: member.instanceId === selection.instanceId,
      inUse: Boolean(routed && member.instanceId === routed.on),
      provider: usage.report?.providers.find((entry) => entry.id === member.instanceId),
      rest: activeRest(battery?.resting, member.instanceId, usage.now),
      movable: carryOn.canReorder && !carryOn.saving && ordered.includes(member)
        && switcherAccounts.length > 1,
      signIn: signsInFromPicker(member),
    }));
  }).sort((a, b) => (accountRank.get(a.instance.instanceId) ?? accountRank.size) - (accountRank.get(b.instance.instanceId) ?? accountRank.size));
  const chooseAccount = (account: InstanceInfo) => {
    setOpen(false);
    if (signsInFromPicker(account)) {
      requestAccountSignIn(account.instanceId);
      return;
    }
    if (account.instanceId === selection.instanceId) return;
    const model = modelForAccount(selection, account);
    if (model) pick(account, model);
  };
  const menuModels = (instance: InstanceInfo) => {
    const own = instance.models.options.filter((option) => !option.custom);
    return own.length > 0 ? own : instance.models.options;
  };
  const inUseGroup: ModelMenuGroup[] = simpleProviders.flatMap((provider) => {
    const chosen = familyMembers(provider).find((member) => member.instanceId === selection.instanceId);
    const models = chosen ? menuModels(chosen) : [];
    return chosen && models.length > 0 ? [{ instance: chosen, label: provider.label, models }] : [];
  });
  const modelGroups: ModelMenuGroup[] = inUseGroup.length > 0 ? inUseGroup : simpleProviders.flatMap((provider) => {
    const members = familyMembers(provider);
    const instance = [provider.target, ...members].find(signedInNow);
    if (!instance) return [];
    const models = menuModels(instance);
    return models.length > 0 ? [{ instance, label: provider.label, models }] : [];
  });
  const showSwitcher = simpleView && shownAccounts(switcherAccounts, selection.instanceId).length > 1;
  const manage = () => {
    setOpen(false);
    dispatch({ type: "toggleAppSettings", open: true, section: "general" });
  };
  const activeLevels = effortLevelsFor(active, selection.model);
  const shownEffort = fitEffort(activeLevels, selection.effort)
    ?? declaredEffort(activeLevels, active?.models?.options.find((option) => option.id === selection.model)?.defaultEffort);
  const shownEffortName = shownEffort ? effortName(shownEffort, active?.driverKind) : undefined;
  const simpleEffort = activeLevels.length > 0 ? {
    levels: simpleEffortLevels(activeLevels, shownEffort),
    current: shownEffort,
    driverKind: active?.driverKind,
    onPick: (level: EffortLevel) => dispatch({ type: "setModel", botId: bot.id, threadId,
      ...(threadId && simpleUpdatesBotDefault ? { updateBotDefault: true } : {}), selection: { ...selection, effort: level } }),
  } : null;

  const renderRow = (option: ModelOption) => (
    <ModelRow
      key={option.id}
      option={option}
      current={selection.instanceId === railInstance?.instanceId && selection.model === option.id}
      defaultId={railInstance?.models.default ?? ""}
      onPick={() => railInstance && pick(railInstance, option.id)}
    />
  );

  const shownModel = selection.instanceId ? modelLabel(active, selection.model) : t("model.choose");
  const summary = active
    ? `${active.displayName} · ${modelLabel(active, selection.model)}${
        modelProvider(active, selection.model) ? ` · ${modelProvider(active, selection.model)}` : ""
      }${selectedVariantLabel ? ` · ${selectedVariantLabel}` : shownEffortName ? ` · ${shownEffortName} effort` : ""}`
    : shownModel;
  const chosenDepth = selectedVariantLabel ?? shownEffortName;
  const activeProvider = usage.report?.providers.find((provider) => provider.id === inUse?.instanceId);
  const activeRestNow = inUse ? activeRest(battery?.resting, inUse.instanceId, usage.now) : undefined;
  const ring = inUse && switcherAccounts.some((account) => account.instanceId === inUse.instanceId)
    ? usageRingFor(activeProvider, activeRestNow, usage.now) : null;
  const activeUsage = ring ? accountUsageLines(activeProvider, activeRestNow, usage.now) : [];
  const activeFamily = signInFamily(active);
  const namedAccount = (activeFamily === "claude" ? claudeAccounts : activeFamily === "openai" ? openaiAccounts : []).length > 1;

  const trigger = (
    <button data-tour="model"
      type="button"
      onClick={() => {
        if (active && isClaudeAccount(active)) lastClaudeIdRef.current = active.instanceId;
        if (active && signInFamily(active) === "openai") lastOpenaiIdRef.current = active.instanceId;
        const initial = pickerInstances.find((instance) => instance.instanceId === selection.instanceId) ?? pickerInstances[0];
        setRailId(initial?.instanceId ?? null);
        setOpen((wasOpen) => {
          const next = !wasOpen;
          if (next) {
            openFor(initial);
            setFullView(false);
            setPage(part === "model" ? "models" : "accounts");
            setCameBack(false);
          }
          return next;
        });
      }}
      aria-expanded={open}
      aria-haspopup="dialog"
      className={cn(
        "flex items-center gap-1.5 rounded-full border border-hairline/40 bg-control/60 py-1 pl-2 pr-2.5 text-[13px] text-ink hover:bg-control-hover",
        !contained && active && (!showActiveAccount || part === "account") && COMPACT_SQUARE,
        part === "model" && "border-transparent bg-transparent pl-2",
      )}
      title={[routed && inUse ? t("accounts.runningOn", { name: inUse.displayName }) : summary, ...activeUsage].join("\n")}
    >
      {inUse && part === "account" && (namedAccount || routed) ? <AccountBadge instance={inUse} ring={ring} />
        : active && part !== "model" && (ring ? (
          <UsageRing {...ring}>{ring.charging || ring.sleeping ? <SleepingDog size={16} /> : <InstanceProviderMark instance={inUse ?? active} size={14} />}</UsageRing>
        ) : <InstanceProviderMark instance={active} size={14} />)}
      {!contained && active && showActiveAccount && part === undefined && (
        <span data-model-account-compact className="hidden max-w-20 truncate @max-4xl/chathead:inline">{active.displayName}</span>
      )}
      {part !== "account" && <span className={cn("flex min-w-0 items-center gap-1", !contained && active && part !== "model" && "@max-4xl/chathead:hidden")}>
        <span className="flex min-w-0 max-w-[240px] items-baseline">
          {active && showActiveAccount && (
            <>
              <span data-model-account className="min-w-[2ch] max-w-[120px] shrink-[4] truncate text-ink-secondary">{active.displayName}</span>
              <span aria-hidden="true" className="shrink-0 whitespace-pre text-ink-secondary"> · </span>
            </>
          )}
          <span className="min-w-0 max-w-[160px] truncate">
            {shownModel}
            {active && modelProvider(active, selection.model) && (
              <span className="text-ink-secondary"> · {modelProvider(active, selection.model)}</span>
            )}
          </span>
        </span>
        {part === "model" ? null : selectedVariantLabel !== undefined ? (
          <span data-model-variant className="max-w-[120px] truncate text-ink-secondary">· {selectedVariantLabel}</span>
        ) : shownEffortName && (
          <span data-model-effort className="shrink-0 text-ink-secondary">
            · {shownEffortName}
          </span>
        )}
      </span>}
      {part === undefined && <ChevronDown
        size={14}
        className={cn(
          "text-ink-secondary transition-transform",
          open && "rotate-180",
          !contained && active && part !== "model" && "@max-4xl/chathead:hidden",
        )}
      />}
    </button>
  );

  return (
    <div ref={rootRef} className={cn(contained ? "w-full" : "relative", className)}>
      {contained ? (
        <div className="flex items-center justify-between gap-4">
          {label}
          {trigger}
        </div>
      ) : (
        trigger
      )}

      {motion.shown && (
        <div
          data-model-picker-content
          role="dialog"
          aria-label={t("model.choose")}
          {...motion.exitProps}
          style={contained ? undefined : { ...placement, width: popoverWidth }}
          className={cn(
            "flex flex-col rounded-menu border border-hairline/50 bg-card", part === "model" || part === "account" ? "overflow-visible" : "overflow-hidden",
            contained
              ? "relative mt-3 w-full max-h-[min(420px,50dvh)]"
              : cn("absolute z-30 max-w-[calc(100vw-2rem)] max-h-[min(600px,calc(100dvh-7rem))] shadow-popover", above ? "bottom-full mb-2 origin-bottom-right" : "right-0 top-full mt-2 origin-top-right"),
            motion.className,
          )}
        >
          {bot.busy && (
            <p data-model-next-reply className="shrink-0 border-b border-hairline/40 px-3 py-2 text-[12px] text-ink-secondary">{t("model.nextReply")}</p>
          )}
          {part === "account" ? (
            <>
              <AccountMenu rows={accountRows} auto={carryOn.auto} now={usage.now} onSettings={() => { setOpen(false); dispatch({ type: "toggleAppSettings", open: true, section: "general" }); }} onPick={chooseAccount} onReorder={(ids) => void carryOn.reorder(ids)} onAdd={() => {
                setOpen(false);
                requestAddAccount();
              }} />
            </>
          ) : part === "model" ? (
            <ModelMenu
              groups={modelGroups}
              currentInstanceId={selection.instanceId}
              currentModel={selection.model}
              onPick={(instance, model) => pick(instance, model)}
            />
          ) : showSwitcher && page === "accounts" && part !== "model" ? (
            <div data-model-accounts className="flex min-h-0 flex-col overflow-y-auto">
              <AccountSwitcher accounts={switcherAccounts} currentId={selection.instanceId} report={usage.report}
                now={usage.now} resting={battery?.resting} onPick={switchAccount} />
              {part !== "account" && <button type="button" data-model-line autoFocus={cameBack} onClick={() => setPage("models")}
                className="flex shrink-0 items-center gap-2 border-t border-hairline/40 px-3 py-2.5 text-left hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
                <span className="shrink-0 text-[12px] font-medium text-ink-secondary">{t("model.simple.model")}</span>
                <span className="min-w-0 flex-1 truncate text-right text-[13px] text-ink">
                  {shownModel}
                  {chosenDepth && <span className="text-ink-secondary"> · {chosenDepth}</span>}
                </span>
                <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
              </button>}
              <div className="flex shrink-0 justify-end border-t border-hairline/40 px-3 py-1.5">
                <button type="button" data-model-manage onClick={manage}
                  className="-mr-1 flex shrink-0 items-center gap-0.5 rounded-lg px-1 py-1 text-[12px] font-medium text-accent-text hover:bg-control/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                  {t("model.simple.manage")}
                  <ChevronRight size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : (
          <>
          {showSwitcher && part !== "model" && (
            <button type="button" data-model-back autoFocus onClick={() => { setPage("accounts"); setCameBack(true); }}
              className="flex shrink-0 items-center gap-1 border-b border-hairline/40 px-2 py-2 text-left text-[12px] font-medium text-ink-secondary hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus">
              <ChevronLeft size={14} aria-hidden="true" />
              {t("accounts.title")}
            </button>
          )}
          <div className="flex min-h-0 min-w-0 flex-1">
          {simpleView ? (
            <SimpleModelPane
              providers={simpleProviders}
              onProvider={browseSimple}
              managedBy={railInstance?.policy?.organizationName ?? null}
              modelsOnly={part === "model"}
              needsSetup={part !== "model" && railInstance && simpleSetup ? { name: simpleAccounts.length > 1 ? railInstance.displayName : simpleLabel, signIn: railSignsIn } : null}
              signIn={part !== "model" && railInstance && simpleSignIn && !simpleSetup ? { name: simpleLabel } : null}
              onSignIn={railInstance && railSignsIn ? () => {
                setOpen(false);
                requestAccountSignIn(railInstance.instanceId);
              } : undefined}
              onSetUp={() => {
                if (simpleSignIn && hasOfficialModels) setPane("main");
                setFullView(true);
              }}
              models={simpleModels}
              repeatedLabels={repeatedModelLabels(simpleAll)}
              query={simpleQuery}
              showAll={simpleAll.length > simpleSuggested.length && !simpleQuery ? {
                count: simpleAll.length,
                open: showAll,
                onToggle: () => {
                  if (showAll) {
                    resetList();
                    return;
                  }
                  setShowAll(true);
                  if (railInstance) lookForLocalIn(railInstance);
                },
              } : null}
              onRefresh={refreshModels}
              refreshing={refreshing}
              search={simpleSearch ? (
                <ModelSearch
                  value={query}
                  local={simpleOfficial.length === 0}
                  onChange={setQuery}
                  onEscape={() => (query ? setQuery("") : setOpen(false))}
                />
              ) : undefined}
              currentModelId={currentModel}
              onPick={(model) => railInstance && pick(railInstance, model)}
              variantsRow={active?.capabilities?.modelVariants ? (
                <ModelVariantRow compact wide bot={bot} threadId={threadId} updateBotDefault={Boolean(threadId) && simpleUpdatesBotDefault}
                  label={<span className="shrink-0 text-[12px] font-medium text-ink-secondary">{t("model.simple.reasoning")}</span>} />
              ) : undefined}
              effort={simpleEffort}
              onManage={manage}
            />
          ) : (
          <>
          {pickerInstances.length > 0 && <ModelEngineRail instances={pickerInstances} selectedInstance={railInstance} claudeInstance={claudeRailInstance} openaiInstance={openaiRailInstance} onSelect={selectRail} />}

          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
            {railInstance ? (
              <>
                <div className="shrink-0 px-4 pb-2 pt-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="truncate text-[14px] font-semibold text-ink">{signInFamily(railInstance) ? SIGN_IN_FAMILY_LABEL[signInFamily(railInstance)!] : railInstance.displayName}</div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        data-model-refresh
                        disabled={refreshing}
                        onClick={refreshModels}
                        aria-label={
                          refreshing
                            ? t("model.refreshing", { name: railInstance.displayName })
                            : t("model.refresh", { name: railInstance.displayName })
                        }
                        title={t("model.refreshTitle")}
                        className="flex size-6 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink disabled:cursor-wait disabled:opacity-70"
                      >
                        {refreshing ? (
                          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                        ) : (
                          <RefreshCw size={12} aria-hidden="true" />
                        )}
                      </button>
                      <span
                        className={cn(
                          "shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                          blocked ? "bg-warning/10 text-warning" : "bg-success/10 text-success",
                        )}
                      >
                        {pane === "custom" && !blocked && railInstance.access !== "api" ? t("model.localModels") : engineStatus(railInstance)}
                      </span>
                    </div>
                  </div>
                  {isClaudeAccount(railInstance) && claudeAccounts.length > 1 && (
                    <ClaudeAccountSelect accounts={claudeAccounts} selectedId={railInstance.instanceId} onSelect={selectRail} />
                  )}
                  {signInFamily(railInstance) === "openai" && openaiAccounts.length > 1 && (
                    <ClaudeAccountSelect accounts={openaiAccounts} selectedId={railInstance.instanceId} onSelect={selectRail} />
                  )}
                  {railInstance.snapshot.authenticated && railInstance.snapshot.account && (
                    <p className="mt-1 truncate text-[11px] text-ink-secondary" title={[railInstance.snapshot.account.email, railInstance.snapshot.account.organization].filter(Boolean).join(" · ")}>
                      {[railInstance.snapshot.account.email, railInstance.snapshot.account.organization].filter(Boolean).join(" · ")}
                    </p>
                  )}
                  {railInstance.snapshot.chatgptPlan && railInstance.snapshot.authenticated && (
                    <ChatGptPlanStatus key={railInstance.instanceId} instanceId={railInstance.instanceId} />
                  )}
                  {railInstance.access === "api"
                    ? <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("model.apiKeyHint")}</div>
                    : pane === "custom" && <div className="mt-0.5 text-[11.5px] text-ink-secondary">{t("model.localHint")}</div>}
                </div>

                {pane === "custom" && canReturnToOfficial && (
                  <button
                    type="button"
                    onClick={() => {
                      setPane("main");
                      resetList();
                    }}
                    className="mx-2 mb-1 flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-control/60"
                  >
                    <ChevronLeft size={13} /> {t("model.backTo", { name: railInstance.displayName })}
                  </button>
                )}

                {railInstance.policy ? (
                  <div data-policy-blocked className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1 text-[12.5px] leading-relaxed text-ink-secondary">
                    <p className="font-medium text-ink">{t("policy.managedBy", { organization: railInstance.policy.organizationName })}</p>
                    <p className="mt-1">{t("policy.modelBlocked", { organization: railInstance.policy.organizationName })}</p>
                  </div>
                ) : blocked ? (
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1">
                    <EngineSetup instance={railInstance} intent={pane === "custom" ? "inject" : "cloud"} />
                    {railInstance.claudeAccount && needsSignIn(railInstance) && pane !== "custom" && (
                      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-secondary">
                        {railInstance.claudeAccount.signInShell === "powershell" && `${t("engines.account.powershell")} `}
                        {t("engines.account.signInHint")}
                      </p>
                    )}
                    <p className="mt-2 text-center text-[11.5px] text-ink-tertiary">
                      {railInstance.snapshot.chatgptPlan ? t("engineSetup.chatgpt.modelsAfterSignIn") : pane === "main" && official.length > 0
                        ? official.length === 1
                          ? t("model.afterSetupOne")
                          : t("model.afterSetupMany", { count: official.length })
                        : t("model.localSoon")}
                    </p>
                  </div>
                ) : (
                  <>
                    {((pane === "main" && official.length > COMPACT_MODEL_COUNT) ||
                      (pane === "custom" && custom.length > COMPACT_MODEL_COUNT)) && (
                      <ModelSearch
                        value={query}
                        local={pane === "custom"}
                        onChange={(value) => {
                          setQuery(value);
                          if (value) setShowAll(true);
                        }}
                        onEscape={() => {
                          if (query) setQuery("");
                          else if (pane === "custom" && canReturnToOfficial) setPane("main");
                        }}
                      />
                    )}

                    <div data-model-list className="min-h-[min(180px,30dvh)] flex-1 overflow-y-auto px-2 pb-2">
                      {pane === "main" ? (
                        <>
                          {railInstance.snapshot.update && (
                            <EngineUpdateNotice update={railInstance.snapshot.update} instance={railInstance} className="mx-1 mb-2" />
                          )}
                          <EngineGroupLabel className="px-2 pb-1 pt-0.5">
                            {query
                              ? t("model.results", { count: filteredOfficial.length })
                              : showAll
                                ? t("model.allModels", { count: official.length })
                                : t("model.suggested")}
                          </EngineGroupLabel>
                          {shownOfficial.map(renderRow)}
                          {shownOfficial.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              {t("model.noMatch", { query: query.trim() })}
                            </div>
                          )}
                          {!query && !showAll && official.length > compactOfficial.length && (
                            <button
                              type="button"
                              onClick={() => setShowAll(true)}
                              className="mt-1 flex w-full items-center justify-between rounded-lg border-t border-hairline/40 px-2.5 py-2 text-[12.5px] font-medium text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              {t("model.showAll", { count: official.length })} <ChevronDown size={13} />
                            </button>
                          )}
                          {!query && showAll && official.length > COMPACT_MODEL_COUNT && (
                            <button
                              type="button"
                              onClick={() => setShowAll(false)}
                              className="mt-1 w-full rounded-lg px-2.5 py-2 text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink"
                            >
                              {t("model.showSuggested")}
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {lookingForLocal && custom.length > 0 && (
                            <div className="flex px-2 pb-1.5 pt-0.5 text-[11.5px] text-ink-secondary">{lookingForLocalStatus}</div>
                          )}
                          {pinned.length > 0 && (
                            <EngineGroupLabel className="px-2 pb-1 pt-0.5">{t("model.loadedNow")}</EngineGroupLabel>
                          )}
                          {pinned.map(renderRow)}
                          {pinned.length > 0 && rest.length > 0 && (
                            <div className="mx-2 my-2 border-t border-hairline/40" role="separator" />
                          )}
                          {rest.map(renderRow)}
                          {custom.length === 0 && (
                            <div className="mx-1 rounded-xl border border-dashed border-hairline/50 px-3 py-5 text-center">
                              {lookingForLocal ? (
                                <div className="text-[12.5px] text-ink-secondary">{lookingForLocalStatus}</div>
                              ) : (
                                <>
                                  <div className="text-[12.5px] font-medium text-ink">{t("model.noLocal")}</div>
                                  <div className="mt-1 text-[11.5px] leading-relaxed text-ink-secondary">
                                    {t("model.noLocalHint")}
                                  </div>
                                </>
                              )}
                            </div>
                          )}
                          {custom.length > 0 && filteredCustom.length === 0 && (
                            <div className="px-2 py-5 text-center text-[12.5px] text-ink-secondary">
                              {t("model.noMatch", { query: query.trim() })}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}

                {!contained && (
                  <EffortRow
                    compact
                    bot={bot}
                    threadId={threadId}
                    updateBotDefault={Boolean(threadId) && simpleUpdatesBotDefault}
                    className="shrink-0 border-t border-hairline/40 px-4 py-2"
                    label={<span className="text-[12.5px] font-medium text-ink">{active?.capabilities?.modelVariants ? "Reasoning" : "Effort"}</span>}
                  />
                )}

                {pane === "main" && offersLocalModels(railInstance, custom.length) && (
                  <button
                    type="button"
                    data-model-local-entry
                    aria-label={
                      custom.length > 0
                        ? t("model.useLocalCount", { count: custom.length })
                        : t("model.useLocal")
                    }
                    disabled={!canOpenCustom}
                    onClick={() => openLocalModels(railInstance)}
                    className="flex w-full shrink-0 items-center justify-between gap-2 border-t border-hairline/40 px-4 py-3 text-left text-[12.5px] font-medium text-ink hover:bg-control/60 disabled:cursor-not-allowed disabled:text-ink-secondary/40 disabled:hover:bg-transparent"
                  >
                    <span>{t("model.useLocal")}</span>
                    <span className="flex items-center gap-2">
                      {custom.length > 0 && (
                        <span className="rounded-full bg-inset px-2 py-0.5 text-[10.5px] text-ink-secondary">
                          {t("model.available", { count: custom.length })}
                        </span>
                      )}
                      <ChevronRight size={14} className="text-ink-secondary" />
                    </span>
                  </button>
                )}
              </>
            ) : (
              <div className="px-4 py-5 text-[13px] text-ink-secondary">{t("model.noProviders")}</div>
            )}
            <div className="flex shrink-0 border-t border-hairline/40">
              <button type="button" onClick={() => {
                setOpen(false);
                dispatch({ type: "toggleAppSettings", open: true, section: "general" });
              }} className="flex-1 px-4 py-2 text-left text-[12px] text-ink-secondary hover:bg-control/60 hover:text-ink">
                {t("settings.engines.title")}
              </button>
            </div>
          </div>
          </>
          )}
          </div>
          </>
          )}
        </div>
      )}
      <ConfirmDialog
        open={pendingSwitch !== null}
        title={t("model.providerSwitch.title")}
        body={t(pendingSwitch?.updateBotDefault ? "model.providerSwitch.botBody" : "model.providerSwitch.threadBody", {
          model: pendingSwitch?.name ?? "",
        })}
        tone="neutral"
        confirmLabel={t("model.providerSwitch.confirm")}
        onCancel={() => setPendingSwitch(null)}
        onConfirm={() => {
          if (!pendingSwitch || pendingSwitch.botId !== bot.id || pendingSwitch.threadId !== (threadId ?? bot.threadId)) {
            setPendingSwitch(null); return;
          }
          dispatch({ type: "setModel", botId: pendingSwitch.botId, threadId: pendingSwitch.threadId,
            selection: pendingSwitch.selection, updateBotDefault: pendingSwitch.updateBotDefault,
            resetApprovalToAsk: true });
          setPendingSwitch(null);
        }}
      />
    </div>
  );
}
