// App settings: four pages. General (accounts, appearance, this computer's
// system switches), Computer (this Mac's permissions, the Local VM, the
// built-in browser), Usage, and Updates. Per-bot settings (persona, model,
// computer) live in BotSettingsDialog.
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Coins, Download, Monitor, SlidersHorizontal, X } from "lucide-react";
import { api, useStore, type AppSettingsSection, type ConfigStatus } from "@/state/store";
import { analyticsEnabled, setAnalyticsEnabled } from "@/lib/analytics";
import { analyticsConfigured } from "@/lib/laterdog-analytics";
import { checklistHost, COMPUTER_PERMISSIONS, type DesktopPermission } from "@/lib/desktop-permissions";
import { useDesktopPermissions } from "@/lib/use-desktop-permissions";
import { browserAvailable, browserUnavailableReason, builtInBrowserEnabled } from "@/lib/feature-flags";
import { localeChoices } from "@/locales";
import { t } from "@/lib/i18n";
import { useUpdaterState } from "@/lib/updater";
import { appVersion, openExternalLink } from "@/lib/app-links";
import { brand } from "../lib/brand";
import { releaseChecksOff, releaseOffer } from "./ReleaseCheck";
import { AccountsPanel } from "./AccountsPanel";
import { LocalVmRows } from "./LocalVmRows";
import { PermissionChecklist } from "./PermissionChecklist";
import { SettingRow, Switch } from "./SettingsPrimitives";
import { shortcutLabel } from "./ShortcutHint";
import { UsageSection } from "./UsageSection";
import { SkinPicker } from "./SkinPicker";
import { cn } from "@/lib/cn";
import { glassPopupFrameStyle } from "@/lib/glass-popup";
import { setNotificationSounds, useNotificationSounds } from "@/lib/notification-preferences";
import { effectiveLanguage, setLanguageChoice, useLanguageChoice } from "@/lib/language-preference";

// `labelKey`, not a label: t() reads the active pack when it is called, so a
// label resolved here at module scope would freeze the language the app booted
// in.
export const SETTINGS_PAGES: ReadonlyArray<{ id: AppSettingsSection; labelKey: "settings.section.general" | "settings.section.computer" | "settings.section.usage" | "settings.updates.title"; icon: ComponentType<{ size?: number; className?: string }> }> = [
  { id: "general", labelKey: "settings.section.general", icon: SlidersHorizontal },
  { id: "computer", labelKey: "settings.section.computer", icon: Monitor },
  { id: "usage", labelKey: "settings.section.usage", icon: Coins },
  { id: "updates", labelKey: "settings.updates.title", icon: Download },
];

/** A small label above one container of rows: no card in a card. */
export function SettingsGroup({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <section data-settings-group={testId} className="flex flex-col gap-1.5">
      <div className="px-4 text-[12px] font-medium text-ink-secondary">{label}</div>
      {children}
    </section>
  );
}

/** The rows of a group, one container with hairlines between them. */
export function SettingsRows({ children, ...rest }: { children: ReactNode } & Record<`data-${string}`, string | boolean | undefined>) {
  return <div {...rest} className="rounded-xl bg-card px-4">{children}</div>;
}

/** Your name, saved on blur. The email and shared context left Settings. */
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

/** This app's updates, which download by themselves. Shown once the desktop
 * app answers: on this computer's page and the person's own Cloud page, never
 * on another server's, where its buttons would do nothing. "Ready" names the
 * app: on My Cloud's Settings it is this app that restarts, not the Cloud. */
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
  // No update feed: a newer release to download, or checking switched off.
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
        className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45"
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

/** Usage analytics, on by default and switchable here. Naming what is sent
 * matters more than the switch: people who cannot see the scope assume the
 * worst. Absent where no analytics key is built in. */
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
  // Saved on this device only: anyone can switch, including a chat-only
  // teammate, and nobody changes another person's screen. The server's
  // language is the default until this device picks one.
  const current = effectiveLanguage(useLanguageChoice(), state.config?.language);

  return (
    <SettingRow
      title={t("settings.language.title")}
      subtitle={t("settings.language.subtitle")}
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

function NotificationSoundsRow() {
  const enabled = useNotificationSounds();
  return (
    <SettingRow title={t("settings.notificationSounds.title")} subtitle={t("settings.notificationSounds.subtitle")}>
      <Switch
        checked={enabled}
        aria-label={t("settings.notificationSounds.play")}
        onClick={() => setNotificationSounds(!enabled)}
      />
    </SettingRow>
  );
}

/** The installation's built-in browser switch; the setting and its write are
 * the same `features.browser` it always was. */
export function BuiltInBrowserRow() {
  const { state, dispatch } = useStore();
  const browser = builtInBrowserEnabled(state.config);
  const desktopBrowser = browserAvailable(state.config);
  const browserInstallable = state.config?.browserEngine?.installable === true;
  const browserBlockedOnWindows = window.laterdog?.platform === "win32" && !desktopBrowser && !browserInstallable;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const toggle = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const config: ConfigStatus = await api("/api/config", {
        method: "PATCH",
        body: JSON.stringify({ features: { browser: next } }),
      });
      dispatch({ type: "configStatus", config });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("settings.experimental.error"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsRows data-built-in-browser>
      <SettingRow
        title={t("settings.experimental.browserAria")}
        subtitle={desktopBrowser
          ? browser
            ? t("settings.experimental.browserOn")
            : t("settings.experimental.browserOff")
          : browserBlockedOnWindows
            ? t("settings.experimental.browserWindows")
            : browserUnavailableReason(state.config)}
        message={error ? <p role="alert" className="text-danger">{error}</p> : null}
      >
        <Switch
          checked={browser}
          aria-label={t("settings.experimental.browserAria")}
          disabled={saving || (!browser && !desktopBrowser && !browserInstallable)}
          onClick={() => void toggle(!browser)}
          className="disabled:cursor-wait disabled:opacity-50"
        />
      </SettingRow>
    </SettingsRows>
  );
}

/** What macOS lets this app do, as the native bridge reports it. Only on a
 * Mac with that bridge: elsewhere there is nothing to ask for. */
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
  return (
    <>
      <SettingsGroup label={t("settings.group.accounts")} testId="accounts">
        <AccountsPanel />
      </SettingsGroup>
      <SettingsGroup label={t("settings.section.appearance")} testId="appearance">
        <SettingsRows>
          <SettingRow title={t("settings.skin.title")} subtitle={t("settings.skin.subtitle")}>
            <SkinPicker />
          </SettingRow>
          <LanguageRow />
          <NotificationSoundsRow />
        </SettingsRows>
      </SettingsGroup>
      <SettingsGroup label={t("settings.group.system")} testId="system">
        {mac && <MacPermissions permissions={["microphone"]} />}
        <SettingsRows>
          <AnalyticsRow />
          <NameRow />
        </SettingsRows>
      </SettingsGroup>
    </>
  );
}

function ComputerPage({ mac, remoteActive, cloudHome }: { mac: boolean; remoteActive: boolean; cloudHome: boolean }) {
  return (
    <>
      {mac && (
        <SettingsGroup label={t("settings.group.thisMac")} testId="this-mac">
          <MacPermissions permissions={COMPUTER_PERMISSIONS} intro={t("settings.computer.macIntro", { app: brand().name })} />
        </SettingsGroup>
      )}
      {/* A later.dog Cloud home has no Local VM; a paired remote client's is the server's. */}
      {!remoteActive && !cloudHome && (
        <SettingsGroup label={t("vm.main.title")} testId="local-vm">
          <LocalVmRows />
        </SettingsGroup>
      )}
      {!remoteActive && (
        <SettingsGroup label={t("settings.experimental.browser")} testId="browser">
          <BuiltInBrowserRow />
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
  const cloudHome = state.config?.cloudHome === true;
  // This Mac's grants: only in the desktop app on macOS, and not from a
  // paired remote client, whose grants are its own desktop app's.
  const mac = !remoteActive && checklistHost(window.laterdog) === "mac";

  useEffect(() => {
    // A new page starts at its top, not at the last page's scroll offset.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [section]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      // A child editor owns Escape and its focus trap, including while saving.
      if (event.defaultPrevented || (dialog && [...dialog.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]')]
        .some(child => child.getClientRects().length))) return;
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
      {/* A sibling, not the parent: a backdrop-filter on an ancestor would
          stop the pop-up's own glass from seeing the app behind it. */}
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
            {section === "computer" && <ComputerPage mac={mac} remoteActive={remoteActive} cloudHome={cloudHome} />}
            {section === "usage" && <UsageSection />}
            {section === "updates" && <UpdatesPage />}
          </div>
        </div>
      </div>
    </div>
  );
}
