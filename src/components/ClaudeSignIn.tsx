import { useEffect, useState } from "react";
import { ExternalLink, Loader2, LogIn } from "lucide-react";
import { api } from "@/state/store";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import type { LocaleKey } from "@/locales";
import { deviceFlowUnavailable, type DeviceSignInStatus } from "./DeviceSignIn";

const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"];
const GOOGLE_SIGN_IN_HOST = "accounts.google.com";

export type PasteSignInProvider = "claude" | "google";

const PASTE_SIGN_IN_PROVIDERS: Partial<Record<string, PasteSignInProvider>> = { claudeAgent: "claude", antigravityAgent: "google" };

export function pasteSignInProvider(driverKind: string): PasteSignInProvider | null {
  return PASTE_SIGN_IN_PROVIDERS[driverKind] ?? null;
}

export const PASTE_SIGN_IN_COPY: Record<PasteSignInProvider, Record<"description" | "start" | "open" | "codeLabel" | "compactCodeLabel" | "finishing" | "security" | "connected" | "invalidChallenge", LocaleKey>> = {
  claude: {
    description: "engineSetup.claude.description",
    start: "engineSetup.claude.start",
    open: "engineSetup.claude.open",
    codeLabel: "engineSetup.claude.codeLabel",
    compactCodeLabel: "accounts.sheet.pasteCode",
    finishing: "engineSetup.claude.finishing",
    security: "engineSetup.claude.security",
    connected: "engineSetup.claude.connected",
    invalidChallenge: "engineSetup.claude.invalidChallenge",
  },
  google: {
    description: "engineSetup.google.description",
    start: "engineSetup.signInGoogle",
    open: "engineSetup.google.open",
    codeLabel: "engineSetup.google.codeLabel",
    compactCodeLabel: "engineSetup.google.codeLabel",
    finishing: "engineSetup.google.finishing",
    security: "engineSetup.google.security",
    connected: "engineSetup.google.connected",
    invalidChallenge: "engineSetup.google.invalidChallenge",
  },
};

export function googleSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const authority = value.trim().slice("https://".length).split(/[/?#\\]/, 1)[0]?.toLowerCase();
    return url.protocol === "https:" && url.hostname === GOOGLE_SIGN_IN_HOST && authority === GOOGLE_SIGN_IN_HOST ? url.href : null;
  } catch {
    return null;
  }
}

export function claudeSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trusted = SIGN_IN_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    return url.protocol === "https:" && trusted && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function claudeCallbackLink(value: string | null | undefined): string | null {
  const link = claudeSignInLink(value);
  if (!link) return null;
  try {
    const redirect = new URL(new URL(link).searchParams.get("redirect_uri") ?? "");
    return redirect.protocol === "http:" && (redirect.hostname === "localhost" || redirect.hostname === "127.0.0.1") ? link : null;
  } catch {
    return null;
  }
}

function endedFlow(phase: "expired" | "failed"): DeviceSignInStatus {
  return { phase, flowId: null, authorizationUrl: null, expiresAt: null, ...(phase === "failed" ? { message: t("engineSetup.device.flowEnded") } : {}) };
}

export interface ClaudeSignInProps {
  instanceId: string;
  provider?: PasteSignInProvider;
  autoStart?: boolean;
  compact?: boolean;
  onSignedIn?: () => void;
  onCancelled?: () => void;
}

export function ClaudeSignIn({ instanceId, provider = "claude", autoStart = false, compact = false, onSignedIn, onCancelled }: ClaudeSignInProps) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"start" | "finish" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [autoStarted] = useState(() => ({ current: false }));
  const [withCode, setWithCode] = useState(false);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;
  const copy = PASTE_SIGN_IN_COPY[provider];
  const signInLink = provider === "google" ? googleSignInLink : claudeSignInLink;
  const callback = withCode || provider !== "claude" ? null : claudeCallbackLink(auth?.callbackUrl);
  const link = callback ?? signInLink(auth?.authorizationUrl);

  const refresh = async () => {
    await refreshInstances();
    await refreshModels(instanceId);
  };

  const settle = async (next: DeviceSignInStatus) => {
    setAuth(next);
    setCode("");
    if (next.phase === "succeeded") {
      await refresh();
      onSignedIn?.();
    }
  };

  useEffect(() => {
    if (auth?.phase !== "waiting" || !auth.flowId) return;
    const remaining = auth.expiresAt ? Date.parse(auth.expiresAt) - Date.now() : Number.NaN;
    const expiryTimer = Number.isFinite(remaining)
      ? window.setTimeout(() => {
          setAuth(endedFlow("expired"));
          setError(null);
        }, Math.max(0, remaining))
      : null;
    return () => {
      if (expiryTimer !== null) window.clearTimeout(expiryTimer);
    };
  }, [auth]);

  useEffect(() => {
    if (auth?.phase !== "waiting" || !auth.flowId || !callback) return;
    const flowId = auth.flowId;
    const timer = window.setInterval(() => {
      void api<{ auth: DeviceSignInStatus }>(`${base}/status?flowId=${encodeURIComponent(flowId)}`)
        .then(({ auth: next }) => { if (next.phase !== "waiting") void settle(next); })
        .catch((cause: unknown) => { if (deviceFlowUnavailable(cause)) setAuth(endedFlow("failed")); });
    }, 1_500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one watcher per flow
  }, [auth?.phase, auth?.flowId, callback, base]);

  const start = async () => {
    setBusy("start");
    setError(null);
    setWithCode(false);
    try {
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/start`, { method: "POST" });
      await settle(next);
      if (next.phase === "waiting") {
        const page = provider !== "claude" ? null : claudeCallbackLink(next.callbackUrl) ?? (compact ? claudeSignInLink(next.authorizationUrl) : null);
        if (page) await openExternalLink(page);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!autoStart || started || autoStarted.current) return;
    autoStarted.current = true;
    setStarted(true);
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the sheet opens
  }, [autoStart, started]);

  const finish = async () => {
    if (!auth?.flowId) return;
    setBusy("finish");
    setError(null);
    try {
      const completed: { auth?: DeviceSignInStatus } = await api(`${base}/complete`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId, code: code.trim() }) });
      if (completed.auth) {
        await settle(completed.auth);
        return;
      }
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/status?flowId=${encodeURIComponent(auth.flowId)}`);
      await settle(next);
    } catch (cause) {
      if (deviceFlowUnavailable(cause)) {
        try {
          const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/status?flowId=${encodeURIComponent(auth.flowId)}`);
          await settle(next);
          return;
        } catch {
          setAuth(endedFlow("failed"));
          return;
        }
      }
      setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!auth?.flowId) {
      onCancelled?.();
      return;
    }
    setBusy("cancel");
    setError(null);
    try {
      await api(`${base}/cancel`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId }) });
      setAuth({ phase: "cancelled", flowId: null, authorizationUrl: null, expiresAt: null });
      onCancelled?.();
    } catch (cause) {
      if (deviceFlowUnavailable(cause)) setAuth(endedFlow("failed"));
      else setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally {
      setBusy(null);
    }
  };

  const outcome = auth && auth.phase !== "waiting"
    ? auth.phase === "succeeded"
      ? t(copy.connected)
      : auth.phase === "cancelled"
        ? t("engineSetup.device.cancelled")
        : auth.phase === "expired"
          ? t("engineSetup.device.expired")
          : auth.message || t("engineSetup.device.failed")
    : null;

  const codeField = (
    <>
      <label className="block text-[12px] text-ink-secondary" htmlFor={`claude-code-${instanceId}`}>
        {t(compact ? copy.compactCodeLabel : copy.codeLabel)}
      </label>
      <input
        id={`claude-code-${instanceId}`}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        autoComplete="off"
        spellCheck={false}
        className="w-full rounded-md border border-hairline/40 bg-inset px-3 py-2 font-mono text-[13px] text-ink outline-none focus:border-accent-border"
      />
      <button
        type="button"
        disabled={busy !== null || code.trim().length < 8}
        onClick={() => void finish()}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
      >
        {busy === "finish" ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
        {busy === "finish" ? t(copy.finishing) : t("engineSetup.claude.finish")}
      </button>
    </>
  );

  if (compact) {
    return (
      <div className="space-y-3" data-paste-sign-in={provider}>
        {outcome && <p role="status" className={auth?.phase === "succeeded" ? "text-[13px] text-success" : "text-[13px] text-ink-secondary"}>{outcome}</p>}
        {busy === "start" && !auth && (
          <p role="status" className="flex items-center gap-1.5 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> {t("engineSetup.claude.starting")}</p>
        )}
        {auth?.phase === "waiting" && (link ? provider === "google" ? (
          <>
            <a href={link} target="_blank" rel="noopener noreferrer" data-sign-in-link className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-center text-[12.5px] font-semibold text-white hover:brightness-110" onClick={(event) => {
              if (window.laterdog?.openExternal) { event.preventDefault(); void openExternalLink(link); }
            }}>
              {t(copy.open)} <ExternalLink size={13} className="shrink-0" />
            </a>
            {codeField}
          </>
        ) : (
          <>
            <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary">
              <Loader2 size={13} className="animate-spin" /> {t("accounts.sheet.waiting")}
              <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline" onClick={(event) => {
                if (window.laterdog?.openExternal) { event.preventDefault(); void openExternalLink(link); }
              }}>{t("accounts.sheet.reopen")} <ExternalLink size={12} /></a>
            </p>
            {callback ? (
              <button type="button" onClick={() => {
                setWithCode(true);
                const page = claudeSignInLink(auth.authorizationUrl);
                if (page) void openExternalLink(page);
              }} className="text-[12px] text-ink-tertiary hover:text-ink-secondary">
                {t("accounts.sheet.useCode")}
              </button>
            ) : codeField}
          </>
        ) : (
          <p role="alert" className="text-[13px] text-danger">{t(copy.invalidChallenge)}</p>
        ))}
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        {auth?.phase !== "succeeded" && (
          <div className="flex justify-end gap-2">
            {auth?.phase !== "waiting" && !busy && started && (
              <button type="button" onClick={() => void start()} className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover disabled:opacity-45">
                {t("engineSetup.device.tryAgain")}
              </button>
            )}
            <button type="button" disabled={busy === "cancel"} onClick={() => void cancel()} className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover disabled:opacity-45">
              {busy === "cancel" ? t("engineSetup.device.cancelling") : t("common.cancel")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2" data-paste-sign-in={provider}>
      {outcome ? (
        <p role="status" className={auth?.phase === "succeeded" ? "text-[12px] text-success" : "text-[12px] text-ink-secondary"}>{outcome}</p>
      ) : null}
      {auth?.phase === "waiting" ? (
        callback ? (
          <div className="space-y-2">
            <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-secondary">
              <Loader2 size={13} className="animate-spin" /> {t("accounts.sheet.waiting")}
              <button type="button" onClick={() => void openExternalLink(callback)} className="inline-flex items-center gap-1 text-accent-text hover:underline">
                {t("accounts.sheet.reopen")} <ExternalLink size={12} />
              </button>
            </p>
            <div className="flex gap-3">
              <button type="button" onClick={() => {
                setWithCode(true);
                const page = claudeSignInLink(auth.authorizationUrl);
                if (page) void openExternalLink(page);
              }} className="text-[12px] text-ink-tertiary hover:text-ink-secondary">
                {t("accounts.sheet.useCode")}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => void cancel()} className="text-[12px] text-ink-tertiary hover:text-ink-secondary">
                {t("common.cancel")}
              </button>
            </div>
          </div>
        ) : link ? (
          <div className="space-y-2 rounded-lg border border-hairline/50 bg-app p-3">
            <a href={link} target="_blank" rel="noopener noreferrer" data-sign-in-link className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-center text-[12.5px] font-semibold text-white hover:brightness-110">
              {t(copy.open)} <ExternalLink size={13} className="shrink-0" />
            </a>
            {codeField}
            {auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt)) ? (
              <p className="text-[11px] text-ink-secondary">{t("engineSetup.device.expires", { time: new Date(auth.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p>
            ) : null}
            <p className="text-[11px] leading-relaxed text-ink-secondary">{t(copy.security)}</p>
            <button type="button" disabled={busy !== null} onClick={() => void cancel()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50 transition-colors enabled:hover:bg-control-hover">
              {busy === "cancel" ? t("engineSetup.device.cancelling") : t("engineSetup.device.cancel")}
            </button>
          </div>
        ) : (
          <p role="alert" className="text-[12px] text-danger">{t(copy.invalidChallenge)}</p>
        )
      ) : auth?.phase !== "succeeded" ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void start()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
          {busy === "start" ? t("engineSetup.claude.starting") : t(copy.start)}
        </button>
      ) : null}
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
