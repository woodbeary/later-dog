import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Loader2, Pencil, Plus, Trash2, Users, X } from "lucide-react";

import { InitialsAvatar } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import type { SidebarMenuItem } from "./SidebarPopoverMenu";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export type ProfileBridge = NonNullable<NonNullable<Window["laterdog"]>["profiles"]>;

export interface ProfileSwitchError {
  id: string;
  message: string;
}

const IPC_PREFIX = /^Error invoking remote method ['"][^'"\r\n]+['"]:\s*(?:Error:\s*)?/i;
const NAME_LIMIT = 40;
const pillCls = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45";
const primaryCls = cn(pillCls, "flex items-center gap-2 bg-accent text-white hover:bg-accent hover:brightness-110");
const cardCls = "w-full max-w-[420px] rounded-2xl border border-hairline/50 bg-panel p-5 shadow-2xl outline-none";

export function profileError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return message.replace(IPC_PREFIX, "").trim() || t("profileSwitcher.error");
}

export function profileName(profile: Pick<DesktopProfile, "name">): string {
  return profile.name.trim() || t("profileSwitcher.personal");
}

export function profileBadge(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((word) => Array.from(word)[0]!.toUpperCase()).join("") || "?";
}

export function useProfiles(): { bridge: ProfileBridge; list: DesktopProfileList } | null {
  const [list, setList] = useState<DesktopProfileList | null>(null);
  useEffect(() => {
    const bridge = window.laterdog?.profiles;
    if (!bridge) return;
    let live = true;
    let heard = false;
    const stop = bridge.onChanged((next) => {
      heard = true;
      if (live) setList(next);
    });
    bridge
      .list()
      .then((next) => {
        if (live && !heard) setList(next);
      })
      .catch(() => {});
    return () => {
      live = false;
      stop();
    };
  }, []);
  const bridge = typeof window === "undefined" ? undefined : window.laterdog?.profiles;
  return bridge && list ? { bridge, list } : null;
}

export function profileEntryItem(onOpen: () => void): SidebarMenuItem {
  return {
    key: "profiles",
    label: t("profileSwitcher.switch"),
    icon: <Users size={18} />,
    trailing: <ChevronRight size={16} className="shrink-0 text-ink-tertiary" />,
    keepOpen: true,
    onSelect: onOpen,
  };
}

export interface ProfilePage {
  list: DesktopProfileList;
  switching: string | null;
  error: ProfileSwitchError | null;
  onBack: () => void;
  onSwitch: (id: string) => void;
  onAdd: () => void;
  onEdit: () => void;
}

export function profilePageItems({ list, switching, error, onBack, onSwitch, onAdd, onEdit }: ProfilePage): SidebarMenuItem[] {
  const busy = switching !== null;
  const rows = list.profiles.map((profile, index): SidebarMenuItem => {
    const open = profile.id === list.activeId;
    const name = profileName(profile);
    const starting = switching === profile.id || profile.status === "starting";
    const problem = error?.id === profile.id ? error.message : profile.status === "failed" ? t("profileSwitcher.failed") : undefined;
    return {
      key: `profile-${profile.id}`,
      label: name,
      icon: <InitialsAvatar initials={profileBadge(name)} size={20} />,
      note: starting ? undefined : problem,
      separatorBefore: index === 0,
      disabled: switching === profile.id,
      keepOpen: !open,
      trailing: starting ? (
        <Loader2 size={16} className="shrink-0 animate-spin text-ink-tertiary" />
      ) : open ? (
        <Check size={16} role="img" aria-label={t("profileSwitcher.inUse")} className="shrink-0 text-accent" />
      ) : undefined,
      onSelect: () => {
        if (!open) onSwitch(profile.id);
      },
    };
  });
  return [
    {
      key: "profiles-back",
      label: t("profileSwitcher.back"),
      icon: <ChevronLeft size={18} />,
      keepOpen: true,
      onSelect: onBack,
    },
    ...rows,
    {
      key: "profiles-add",
      label: t("profileSwitcher.add"),
      icon: <Plus size={18} />,
      note: list.canAdd ? undefined : t("profileSwitcher.full"),
      separatorBefore: true,
      disabled: busy || !list.canAdd,
      onSelect: onAdd,
    },
    {
      key: "profiles-edit",
      label: t("profileSwitcher.edit"),
      icon: <Pencil size={18} />,
      disabled: busy,
      onSelect: onEdit,
    },
  ];
}

function useModal(dialog: RefObject<HTMLDivElement | null>, onEscape: () => void, first?: RefObject<HTMLElement | null>) {
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const escape = useRef(onEscape);
  escape.current = onEscape;
  useEffect(() => {
    (first?.current ?? dialog.current)?.focus();
    const onKey = (event: KeyboardEvent) => {
      const root = dialog.current;
      if (!root || (event.target instanceof Node && !root.contains(event.target))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        escape.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...root.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)")];
      const head = controls[0];
      const tail = controls.at(-1);
      if (!head || !tail) {
        event.preventDefault();
        root.focus();
        return;
      }
      if (event.shiftKey && (document.activeElement === head || document.activeElement === root)) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && (document.activeElement === tail || document.activeElement === root)) {
        event.preventDefault();
        head.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, [dialog, first, opener]);
}

function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}

function Overlay({ busy, onClose, children }: { busy: boolean; onClose: () => void; children: ReactNode }) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

function DialogTitle({ id, title, busy, onClose }: { id: string; title: string; busy: boolean; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 id={id} className="text-[17px] font-semibold text-ink">
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        aria-label={t("common.close")}
        title={t("common.close")}
        className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-ink disabled:opacity-45"
      >
        <X size={18} className="pointer-events-none" />
      </button>
    </div>
  );
}

export function AddProfileDialog({ bridge, onClose }: { bridge: ProfileBridge; onClose: () => void }) {
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const alive = useAlive();
  const titleId = useId();
  const fieldId = useId();
  const close = () => {
    if (!pending) onClose();
  };
  useModal(dialog, close, field);
  useEffect(() => {
    if (pending) dialog.current?.focus();
  }, [pending]);

  const submit = async () => {
    const wanted = name.trim();
    if (pending || added || !wanted) return;
    setPending(true);
    setError("");
    let created = false;
    let message = "";
    try {
      const result = await bridge.add(wanted);
      created = true;
      const label = result.profiles.find((profile) => profile.id === result.added.id)?.name ?? wanted;
      if (result.added.ready) await bridge.switch(result.added.id);
      else message = t("profileSwitcher.addFailed", { name: label });
    } catch (cause) {
      message = profileError(cause);
    }
    if (!alive.current) return;
    setPending(false);
    setAdded(created);
    if (message) setError(message);
    else onClose();
  };

  return (
    <Overlay busy={pending} onClose={close}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={pending}
        tabIndex={-1}
        className={cardCls}
      >
        <DialogTitle id={titleId} title={t("profileSwitcher.addTitle")} busy={pending} onClose={close} />
        <p className="mt-1 text-[13px] leading-relaxed text-ink-secondary">{t("profileSwitcher.addBody")}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={pending || added} className="mt-4 min-w-0 rounded-xl bg-card px-4 py-3">
            <label htmlFor={fieldId} className="block text-[12px] text-ink-secondary">
              {t("profileSwitcher.nameLabel")}
            </label>
            <input
              ref={field}
              id={fieldId}
              maxLength={NAME_LIMIT}
              value={name}
              placeholder={t("profileSwitcher.namePlaceholder")}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full bg-transparent text-[14px] text-ink placeholder:text-ink-tertiary focus:outline-none"
            />
          </fieldset>
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={close} disabled={pending} className={pillCls}>
              {added ? t("common.close") : t("common.cancel")}
            </button>
            {!added && (
              <button type="submit" disabled={pending || !name.trim()} className={primaryCls}>
                {pending && <Loader2 size={15} className="animate-spin" />}
                {pending ? t("profileSwitcher.creating") : t("common.add")}
              </button>
            )}
          </div>
        </form>
      </div>
    </Overlay>
  );
}

function ProfileRow({
  profile,
  open,
  first,
  disabled,
  onRename,
  onRemove,
}: {
  profile: DesktopProfile;
  open: boolean;
  first: boolean;
  disabled: boolean;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState(profile.name);
  useEffect(() => setDraft(profile.name), [profile.name]);
  const name = profileName(profile);
  const commit = () => {
    const next = draft.trim().replace(/\s+/g, " ");
    if (!next && !profile.main) {
      setDraft(profile.name);
      return;
    }
    setDraft(next);
    if (next !== profile.name) onRename(next);
  };
  return (
    <div className={cn("flex items-center gap-3 px-4 py-2.5", !first && "border-t border-hairline/40")}>
      <InitialsAvatar initials={profileBadge(name)} size={28} />
      <input
        value={draft}
        maxLength={NAME_LIMIT}
        disabled={disabled}
        aria-label={t("profileSwitcher.rename", { name })}
        placeholder={profile.main ? t("profileSwitcher.personal") : undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          event.currentTarget.blur();
        }}
        className="min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder:text-ink-tertiary focus:outline-none"
      />
      {open ? (
        <span className="shrink-0 text-[12px] text-ink-tertiary">{t("profileSwitcher.inUse")}</span>
      ) : profile.main ? null : (
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          aria-label={t("profileSwitcher.remove", { name })}
          title={t("profileSwitcher.remove", { name })}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-control hover:text-danger disabled:opacity-45"
        >
          <Trash2 size={16} className="pointer-events-none" />
        </button>
      )}
    </div>
  );
}

export function EditProfilesDialog({
  bridge,
  list,
  onClose,
}: {
  bridge: ProfileBridge;
  list: DesktopProfileList;
  onClose: () => void;
}) {
  const [removing, setRemoving] = useState<DesktopProfile | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const alive = useAlive();
  const titleId = useId();
  const close = () => {
    if (!pending) onClose();
  };
  useModal(dialog, close);

  const rename = async (id: string, name: string) => {
    setError("");
    try {
      await bridge.rename(id, name);
    } catch (cause) {
      if (alive.current) setError(profileError(cause));
    }
  };
  const remove = async () => {
    if (!removing || pending) return;
    setPending(true);
    setError("");
    try {
      await bridge.remove(removing.id);
    } catch (cause) {
      if (alive.current) setError(profileError(cause));
    }
    if (!alive.current) return;
    setPending(false);
    setRemoving(null);
  };

  return (
    <>
      <Overlay busy={pending} onClose={close}>
        <div
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy={pending}
          tabIndex={-1}
          className={cardCls}
        >
          <DialogTitle id={titleId} title={t("profileSwitcher.editTitle")} busy={pending} onClose={close} />
          <div className="mt-4 min-w-0 rounded-xl bg-card">
            {list.profiles.map((profile, index) => (
              <ProfileRow
                key={profile.id}
                profile={profile}
                open={profile.id === list.activeId}
                first={index === 0}
                disabled={pending}
                onRename={(name) => void rename(profile.id, name)}
                onRemove={() => setRemoving(profile)}
              />
            ))}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end">
            <button ref={done} type="button" onClick={close} disabled={pending} className={primaryCls}>
              {t("profileSwitcher.done")}
            </button>
          </div>
        </div>
      </Overlay>
      <ConfirmDialog
        open={removing !== null}
        title={t("profileSwitcher.removeTitle", { name: removing ? profileName(removing) : "" })}
        body={t("profileSwitcher.removeBody")}
        confirmLabel={t("profileSwitcher.removeConfirm")}
        tone="danger"
        pending={pending}
        returnFocusRef={done}
        onCancel={() => {
          if (!pending) setRemoving(null);
        }}
        onConfirm={() => void remove()}
      />
    </>
  );
}
