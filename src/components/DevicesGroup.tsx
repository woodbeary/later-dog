import { useEffect, useState, type FormEvent } from "react";
import { Globe, Laptop, Loader2, Pencil, Smartphone } from "lucide-react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { relativeTime } from "@/lib/memory";
import { api, ApiError } from "@/state/store";
import { SettingsGroup, SettingsRows } from "./SettingsPrimitives";

export interface SignedInDevice {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  email?: string;
}

export type DeviceKind = "phone" | "computer" | "browser";

export function deviceKind(label: string): DeviceKind {
  if (/\b(iphone|ipad|android|phone)\b/i.test(label)) return "phone";
  if (/\b(mac|windows|linux|laptop|computer|desktop)\b/i.test(label)) return "computer";
  return "browser";
}

export function orderedDevices(devices: readonly SignedInDevice[], current: string | null): SignedInDevice[] {
  return [...devices].sort((a, b) => Number(b.id === current) - Number(a.id === current) || b.lastSeenAt - a.lastSeenAt);
}

const ICONS = { phone: Smartphone, computer: Laptop, browser: Globe } as const;
const quietButtonCls = "rounded-lg px-2.5 py-1.5 text-[12.5px] text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 motion-reduce:transition-none";

export function DevicesGroup() {
  const [list, setList] = useState<{ sessions: SignedInDevice[]; current: string | null } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<{ sessions: SignedInDevice[]; current: string | null }>("/api/auth/sessions", { timeoutMs: 15_000 })
      .then((next) => { if (active) { setList(next); setFailed(false); } })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);

  const remove = async (device: SignedInDevice) => {
    if (busy || !window.confirm(t("devices.removeConfirm", { name: device.label }))) return;
    setBusy(device.id);
    setNote(null);
    try {
      await api(`/api/auth/sessions/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      setList((current) => current && { ...current, sessions: current.sessions.filter((entry) => entry.id !== device.id) });
    } catch {
      setNote(t("devices.removeFailed"));
    } finally {
      setBusy(null);
    }
  };

  const renamed = (device: SignedInDevice) => {
    setList((current) => current && { ...current, sessions: current.sessions.map((entry) => (entry.id === device.id ? { ...entry, label: device.label } : entry)) });
    setEditing(null);
  };

  return (
    <SettingsGroup label={t("devices.title")} testId="devices">
      <p className="px-4 pb-1 text-[12.5px] leading-relaxed text-ink-secondary">{t("devices.hint")}</p>
      <SettingsRows data-devices="">
        {!list ? (
          <div className="flex items-center gap-2 py-4 text-[13px] text-ink-secondary">
            {failed ? (
              <>
                {t("devices.loadFailed")}
                <button type="button" onClick={() => { setFailed(false); setAttempt((value) => value + 1); }} className="underline transition-opacity hover:opacity-80">{t("devices.retry")}</button>
              </>
            ) : <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          </div>
        ) : list.sessions.length === 0 ? (
          <p className="py-4 text-[13px] text-ink-secondary">{t("devices.empty")}</p>
        ) : orderedDevices(list.sessions, list.current).map((device) => {
          const Icon = ICONS[deviceKind(device.label)];
          const mine = device.id === list.current;
          return editing === device.id ? (
            <RenameForm key={device.id} device={device} onSaved={renamed} onCancel={() => setEditing(null)} />
          ) : (
            <div key={device.id} data-device={device.id} className="flex items-center gap-3 border-t border-hairline/40 py-3 first:border-t-0">
              <Icon size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] text-ink">{device.label}</div>
                <div className="truncate text-[12px] text-ink-secondary">
                  {mine ? t("devices.thisDevice") : t("devices.lastSeen", { when: relativeTime(device.lastSeenAt) })}
                </div>
              </div>
              <button type="button" onClick={() => setEditing(device.id)} aria-label={t("devices.rename", { name: device.label })} className="ui-icon-button shrink-0">
                <Pencil size={14} aria-hidden="true" />
              </button>
              {!mine && (
                <button type="button" disabled={busy !== null} onClick={() => void remove(device)} className={cn(quietButtonCls, "text-danger hover:text-danger")}>
                  {busy === device.id ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t("devices.remove")}
                </button>
              )}
            </div>
          );
        })}
      </SettingsRows>
      {note && <p role="alert" className="px-4 text-[12px] text-danger">{note}</p>}
    </SettingsGroup>
  );
}

function RenameForm({ device, onSaved, onCancel }: { device: SignedInDevice; onSaved: (device: SignedInDevice) => void; onCancel: () => void }) {
  const [label, setLabel] = useState(device.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = label.trim().length > 0 && label.trim() !== device.label && !busy;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ session: SignedInDevice }>(`/api/auth/sessions/${encodeURIComponent(device.id)}`, { method: "PATCH", body: JSON.stringify({ label }) });
      onSaved(result.session);
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof ApiError && failure.status === 400 ? failure.message : t("devices.saveFailed"));
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-2 border-t border-hairline/40 py-3 first:border-t-0">
      <input
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        maxLength={60}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        aria-label={t("devices.rename", { name: device.label })}
        className="h-9 w-full rounded-lg border-[0.5px] border-ink/15 bg-composer px-3 text-[13.5px] text-ink outline-none transition-colors focus:border-accent motion-reduce:transition-none"
      />
      {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={quietButtonCls}>{t("common.cancel")}</button>
        <button type="submit" disabled={!ready} className="flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-app transition-opacity hover:opacity-90 disabled:opacity-40 motion-reduce:transition-none">
          {busy && <Loader2 size={12} className="animate-spin" aria-hidden="true" />}
          {t("common.save")}
        </button>
      </div>
    </form>
  );
}
