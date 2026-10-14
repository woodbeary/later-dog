import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { modelShown, setModelShown, useHiddenModels } from "@/lib/model-visibility";
import { newestOfLine } from "@/lib/model-lines";
import { needsCli, needsSignIn } from "./EngineSetup";
import { setVoiceMode, useVoiceMode } from "@/lib/voice-mode";
import { Boxes, Coins, Download, Monitor, SlidersHorizontal, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus, type InstanceInfo } from "@/state/store";
import { cloudDictationEnabled, stepUpdatesEnabled } from "@/lib/feature-flags";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { analyticsConfigured } from "@/lib/laterdog-analytics";
import { checklistHost, COMPUTER_PERMISSIONS, type DesktopPermission } from "@/lib/desktop-permissions";
import { useDesktopPermissions } from "@/lib/use-desktop-permissions";
import { localeChoices } from "@/locales";
import { activeLocale, t } from "@/lib/i18n";
import { useUpdaterState } from "@/lib/updater";
import { appVersion, openExternalLink } from "@/lib/app-links";
import { brand } from "../lib/brand";
import { ReleaseCheckRow, releaseChecksOff, releaseOffer } from "./ReleaseCheck";
import { AboutMeSettings } from "./AboutMeSettings";
import { AccountsPanel, AccountsRefresh } from "./AccountsPanel";
import { SavedApiKeys, savedKeyEngines } from "./SavedApiKeys";
import { TypingSuggestionsRows } from "./TypingSuggestionsSettings";
import { HelpRows } from "./SettingsHelp";
import { CloudComputerRows } from "./CloudComputerRows";
import { ExecutionRows, ThisComputerRow } from "./ComputerSettings";
import { PermissionChecklist } from "./PermissionChecklist";
import { InstanceProviderMark } from "./ProviderIcons";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { shortcutLabel } from "./ShortcutHint";
import { UsageSection } from "./UsageSection";
import { ThemeRow } from "./ThemeRow";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { setNotificationSounds, useNotificationSounds } from "@/lib/notification-preferences";
import { effectiveLanguage, setLanguageChoice, useLanguageChoice } from "@/lib/language-preference";

export const SETTINGS_PAGES: ReadonlyArray<{ id: AppSettingsSection; labelKey: "settings.section.general" | "settings.section.models" | "settings.section.computer" | "settings.section.usage" | "settings.updates.title"; icon: ComponentType<{ size?: number; className?: string }> }> = [
  { id: "general", labelKey: "settings.section.general", icon: SlidersHorizontal },
  { id: "models", labelKey: "settings.section.models", icon: Boxes },
  { id: "computer", labelKey: "settings.section.computer", icon: Monitor },
  { id: "usage", labelKey: "settings.section.usage", icon: Coins },
  { id: "updates", labelKey: "settings.updates.title", icon: Download },
];

export function SettingsGroup({ label, children, testId, action }: { label: string; children: ReactNode; testId?: string; action?: ReactNode }) {
  return (
    <section data-settings-group={testId} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between px-4 text-[12px] font-medium text-ink-secondary"><div>{label}</div>{action}</div>
      {children}
    </section>
  );
}

export function SettingsRows({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string | boolean | undefined>) {
  return <div {...rest} className="rounded-xl bg-card px-4">{children}</div>;
}

function NameRow() {
  const { state, dispatch } = useStore();
  const [name, setName] = useState(state.config?.profile?.name ?? "");
  useEffect(() => {
    setName(state.config?.profile?.name ?? "");
  }, [state.config?.profile?.name]);

  const save = () => {
    const email = state.config?.profile?.email ?? "";
    void fetch("/api/config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: { name: name.trim(), email } }),
    })
      .then((r) => { if (!r.ok) throw new Error("Profile save failed"); return r.json(); })
      .then((config: ConfigStatus) => {
        if (config.profile) dispatch({ type: "profileSaved", profile: { name: config.profile.name, email: config.profile.email } });
      })
      .catch(() => {});
  };

  return (
    <SettingRow title={t("settings.profile.name")} subtitle={t("settings.profile.subtitle")}>
      <input
        aria-label={t("settings.profile.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        placeholder={t("settings.profile.name")}
        className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
      />
    </SettingRow>
  );
}

export function UpdatesRow() {
  const s = useUpdaterState();
  const updater = window.laterdog?.updater;
  if (!s || !updater) return null;
  const statusLabel =
    s.status === "checking"
      ? t("settings.updates.checking")
      : s.status === "downloading"
        ? s.percent == null
          ? t("settings.updates.startingDownload")
          : t("settings.updates.downloading", { percent: Math.round(s.percent) })
        : s.status === "preparing"
          ? t("settings.updates.preparing")
          : s.status === "downloaded"
            ? s.installMode === "handoff"
              ? t("settings.updates.readyInstall", { app: brand().name, version: s.version ?? "" })
              : t("settings.updates.ready", { app: brand().name, version: s.version ?? "" })
            : s.status === "installing"
              ? s.message ||
                (s.installMode === "handoff"
                  ? t("settings.updates.openingTerminal")
                  : t("settings.updates.restarting"))
              : s.status === "handed-off"
                ? t("settings.updates.handedOff")
                : s.status === "error"
                  ? t("settings.updates.failed", { message: s.message ?? t("settings.updates.unknownError") })
                  : t("settings.updates.latest");
  const release = releaseOffer(s);
  const checksOff = releaseChecksOff(s);
  const label = release
    ? t("releaseCheck.available", { app: brand().name, version: release.version })
    : checksOff ? t("releaseCheck.off") : statusLabel;
  return (
    <SettingRow title={t("settings.updates.title")} subtitle={label}>
      <button
        onClick={() => {
          if (release) return void openExternalLink(release.url);
          if (s.status === "downloaded") return void updater.install();
          void updater.check();
        }}
        disabled={
          checksOff || s.status === "checking" || s.status === "downloading" || s.status === "preparing" ||
          s.status === "installing" || s.retryable === false
        }
        className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover disabled:opacity-45"
      >
        {release ? t("releaseCheck.download") : s.retryable === false
          ? t("settings.updates.quitReopen")
          : s.status === "downloaded"
            ? s.installMode === "handoff"
              ? t("settings.updates.install")
              : t("settings.updates.restart")
            : s.status === "preparing"
              ? t("settings.updates.preparingShort")
              : s.status === "installing"
                ? s.installMode === "handoff"
                  ? t("settings.updates.opening")
                  : t("settings.updates.restartingShort")
                : t("settings.updates.check")}
      </button>
    </SettingRow>
  );
}

function AnalyticsRow() {
  const [on, setOn] = useState(analyticsEnabled);
  if (!analyticsConfigured()) return null;
  return (
    <SettingRow title={t("settings.analytics.title")} subtitle={t("settings.analytics.subtitle")}>
      <Switch
        checked={on}
        aria-label={t("settings.analytics.aria")}
        onClick={() => {
          const next = !on;
          setAnalyticsEnabled(next);
          setOn(next);
        }}
      />
    </SettingRow>
  );
}

function LanguageRow() {
  const { state } = useStore();
  const current = effectiveLanguage(useLanguageChoice(), state.config?.language);

  return (
    <SettingRow
      title={t("settings.language.title")}
      subtitle={activeLocale() === "en" ? undefined : t("settings.language.hint")}
    >
      <select
        value={current}
        aria-label={t("settings.language.aria")}
        onChange={(event) => setLanguageChoice(event.target.value)}
        className="min-h-8 w-full max-w-[240px] rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus disabled:cursor-wait disabled:opacity-50"
      >
        <option value="">{t("settings.language.system")}</option>
        {localeChoices.map(({ code, label }) => (
          <option key={code} value={code}>
            {label}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

function VoiceModeRow() {
  const on = useVoiceMode();
  return (
    <SettingRow title={t("settings.voiceMode.title")} subtitle={t("settings.voiceMode.hint")}>
      <Switch checked={on} aria-label={t("settings.voiceMode.title")} onClick={() => setVoiceMode(!on)} />
    </SettingRow>
  );
}

function FeatureSwitchRow({ feature, on, title, hint, error }: {
  feature: "stepUpdates" | "cloudDictation";
  on: boolean;
  title: string;
  hint: string;
  error: string;
}) {
  const { dispatch } = useStore();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { [feature]: !on } }),
      });
      dispatch({ type: "configStatus", config });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow
      title={title}
      subtitle={hint}
      message={failed && <span role="alert" className="text-danger">{error}</span>}
    >
      <Switch checked={on} disabled={saving} aria-label={title} onClick={() => void toggle()} />
    </SettingRow>
  );
}

export function StepUpdatesRow() {
  const { state } = useStore();
  return (
    <FeatureSwitchRow
      feature="stepUpdates"
      on={stepUpdatesEnabled(state.config)}
      title={t("settings.stepUpdates.title")}
      hint={t("settings.stepUpdates.hint")}
      error={t("settings.stepUpdates.error")}
    />
  );
}

export function CloudDictationRow() {
  const { state } = useStore();
  return (
    <FeatureSwitchRow
      feature="cloudDictation"
      on={cloudDictationEnabled(state.config)}
      title={t("settings.cloudDictation.title")}
      hint={t("settings.cloudDictation.hint")}
      error={t("settings.cloudDictation.error")}
    />
  );
}

function NotificationSoundsRow() {
  const enabled = useNotificationSounds();
  return (
    <SettingRow title={t("settings.notificationSounds.title")} subtitle={t("settings.notificationSounds.hint")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.notificationSounds.play")}
        onClick={() => setNotificationSounds(!enabled)}
      />
    </SettingRow>
  );
}

function MacPermissions({ permissions, intro }: { permissions: readonly DesktopPermission[]; intro?: string }) {
  const host = "mac" as const;
  const { checklist, busy, request, openSettings } = useDesktopPermissions();
  const relaunch = typeof window.laterdog?.relaunch === "function"
    ? () => void window.laterdog?.relaunch?.().catch(() => {})
    : undefined;
  return (
    <SettingsRows data-mac-permissions={permissions.join(" ")}>
      {intro && <p className="pt-3 text-[12px] leading-relaxed text-ink-secondary">{intro}</p>}
      <PermissionChecklist
        host={host}
        checklist={checklist}
        busy={busy}
        onRequest={request}
        onOpenSettings={openSettings}
        onRelaunch={relaunch}
        permissions={permissions}
      />
    </SettingsRows>
  );
}

function GeneralPage({ mac }: { mac: boolean }) {
  const { state } = useStore();
  const keyed = savedKeyEngines(state.instances);
  const analytics = analyticsConfigured();
  return (
    <>
      <SettingsGroup label={t("settings.group.accounts")} testId="accounts" action={<AccountsRefresh />}>
        <AccountsPanel />
      </SettingsGroup>
      {keyed.length > 0 && (
        <SettingsGroup label={t("settings.group.apiKeys")} testId="api-keys">
          <SavedApiKeys instances={keyed} />
        </SettingsGroup>
      )}
      <SettingsGroup label={t("settings.profile.title")} testId="profile">
        <SettingsRows>
          <NameRow />
          <div className="border-t border-hairline/40 py-4">
            <AboutMeSettings />
          </div>
        </SettingsRows>
      </SettingsGroup>
      <SettingsGroup label={t("settings.section.appearance")} testId="appearance">
        <SettingsRows>
          <ThemeRow />
          <LanguageRow />
          <NotificationSoundsRow />
          <VoiceModeRow />
          <StepUpdatesRow />
        </SettingsRows>
      </SettingsGroup>
      <SettingsGroup label={t("settings.typing.title")} testId="typing-suggestions">
        <SettingsRows>
          <TypingSuggestionsRows />
        </SettingsRows>
      </SettingsGroup>
      {(mac || analytics) && (
        <SettingsGroup label={t("settings.group.system")} testId="system">
          {mac && <MacPermissions permissions={["microphone"]} />}
          <SettingsRows>
            {mac && <CloudDictationRow />}
            {analytics && <AnalyticsRow />}
          </SettingsRows>
        </SettingsGroup>
      )}
      <SettingsGroup label={t("settings.group.help")} testId="help">
        <SettingsRows>
          <HelpRows />
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}

function ModelsPage() {
  const { state } = useStore();
  const hidden = useHiddenModels();
  const [query, setQuery] = useState("");
  const accounts = state.instances.filter((instance) => !instance.policy && !needsCli(instance) && !needsSignIn(instance)
    && instance.models.options.some((option) => !option.custom));
  const needle = query.trim().toLowerCase();
  const groups = accounts.flatMap((account) => {
    const options = account.models.options.filter((option) => !option.custom);
    const latest = newestOfLine(options, (option) => option.label);
    const found = options.filter((option) => !needle || option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle));
    if (found.length === 0) return [];
    const shown = options.filter((option) => modelShown(account.instanceId, option.id, hidden)).length;
    return [{ account, shown, total: options.length, newest: found.filter(latest), earlier: found.filter((option) => !latest(option)) }];
  });
  if (accounts.length === 0) return <p className="px-1 text-[13px] text-ink-secondary">{t("settings.models.none")}</p>;
  const row = (account: InstanceInfo, option: InstanceInfo["models"]["options"][number]) => {
    const shown = modelShown(account.instanceId, option.id, hidden);
    return (
      <label key={`${account.instanceId}:${option.id}`} data-settings-model={`${account.instanceId}:${option.id}`}
        className="-mx-2 flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2 transition-colors hover:bg-raised-hover">
        <span className={cn("min-w-0 flex-1 truncate text-[13px]", shown ? "text-ink" : "text-ink-secondary")}>{option.label}</span>
        <Switch
          size="small"
          checked={shown}
          aria-label={t("settings.models.show", { model: option.label })}
          onClick={() => setModelShown(account.instanceId, option.id, !shown)}
        />
      </label>
    );
  };
  return (
    <div data-settings-group="models" className="flex flex-col gap-5">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("settings.models.search")}
        aria-label={t("settings.models.search")}
        className="h-8 w-full rounded-lg bg-inset px-3 text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
      />
      {groups.length === 0 && <p className="px-1 text-[13px] text-ink-secondary">{t("settings.models.noMatch")}</p>}
      {groups.map(({ account, shown, total, newest, earlier }) => (
        <section key={account.instanceId} data-settings-model-group={account.instanceId} aria-label={account.displayName} className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 px-1 text-[12px] font-medium text-ink-secondary">
            <InstanceProviderMark instance={account} size={13} />
            <span className="min-w-0 flex-1 truncate">{account.displayName}</span>
            <span className="shrink-0 tabular-nums text-ink-tertiary">{t("settings.models.shownCount", { shown, total })}</span>
          </div>
          <div className="rounded-xl bg-card px-4 py-1.5">
            {newest.map((option) => row(account, option))}
            {earlier.length > 0 && (
              <p data-settings-model-earlier className={cn("pb-1 text-[11.5px] font-medium text-ink-tertiary", newest.length > 0 ? "mt-1.5 border-t border-hairline/40 pt-2.5" : "pt-1")}>
                {t("model.earlier")}
              </p>
            )}
            {earlier.map((option) => row(account, option))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ComputerPage({ mac, remoteActive }: { mac: boolean; remoteActive: boolean }) {
  const desktop = !remoteActive && Boolean(window.laterdog);
  return (
    <>
      {desktop && (
        <SettingsGroup label={t("settings.group.yourComputer")} testId="your-computer">
          <SettingsRows>
            <ThisComputerRow />
          </SettingsRows>
          {mac && <MacPermissions permissions={COMPUTER_PERMISSIONS} intro={t("settings.computer.macIntro", { app: brand().name })} />}
        </SettingsGroup>
      )}
      {desktop && (
        <SettingsGroup label={t("settings.group.execution")} testId="execution">
          <ExecutionRows />
        </SettingsGroup>
      )}
      {!remoteActive && (
        <SettingsGroup label={t("vm.cloud.title")} testId="cloud-computers">
          <CloudComputerRows />
        </SettingsGroup>
      )}
    </>
  );
}

function UpdatesPage() {
  const updater = Boolean(window.laterdog?.updater);
  return (
    <SettingsGroup label={t("settings.updates.title")} testId="updates">
      <SettingsRows>
        <SettingRow title={t("settings.updates.version")} subtitle={brand().name}>
          <span data-app-version className="text-[13px] text-ink-secondary sm:text-right sm:block">{appVersion()}</span>
        </SettingRow>
        {updater
          ? <UpdatesRow />
          : <SettingRow title={t("settings.updates.title")} subtitle={t("settings.updates.desktopOnly")}>{null}</SettingRow>}
        <ReleaseCheckRow />
      </SettingsRows>
    </SettingsGroup>
  );
}

export function SettingsModal() {
  const { state, dispatch } = useStore();
  const section: AppSettingsSection = SETTINGS_PAGES.some((page) => page.id === state.appSettingsSection) ? state.appSettingsSection : "general";
  const dialogRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const remoteActive = window.laterdog?.remoteClient?.active === true;
  const mac = !remoteActive && checklistHost(window.laterdog) === "mac";

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || (dialog && [...dialog.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
        .some(child => child.getClientRects().length))) return;
      if ([...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')]
        .some(other => other !== dialog && !other.contains(dialog) && other.getClientRects().length)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleAppSettings", open: false });
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.checkVisibility());
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  const openSection = (id: AppSettingsSection) => dispatch({ type: "toggleAppSettings", open: true, section: id });
  const current = SETTINGS_PAGES.find((page) => page.id === section) ?? SETTINGS_PAGES[0]!;

  return (
    <div
      className="glass-popup-frame"
      style={glassPopupFrameStyle()}
      onMouseDown={(e) => e.target === e.currentTarget && dispatch({ type: "toggleAppSettings", open: false })}
    >
      <div aria-hidden="true" className="glass-scrim pointer-events-none absolute inset-0" />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        tabIndex={-1}
        className="glass-surface glass-popup animate-pop-in relative flex overflow-hidden rounded-[24px] outline-none"
      >
        <span id="app-settings-title" className="sr-only">{t("settings.title")}</span>
        <nav className="glass-rail hidden min-h-0 w-[200px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-hairline/30 p-3 sm:flex">
          <div className="shrink-0 px-2 py-3 text-[15px] font-semibold text-ink">
            {t("settings.title")}
          </div>
          <div className="flex flex-col gap-0.5 pb-2">
            {SETTINGS_PAGES.map(({ id, labelKey, icon: Icon }) => (
              <button
                key={id}
                data-settings-page={id}
                onClick={() => openSection(id)}
                aria-current={section === id ? "page" : undefined}
                className={cn(
                  "flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors motion-reduce:transition-none",
                  section === id ? "bg-control text-ink" : "text-ink-secondary hover:bg-control/50 hover:text-ink",
                )}
              >
                <Icon size={15} className="shrink-0" />
                {t(labelKey)}
              </button>
            ))}
          </div>
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline/30 px-3 py-3 sm:px-5">
            <select
              aria-label={t("settings.title")}
              value={section}
              onChange={(event) => openSection(event.target.value as AppSettingsSection)}
              className="min-w-0 rounded-lg bg-control px-3 py-2 text-[14px] text-ink sm:hidden"
            >
              {SETTINGS_PAGES.map(({ id, labelKey }) => (
                <option key={id} value={id}>{t(labelKey)}</option>
              ))}
            </select>
            <span className="hidden text-[15px] font-semibold text-ink sm:block">
              {t(current.labelKey)}
            </span>
            <button
              onClick={() => dispatch({ type: "toggleAppSettings", open: false })}
              aria-label={t("settings.close")}
              title={`${t("settings.close")} (${shortcutLabel("close-panel")})`}
              className="ui-icon-button shrink-0"
            >
              <X size={18} />
            </button>
          </div>
          <div ref={scrollRef} data-settings-content={section} className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-4 sm:px-5 sm:pb-5">
            {section === "general" && <GeneralPage mac={mac} />}
            {section === "models" && <ModelsPage />}
            {section === "computer" && <ComputerPage mac={mac} remoteActive={remoteActive} />}
            {section === "usage" && <UsageSection />}
            {section === "updates" && <UpdatesPage />}
          </div>
        </div>
      </div>
    </div>
  );
}
