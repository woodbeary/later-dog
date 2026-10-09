// The profile row at the very bottom of the sidebar, and the menu it opens.
//
// Everything app-level used to sit in that row as unlabelled icons crowding
// the name: a phone, an update arrow, a gear. Three icons is a guessing game
// and there was nowhere to put a fourth. They are now a menu that the row
// opens on click — the shape every desktop app uses for "this is about the
// app, not about what you are looking at".
//
// The update entry is the one item that reports progress in place, so it
// keeps the menu open and re-labels itself as it works.
//
// The phone has two entries: Connect your phone, which opens the pairing
// flow in a dialog (only in the desktop app on its own computer, the one
// place a phone can pair now that Settings has no Remote access page), and
// Use on your phone (no phone app exists yet; a phone's browser opens the
// pairing link instead).
import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  Check,
  Info,
  HelpCircle,
  Keyboard,
  Loader2,
  MessageSquare,
  RefreshCw,
  Settings as SettingsIcon,
  Smartphone,
} from "lucide-react";

import { InitialsAvatar } from "./Avatar";
import { AboutDialog } from "./AboutDialog";
import { PhoneAppDialog } from "./PhoneAppDialog";
import { PhonePairingDialog } from "./PhonePairingDialog";
import { releaseChecksOff, releaseOffer } from "./ReleaseCheck";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { ShortcutHint } from "./ShortcutHint";
import { useStore } from "@/state/store";
import { useUpdaterState, type UpdaterState } from "@/lib/updater";
import { brand } from "../lib/brand";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { FEEDBACK_URL, HELP_CENTER_URL, openExternalLink } from "@/lib/app-links";
import { currentPhonePairingTarget } from "@/lib/phone-pairing";

/** "Sam Reed" → "SR", "sam" → "S", "you@x.dev" → "Y", unset → "?" */
export function profileInitials(profile?: { name?: string; email?: string }): string {
  const name = profile?.name?.trim();
  if (name) {
    const words = name.split(/\s+/);
    return words
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("");
  }
  const email = profile?.email?.trim();
  return email ? email[0]!.toUpperCase() : "?";
}

/** The name shown on the row: the profile name, else the email, else "You". */
export function profileLabel(profile?: { name?: string; email?: string }): string {
  return profile?.name?.trim() || profile?.email?.trim() || t("sidebar.profile.you");
}

export type UpdatePhase =
  | UpdaterState["status"]
  /** a check came back with nothing — acknowledged for three seconds so the
   * click is never silent */
  | "up-to-date"
  /** a newer release on GitHub that this build cannot install: the person
   * downloads it (ReleaseCheck.tsx) */
  | "available";

/** One state machine for the update entry, kept pure so the label/verb pairs
 * can be tested without a bridge. `upToDate` is the 3s acknowledgement after
 * a check that found nothing — otherwise a check is silent. */
export function updatePhase(state: UpdaterState | null, upToDate: boolean): UpdatePhase {
  const status = state?.status ?? "idle";
  if (status !== "idle") return status;
  if (releaseOffer(state)) return "available";
  return upToDate ? "up-to-date" : "idle";
}

export function updateLabel(phase: UpdatePhase, state: UpdaterState | null): string {
  switch (phase) {
    case "downloading":
      return state?.percent == null
        ? t("sidebar.update.startingDownload")
        : t("sidebar.update.downloading", { percent: Math.round(state.percent) });
    case "preparing":
      return t("sidebar.update.preparing");
    case "downloaded":
      // Named: on My Cloud's page it is this app that restarts, not the Cloud.
      // An unknown version leaves a double space behind, in every language.
      return (
        state?.installMode === "handoff"
          ? t("sidebar.update.readyInstall", { app: brand().name, version: state?.version ?? "" })
          : t("sidebar.update.ready", { app: brand().name, version: state?.version ?? "" })
      ).replace("  ", " ");
    case "installing":
      return (
        state?.message ||
        (state?.installMode === "handoff"
          ? t("sidebar.update.openingTerminal")
          : t("sidebar.update.installing"))
      );
    case "checking":
      return t("sidebar.update.checking");
    case "handed-off":
      return t("sidebar.update.handedOff");
    case "error":
      return state?.message?.trim() || t("sidebar.update.failed");
    case "up-to-date":
      return t("sidebar.update.upToDate");
    case "available":
      return t("sidebar.update.available", { app: brand().name, version: releaseOffer(state)?.version ?? "" });
    default:
      return t("sidebar.update.check");
  }
}

/** A phase that is mid-flight takes no further clicks. `pending` covers the
 * gap between the click and the bridge reporting the state it started: a
 * check and an install round-trip through main first, and without this the
 * row would sit there looking clickable. */
export function updateBusy(phase: UpdatePhase, pending = false): boolean {
  return pending || phase === "checking" || phase === "downloading" || phase === "preparing" || phase === "installing";
}

function UpdateIcon({ phase, pending, size = 18 }: { phase: UpdatePhase; pending: boolean; size?: number }) {
  if (updateBusy(phase, pending)) return <Loader2 size={size} className="animate-spin" />;
  if (phase === "up-to-date") return <Check size={size} />;
  if (phase === "downloaded" || phase === "available") return <ArrowDownToLine size={size} />;
  return <RefreshCw size={size} />;
}

/** Whether the updater has something the profile row should say out loud.
 * An idle updater, and the three-second "up to date" tick that follows a
 * check the user asked for from inside the menu, both stay in the menu. So
 * does a release to download: its card told the person once, no nagging. */
export function updateNoteworthy(phase: UpdatePhase, pending = false): boolean {
  return pending || (phase !== "idle" && phase !== "up-to-date" && phase !== "checking" && phase !== "available");
}

interface UpdateEntry {
  item: SidebarMenuItem;
  phase: UpdatePhase;
  pending: boolean;
  label: string;
}

/** The updater bridge exists only in the packaged app; in dev the entry is
 * absent rather than dead. The desktop app answers only this computer's page
 * and the person's own Cloud page, so until it does there is no entry. */
export function useUpdateItem(): UpdateEntry | null {
  const state = useUpdaterState();
  const updater = window.laterdog?.updater;
  const [pending, setPending] = useState(false);
  const [checkedAt, setCheckedAt] = useState(0);
  const status = state?.status ?? "idle";

  // a check and an install both round-trip through main before the status
  // changes — spin on the click itself, and let the new status clear it
  useEffect(() => setPending(false), [status]);

  // a check that found nothing lands back on idle — acknowledge it for 3s
  const upToDate = Boolean(checkedAt) && (!state || state.status === "idle") && Date.now() - checkedAt < 3000;
  useEffect(() => {
    if (!upToDate) return;
    const timer = setTimeout(() => setCheckedAt(0), 3000);
    return () => clearTimeout(timer);
  }, [upToDate]);

  // No update feed and checking switched off: there is nothing to check.
  if (!updater || !state || releaseChecksOff(state)) return null;

  const phase = updatePhase(state, upToDate);
  const label = updateLabel(phase, state);
  const release = releaseOffer(state);
  return {
    phase,
    pending,
    label,
    item: {
      key: "update",
      label,
      icon: <UpdateIcon phase={phase} pending={pending} />,
      disabled: updateBusy(phase, pending) || state?.retryable === false,
      // progress is reported on the row itself, so the menu stays put; a
      // download goes on in the browser
      keepOpen: !release,
      attention: phase === "downloaded" || phase === "error" || phase === "available",
      attentionTone: phase === "error" ? "danger" : "accent",
      onSelect: () => {
        if (release) return void openExternalLink(release.url);
        if (phase === "downloaded") {
          setPending(true);
          return void updater.install();
        }
        setCheckedAt(Date.now());
        void updater.check();
      },
    },
  };
}

/** The phone entries at the top of the menu: Connect your phone where this
 * window can pair one (the desktop app on its own computer), then Use on
 * your phone. */
export function phoneMenuItems({
  canPair,
  onConnect,
  onGetApp,
}: {
  canPair: boolean;
  onConnect: () => void;
  onGetApp: () => void;
}): SidebarMenuItem[] {
  return [
    ...(canPair
      ? [{
          key: "connect-phone",
          label: t("sidebar.menu.connectPhone"),
          subtitle: t("sidebar.menu.connectPhone.computer"),
          icon: <Smartphone size={18} />,
          onSelect: onConnect,
        } satisfies SidebarMenuItem]
      : []),
    {
      key: "phone-app",
      label: t("sidebar.menu.getPhoneApp"),
      icon: <Smartphone size={18} />,
      onSelect: onGetApp,
    },
  ];
}

export function SidebarProfileMenu() {
  const { state, dispatch } = useStore();
  const canPairPhone = currentPhonePairingTarget(state.config?.cloudHome === true) === "computer";
  const update = useUpdateItem();
  const [aboutOpen, setAboutOpen] = useState(false);
  const [phoneAppOpen, setPhoneAppOpen] = useState(false);
  const [phonePairingOpen, setPhonePairingOpen] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const profile = state.config?.profile;
  const name = profileLabel(profile);

  const items: SidebarMenuItem[] = [
    ...phoneMenuItems({
      canPair: canPairPhone,
      onConnect: () => setPhonePairingOpen(true),
      onGetApp: () => setPhoneAppOpen(true),
    }),
    {
      key: "settings",
      label: t("sidebar.menu.settings"),
      icon: <SettingsIcon size={18} />,
      onSelect: () => dispatch({ type: "toggleAppSettings" }),
    },
    {
      key: "shortcuts",
      label: "Keyboard shortcuts",
      icon: <Keyboard size={18} />,
      trailing: <ShortcutHint id="shortcuts-cheat-sheet" />,
      onSelect: () => {
        // The menu item unmounts; let the dialog restore the profile button.
        triggerRef.current?.closest("button")?.focus();
        dispatch({ type: "toggleShortcuts", open: true });
      },
    },
    ...(update ? [update.item] : []),
    {
      key: "about",
      label: t("sidebar.menu.about"),
      icon: <Info size={18} />,
      separatorBefore: true,
      onSelect: () => setAboutOpen(true),
    },
    {
      key: "help",
      label: t("sidebar.menu.help"),
      icon: <HelpCircle size={18} />,
      onSelect: () => void openExternalLink(HELP_CENTER_URL),
    },
    {
      key: "feedback",
      label: t("sidebar.menu.feedback"),
      icon: <MessageSquare size={18} />,
      onSelect: () => void openExternalLink(FEEDBACK_URL),
    },
  ];

  return (
    <>
      <SidebarPopoverMenu
        items={items}
        ariaLabel={name}
        renderTrigger={({ open }) => (
          <span
            ref={triggerRef}
            className={cn(
              "flex min-h-10 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
              open ? "bg-raised" : "hover:bg-raised/50",
            )}
          >
            <InitialsAvatar initials={profileInitials(profile)} size={28} />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{name}</span>
            {/* an update is the one thing worth interrupting the name for, so
              * it sits on the row rather than waiting to be found in the menu */}
            {update && updateNoteworthy(update.phase, update.pending) && (
              <span
                title={update.label}
                aria-label={update.label}
                className={cn(
                  "flex size-6 shrink-0 items-center justify-center rounded-full",
                  update.phase === "error" ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent",
                )}
              >
                <UpdateIcon phase={update.phase} pending={update.pending} size={14} />
              </span>
            )}
          </span>
        )}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <PhoneAppDialog
        open={phoneAppOpen}
        onClose={() => setPhoneAppOpen(false)}
        connect={canPairPhone ? [{ key: "here", subtitle: t("sidebar.menu.connectPhone.computer"), onSelect: () => setPhonePairingOpen(true) }] : []}
      />
      <PhonePairingDialog open={phonePairingOpen} onClose={() => setPhonePairingOpen(false)} profileEmail={profile?.email ?? ""} />
    </>
  );
}
