import { useEffect, useRef, useState } from "react";
import type { CloudLendingBridge, CloudLendingSnapshot, LendingActivityEntry } from "../../electron/computer-sharing.mjs";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { Switch } from "./SettingsPrimitives";

const ACTIONS: Record<string, LocaleKey> = {
  list_files: "lending.action.listFiles",
  read_file: "lending.action.readFile",
  write_file: "lending.action.writeFile",
  run_command: "lending.action.runCommand",
  computer_tools: "lending.action.screenTools",
  computer_call: "lending.action.screen",
  invalid: "lending.action.invalid",
};

export function lendingStatusKey(snapshot: CloudLendingSnapshot | null): LocaleKey | null {
  const state = snapshot?.state;
  if (!state) return null;
  if (!state.on) return "lending.mac.off";
  if (state.busy) return "lending.mac.busy";
  if (state.connected) return "lending.mac.ready";
  if (state.problem === "asleep") return "lending.mac.resting";
  if (state.problem === "paused" || state.problem === "signed-out") return "lending.status.paused";
  return "lending.mac.connecting";
}

export function lendingActionKey(action: string): LocaleKey {
  return Object.hasOwn(ACTIONS, action) ? ACTIONS[action]! : "lending.action.other";
}

export function lendingTime(at: number, now = Date.now()): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(activeLocale(), sameDay ? { timeStyle: "short" } : { dateStyle: "short", timeStyle: "short" }).format(new Date(at));
}

function LendingActivity({ entries }: { entries: LendingActivityEntry[] }) {
  return <div data-lending-activity className="flex flex-col gap-1.5">
    <p className="text-[13px] font-medium text-ink">{t("lending.activity.title")}</p>
    {entries.length === 0
      ? <p className="text-[12px] text-ink-secondary">{t("lending.activity.empty")}</p>
      : <ul aria-label={t("lending.activity.title")} className="flex max-h-48 flex-col gap-1 overflow-y-auto text-[12px]">
        {entries.map((entry, index) => <li key={`${entry.at}-${index}`} className="flex flex-wrap gap-x-2 text-ink-secondary">
          <time dateTime={new Date(entry.at).toISOString()} className="shrink-0 tabular-nums">{lendingTime(entry.at)}</time>
          <span className={entry.ok ? "text-ink" : "text-danger"}>{t(lendingActionKey(entry.action))}{entry.ok ? "" : ` · ${t("lending.activity.refused")}`}</span>
          {entry.detail && <span dir="auto" className="min-w-0 break-all">{entry.detail}</span>}
        </li>)}
      </ul>}
  </div>;
}

export function CloudLending({ bridge }: { bridge: CloudLendingBridge }) {
  const [snapshot, setSnapshot] = useState<CloudLendingSnapshot | null>(null);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false), mounted = useRef(false);
  const accept = (next: CloudLendingSnapshot) => { if (mounted.current && !pending.current) setSnapshot(next); };
  useEffect(() => {
    mounted.current = true;
    const refresh = () => void bridge.state().then(accept).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [bridge]);
  const state = snapshot?.state;
  const on = state?.on !== false;
  const toggle = () => {
    if (pending.current) return;
    pending.current = true; setWorking(true); setFailed(false);
    void bridge.setHome(!on)
      .then((next) => { pending.current = false; accept(next); })
      .catch(() => { if (mounted.current) setFailed(true); })
      .finally(() => { pending.current = false; if (mounted.current) setWorking(false); });
  };
  if (!snapshot?.available) return null;
  const status = lendingStatusKey(snapshot);
  const activity = snapshot.activity ?? [];
  return <div data-cloud-lending={on ? "on" : "off"} className="flex flex-col gap-3 border-t border-hairline/40 py-4">
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{t("lending.title")}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("lending.explain")}</p>
      </div>
      <Switch checked={on} disabled={working} aria-label={t("lending.title")} onClick={toggle} />
    </div>
    {status && <p role="status" data-lending-status={status.slice(status.lastIndexOf(".") + 1)}
      className={state?.busy && on ? "text-[13px] font-medium text-ink" : "text-[13px] text-ink-secondary"}>
      {t(status, { name: state?.name || t("lending.mac.thisMac") })}
    </p>}
    {on && !snapshot.screenAvailable && <p data-lending-apps-off className="text-[12px] leading-relaxed text-ink-secondary">
      {t("lending.mac.appsOff")}
    </p>}
    {failed && <p role="alert" className="text-[13px] text-danger">{t("lending.failed")}</p>}
    {(on || activity.length > 0) && <LendingActivity entries={activity} />}
  </div>;
}
