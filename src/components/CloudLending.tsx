import { useEffect, useRef, useState } from "react";
import { FolderPlus, X } from "lucide-react";
import type { CloudLendingBridge, CloudLendingSnapshot, LendingActivityEntry, SharedFolder } from "../../electron/computer-sharing.mjs";
import { activeLocale, t } from "@/lib/i18n";
import type { LocaleKey } from "@/locales";
import { Switch } from "./SettingsPrimitives";

const PROBLEMS: Partial<Record<string, LocaleKey>> = {
  "connect-first": "lending.status.connectFirst",
  "not-cloud": "lending.status.notCloud",
  waiting: "lending.status.waiting",
  paused: "lending.status.paused",
  "signed-out": "lending.status.signedOut",
  "account-changed": "lending.status.accountChanged",
  "machine-changed": "lending.status.machineChanged",
};

const ACTIONS: Record<string, LocaleKey> = {
  list_files: "lending.action.listFiles",
  read_file: "lending.action.readFile",
  write_file: "lending.action.writeFile",
  run_command: "lending.action.runCommand",
  computer_tools: "lending.action.screenTools",
  computer_call: "lending.action.screen",
  invalid: "lending.action.invalid",
};

export const LENDING_FOLDER_LIMIT = 20;

export function lendingStatusKey(snapshot: CloudLendingSnapshot | null, switchedOn: boolean): LocaleKey | null {
  const state = snapshot?.state;
  if (state?.enabled) {
    if (state.busy) return "lending.status.busy";
    if (state.connected) return "lending.status.lent";
    return PROBLEMS[state.problem ?? ""] ?? "lending.status.starting";
  }
  if (switchedOn) return "lending.status.chooseSomething";
  return state?.problem && state.problem !== "paused" ? PROBLEMS[state.problem] ?? null : null;
}

export function lendingActionKey(action: string): LocaleKey {
  return ACTIONS[action] ?? "lending.action.other";
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
  const [draftOn, setDraftOn] = useState(false);
  const [folders, setFolders] = useState<SharedFolder[]>([]);
  const [screen, setScreen] = useState(false);
  const [working, setWorking] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef(false), mounted = useRef(false);
  const accept = (next: CloudLendingSnapshot) => {
    if (!mounted.current) return;
    setSnapshot(next);
    if (!pending.current && next.state) { setFolders(next.state.folders); setScreen(next.state.screen); }
  };
  useEffect(() => {
    mounted.current = true;
    const refresh = () => void bridge.state().then(accept).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [bridge]);
  const perform = async (action: () => Promise<CloudLendingSnapshot>) => {
    if (pending.current) return;
    pending.current = true; setWorking(true); setFailed(false);
    try { const next = await action(); pending.current = false; accept(next); }
    catch { if (mounted.current) setFailed(true); }
    finally { pending.current = false; if (mounted.current) setWorking(false); }
  };
  const lend = (nextFolders: SharedFolder[], nextScreen: boolean) => {
    setFolders(nextFolders); setScreen(nextScreen);
    void perform(() => nextFolders.length || nextScreen ? bridge.save({ folders: nextFolders, screen: nextScreen }) : bridge.stop());
  };
  const enabled = snapshot?.state?.enabled === true;
  const on = enabled || draftOn;
  const toggle = () => {
    if (on) { setDraftOn(false); void perform(() => bridge.stop()); return; }
    setDraftOn(true);
    if (folders.length || screen) lend(folders, screen);
  };
  const addFolder = () => void perform(async () => {
    const folder = await bridge.chooseFolder();
    const next = folder && !folders.some((entry) => entry.path === folder.path) ? [...folders, folder] : folders;
    if (next === folders) return bridge.state();
    setFolders(next);
    return bridge.save({ folders: next, screen });
  });
  if (!snapshot?.available) return null;
  const status = lendingStatusKey(snapshot, on);
  return <div data-cloud-lending={enabled ? "on" : "off"} className="flex flex-col gap-3 border-t border-hairline/40 py-4">
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{t("lending.title")}</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-secondary">{t("lending.explain")}</p>
      </div>
      <Switch checked={on} disabled={working} aria-label={t("lending.title")} onClick={toggle} />
    </div>
    {status && <p role="status" className={enabled && snapshot.state?.busy ? "text-[13px] font-medium text-ink" : "text-[13px] text-ink-secondary"}>{t(status)}</p>}
    {on && <>
      <fieldset disabled={working} className="flex flex-col gap-2 disabled:opacity-60">
        <legend className="mb-1 text-[13px] font-medium text-ink">{t("lending.folders")}</legend>
        <p className="text-[12px] text-ink-secondary">{t("lending.foldersHelp")}</p>
        {folders.map((folder) => <div key={folder.id} data-lent-folder={folder.name} className="flex flex-wrap items-center gap-3 rounded-lg bg-inset px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">{folder.name}</p>
            <p dir="ltr" className="break-all text-[11px] text-ink-secondary">{folder.path}</p>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-ink-secondary">
            <input type="checkbox" className="accent-accent" checked={folder.write} onChange={(event) => lend(folders.map((entry) => entry.id === folder.id ? { ...entry, write: event.target.checked } : entry), screen)} />
            {t("lending.canEdit")}
          </label>
          <button type="button" aria-label={t("lending.removeFolder", { name: folder.name })} onClick={() => lend(folders.filter((entry) => entry.id !== folder.id), screen)}
            className="rounded p-1 text-ink-secondary hover:bg-control hover:text-ink"><X size={14} /></button>
        </div>)}
        <button type="button" disabled={folders.length >= LENDING_FOLDER_LIMIT} onClick={addFolder} className="ui-button flex w-fit items-center gap-2">
          <FolderPlus size={14} />{t("lending.addFolder")}
        </button>
      </fieldset>
      <fieldset disabled={working} className="flex flex-col gap-1 disabled:opacity-60">
        <label className="flex items-start gap-2">
          <input className="mt-1 accent-accent" type="checkbox" checked={screen} disabled={!screen && !snapshot.screenAvailable} onChange={(event) => lend(folders, event.target.checked)} />
          <span className="text-[13px] text-ink">{t("lending.screen")}<span className="mt-0.5 block text-[12px] text-ink-secondary">{t("lending.screenHelp")}</span></span>
        </label>
        {!snapshot.screenAvailable && <p className="ms-6 text-[12px] text-ink-secondary">{t("lending.screenUnavailable")}</p>}
      </fieldset>
      <p className="text-[12px] text-ink-secondary">{t("lending.stopHelp")}</p>
    </>}
    {failed && <p role="alert" className="text-[13px] text-danger">{t("lending.failed")}</p>}
    {(on || (snapshot.activity?.length ?? 0) > 0) && <LendingActivity entries={snapshot.activity ?? []} />}
  </div>;
}
