import { useRef, useState } from "react";
import { Bell, ChevronLeft, X } from "lucide-react";

import { api, useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useCaptionChrome } from "@/components/DesktopCapabilities";
import { VoiceSettings } from "./VoiceSettings";
import { Switch } from "./SettingsPrimitives";
import { ProfileAvatar } from "./bot-settings/ProfileAvatar";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";

type RemoteProfilePatch = Partial<
  Pick<Bot, "name" | "title" | "description" | "avatarUrl" | "avatarCrop" | "voice" | "speakReplies" | "notifications">
>;

export function RemoteAgentSettingsPanel({ bot, overlay = false }: {
  bot: Bot;
  overlay?: boolean;
}) {
  const { dispatch } = useStore();
  const { padClass } = useCaptionChrome();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const pendingPatch = useRef<RemoteProfilePatch | null>(null);
  const patchQueue = useRef<Promise<void> | null>(null);

  const close = () => dispatch({ type: "toggleSettings", open: false });
  const patch = (next: RemoteProfilePatch): Promise<void> => {
    pendingPatch.current = { ...pendingPatch.current, ...next };
    if (patchQueue.current) return patchQueue.current;
    setSaving(true);
    setError("");
    const drain = async () => {
      while (pendingPatch.current) {
        const current = pendingPatch.current;
        pendingPatch.current = null;
        setError("");
        try {
          const result: { bot: Bot } = await api(`/api/bots/${bot.id}/profile`, {
            method: "PATCH",
            body: JSON.stringify(current),
          });
          dispatch({ type: "botPatched", bot: result.bot });
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : "Could not update this agent.");
        }
      }
    };
    patchQueue.current = drain().finally(() => {
      patchQueue.current = null;
      setSaving(false);
    });
    return patchQueue.current;
  };


  return (
    <aside className={cn(
      "animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel",
      overlay ? "md:left-auto md:w-[400px] md:shadow-2xl" : "md:relative md:z-20 md:w-[400px] md:shrink-0",
    )}>
      <div className={cn("flex items-center justify-between px-4 py-3", padClass)}>
        <button
          onClick={close}
          aria-label="Collapse remote agent settings"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[15px] font-semibold text-ink">Remote agent settings</span>
        <button
          onClick={close}
          aria-label="Close remote agent settings"
          className="flex size-10 items-center justify-center rounded-md text-ink-secondary hover:bg-control hover:text-ink"
        >
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <div className="flex flex-col gap-4 pt-4">
          <div className="rounded-xl bg-card p-4">
            <div className="mb-4 flex justify-center">
              <ProfileAvatar bot={bot} state="idle" onPatch={(next) => void patch(next)} />
            </div>
            <label className="block text-[12px] font-medium text-ink-secondary">Name
              <input key={bot.id} defaultValue={bot.name} maxLength={BOT_PROFILE_LIMITS.name} onBlur={(event) => { const name = event.currentTarget.value.trim(); if (name && name !== bot.name) void patch({ name }); }} className="mt-1 w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent" />
            </label>
            <label className="mt-3 block text-[12px] font-medium text-ink-secondary">Title
              <input key={bot.id} defaultValue={bot.title ?? ""} maxLength={BOT_PROFILE_LIMITS.title} onBlur={(event) => { if (event.currentTarget.value !== (bot.title ?? "")) void patch({ title: event.currentTarget.value }); }} className="mt-1 w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent" />
            </label>
            <label className="mt-3 block text-[12px] font-medium text-ink-secondary">Description
              <textarea key={bot.id} defaultValue={bot.description ?? ""} maxLength={BOT_PROFILE_LIMITS.description} rows={4} onBlur={(event) => { if (event.currentTarget.value !== (bot.description ?? "")) void patch({ description: event.currentTarget.value }); }} className="mt-1 w-full resize-y rounded-lg bg-inset px-3 py-2 text-[13px] leading-relaxed text-ink focus:outline-none focus:ring-1 focus:ring-accent" />
            </label>
          </div>

          <VoiceSettings
            bot={bot}
            workspaceConfigurationLocked
            onPatch={(next) => void patch(next)}
          />

          <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
            <div className="flex min-w-0 items-start gap-3">
              <Bell size={16} className="mt-0.5 shrink-0 text-ink-secondary" />
              <div>
                <div className="text-[15px] font-medium text-ink">Notifications</div>
                <div className="mt-0.5 text-[12px] leading-relaxed text-ink-secondary">
                  Enable completion and attention notifications for this agent on the host and paired clients.
                </div>
              </div>
            </div>
            <Switch
              checked={bot.notifications}
              disabled={saving}
              aria-label="Agent notifications"
              onClick={() => void patch({ notifications: !bot.notifications })}
            />
          </div>

          {error ? <div role="alert" className="text-[12px] text-danger">{error}</div> : null}
        </div>
      </div>
    </aside>
  );
}
