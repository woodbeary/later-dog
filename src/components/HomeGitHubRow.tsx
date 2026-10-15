import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { api, useStore } from "@/state/store";
import { openExternalLink } from "@/lib/app-links";
import { useCopyFeedback } from "@/lib/copy-text";
import { t } from "@/lib/i18n";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { SettingRow } from "./SettingsPrimitives";

export const HOME_GITHUB_PATH = "/api/home/github";
export const GITHUB_DEVICE_PAGE = "https://github.com/login/device";
export const GITHUB_DEVICE_PAGE_LABEL = "github.com/login/device";
export const HOME_GITHUB_POLL_MS = 3000;

export interface HomeGitHubSignIn { phase: "idle" | "waiting" | "done" | "failed"; code?: string; url?: string; detail?: string }
export interface HomeGitHubStatus { login: string | null; signIn: HomeGitHubSignIn; detail?: string }

export type HomeGitHubView =
  | { kind: "checking" }
  | { kind: "waiting"; code: string }
  | { kind: "connected"; login: string; note?: string }
  | { kind: "disconnected"; problem?: string };

export function homeGitHubView(status: HomeGitHubStatus | null): HomeGitHubView {
  if (!status) return { kind: "checking" };
  if (status.signIn.phase === "waiting" && status.signIn.code) return { kind: "waiting", code: status.signIn.code };
  if (status.login) return { kind: "connected", login: status.login, ...(status.signIn.phase === "done" && status.signIn.detail ? { note: status.signIn.detail } : {}) };
  const problem = status.signIn.phase === "failed" ? status.signIn.detail : status.detail;
  return { kind: "disconnected", ...(problem ? { problem } : {}) };
}

const reason = (error: unknown) => error instanceof Error && error.message ? error.message : t("settings.github.failed");
const openDevicePage = () => void openExternalLink(GITHUB_DEVICE_PAGE).catch(() => {});

function SignInCode({ code }: { code: string }) {
  const { state, copy } = useCopyFeedback(code);
  return (
    <div className="flex items-center gap-2 rounded-lg bg-inset px-3 py-2">
      <code data-home-github-code className="min-w-0 flex-1 select-all font-mono text-[15px] tracking-[0.15em] text-ink">{code}</code>
      <button type="button" onClick={copy} aria-label={t(state === "failed" ? "common.copyFailed" : "settings.github.copyCode")} className="ui-icon-button shrink-0">
        {state === "copied" ? <Check size={13} className="text-success" /> : state === "failed" ? <X size={13} className="text-danger" /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function DevicePageLine() {
  return (
    <p className="text-[12px] leading-relaxed text-ink-secondary">
      {t("settings.github.enterAt")}{" "}
      <button type="button" data-home-github-link className="font-medium text-ink underline underline-offset-2 hover:opacity-80" onClick={openDevicePage}>{GITHUB_DEVICE_PAGE_LABEL}</button>
    </p>
  );
}

export function HomeGitHubSetting() {
  const [status, setStatus] = useState<HomeGitHubStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const alive = useRef(true);
  const view = homeGitHubView(status);

  const refresh = useCallback(async () => {
    try {
      const next = await api<HomeGitHubStatus>(HOME_GITHUB_PATH);
      if (alive.current) setStatus(next);
    } catch (error) {
      if (!alive.current) return;
      setStatus((current) => current ?? { login: null, signIn: { phase: "idle" } });
      setFailed(reason(error));
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => { alive.current = false; };
  }, [refresh]);

  useEffect(() => {
    if (view.kind !== "waiting") return;
    const timer = setInterval(() => void refresh(), HOME_GITHUB_POLL_MS);
    return () => clearInterval(timer);
  }, [view.kind, refresh]);

  const act = async (path: string): Promise<HomeGitHubStatus | null> => {
    setBusy(true);
    setFailed(null);
    try {
      const next = await api<HomeGitHubStatus>(path, { method: "POST", body: "{}" });
      if (alive.current) setStatus(next);
      return next;
    } catch (error) {
      if (alive.current) setFailed(reason(error));
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const connect = async () => {
    const next = await act(`${HOME_GITHUB_PATH}/connect`);
    if (next?.signIn.phase === "waiting" && next.signIn.url === GITHUB_DEVICE_PAGE) openDevicePage();
  };

  const title = view.kind === "connected" ? t("settings.github.connectedTitle", { login: view.login })
    : view.kind === "waiting" ? t("settings.github.waitingTitle")
    : view.kind === "checking" ? t("settings.github.checking")
    : t("settings.github.notConnected");
  const subtitle = view.kind === "connected" ? t("settings.github.connected")
    : view.kind === "waiting" ? t("settings.github.waiting")
    : t("settings.github.intro");
  const problem = failed ?? (view.kind === "disconnected" ? view.problem : view.kind === "connected" ? view.note : undefined);
  const message = (view.kind === "waiting" || problem) ? (
    <div className="flex flex-col gap-2">
      {view.kind === "waiting" && <SignInCode code={view.code} />}
      {view.kind === "waiting" && <DevicePageLine />}
      {problem && <p role="alert" className="text-danger">{problem}</p>}
    </div>
  ) : undefined;

  return (
    <div data-home-github={view.kind} className="border-t border-hairline/40 first:border-t-0">
      <SettingRow title={title} subtitle={subtitle} message={message}>
        {view.kind === "connected" && <button type="button" disabled={busy} className="ui-button" onClick={() => void act(`${HOME_GITHUB_PATH}/disconnect`)}>{t("settings.github.disconnect")}</button>}
        {view.kind === "waiting" && <button type="button" className="ui-button" onClick={openDevicePage}>{t("settings.github.open")}</button>}
        {view.kind === "disconnected" && <button type="button" disabled={busy} className="ui-button" onClick={() => void connect()}>{t("settings.github.connect")}</button>}
      </SettingRow>
    </div>
  );
}

export function useHomeGitHubShown(): boolean {
  const { state } = useStore();
  const owner = useOwnerOrAdmin();
  return state.config?.cloudHome === true && owner === true;
}
