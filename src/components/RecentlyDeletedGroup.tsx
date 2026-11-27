import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { SettingRow, SettingsGroup, SettingsRows } from "./SettingsPrimitives";

export interface RecentlyDeletedDog {
  id: string;
  name: string;
  at: number;
  purgeAt: number;
}

const DAY_MS = 24 * 60 * 60_000;

export function RecentlyDeletedGroup({ now = () => Date.now() }: { now?: () => number }) {
  const [dogs, setDogs] = useState<RecentlyDeletedDog[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void api<{ dogs: RecentlyDeletedDog[] }>("/api/recently-deleted", { timeoutMs: 5_000 }).then((next) => { if (alive) setDogs(next.dogs); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const restore = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setFailed(false);
    try {
      setDogs((await api<{ dogs: RecentlyDeletedDog[] }>(`/api/recently-deleted/${encodeURIComponent(id)}/restore`, { method: "POST" })).dogs);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };

  if (!dogs.length) return null;
  return (
    <SettingsGroup label={t("settings.group.recentlyDeleted")} testId="recently-deleted">
      <SettingsRows>
        {dogs.map((dog) => (
          <SettingRow
            key={dog.id}
            title={dog.name}
            subtitle={t("settings.recentlyDeleted.days", { days: String(Math.max(1, Math.ceil((dog.purgeAt - now()) / DAY_MS))) })}
            message={failed && busy === null && <span role="alert" className="text-danger">{t("settings.recentlyDeleted.error")}</span>}
          >
            <button
              onClick={() => void restore(dog.id)}
              disabled={busy !== null}
              data-restore={dog.id}
              className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover disabled:opacity-45"
            >
              {t("settings.recentlyDeleted.restore")}
            </button>
          </SettingRow>
        ))}
      </SettingsRows>
    </SettingsGroup>
  );
}
