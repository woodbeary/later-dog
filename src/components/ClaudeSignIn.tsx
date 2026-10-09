import { useEffect, useState } from "react";
import { ExternalLink, Loader2, LogIn } from "lucide-react";
import { api } from "@/state/store";
import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { openExternalLink } from "@/lib/app-links";
import { deviceFlowUnavailable, type DeviceSignInStatus } from "./DeviceSignIn";

const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"];

/** Never turn arbitrary process output into a link: only Anthropic's own
 * sign-in pages over https. The server applies the same rule first. */
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

function endedFlow(phase: "expired" | "failed"): DeviceSignInStatus {
  return { phase, flowId: null, authorizationUrl: null, expiresAt: null, ...(phase === "failed" ? { message: t("engineSetup.device.flowEnded") } : {}) };
}

export interface ClaudeSignInProps {
  instanceId: string;
  /** Start the flow as soon as the card shows (the Add account sheet). */
  autoStart?: boolean;
  /** The sheet's shape: open link, "Waiting for the browser…", paste the code, Finish. */
  compact?: boolean;
  /** The account is signed in and the instance list refreshed. */
  onSignedIn?: () => void;
  /** The person cancelled, or the flow ended without a sign-in. */
  onCancelled?: () => void;
}

/** Claude sign-in through the browser: open Anthropic's sign-in page, paste
 * the code it shows, done. The server drives the unmodified CLI. */
export function ClaudeSignIn({ instanceId, autoStart = false, compact = false, onSignedIn, onCancelled }: ClaudeSignInProps) {
  const { refreshInstances, refreshModels } = useStore();
  const [auth, setAuth] = useState<DeviceSignInStatus | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"start" | "finish" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const base = `/api/instances/${encodeURIComponent(instanceId)}/auth`;
  const link = claudeSignInLink(auth?.authorizationUrl);

  const refresh = async () => {
    await refreshInstances();
    await refreshModels(instanceId);
  };

  /** Apply the outcome the server reports; a success refreshes the row. */
  const settle = async (next: DeviceSignInStatus) => {
    setAuth(next);
    setCode("");
    if (next.phase === "succeeded") {
      await refresh();
      onSignedIn?.();
    }
  };

  // Expire the link locally when the server says it does.
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

  const start = async () => {
    setBusy("start");
    setError(null);
    try {
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/start`, { method: "POST" });
      await settle(next);
      if (compact && next.phase === "waiting") {
        const page = claudeSignInLink(next.authorizationUrl);
        if (page) await openExternalLink(page);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("engineSetup.device.failed"));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!autoStart || started) return;
    setStarted(true);
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the sheet opens
  }, [autoStart, started]);

  const finish = async () => {
    if (!auth?.flowId) return;
    setBusy("finish");
    setError(null);
    try {
      // The server forgets a completed flow, so its answer here is the
      // outcome; a later status request would already be a 404.
      const completed: { auth?: DeviceSignInStatus } = await api(`${base}/complete`, { method: "POST", body: JSON.stringify({ flowId: auth.flowId, code: code.trim() }) });
      if (completed.auth) {
        await settle(completed.auth);
        return;
      }
      // An older server answers { ok: true } only: ask it.
      const { auth: next }: { auth: DeviceSignInStatus } = await api(`${base}/status?flowId=${encodeURIComponent(auth.flowId)}`);
      await settle(next);
    } catch (cause) {
      if (deviceFlowUnavailable(cause)) {
        // the server already knows the outcome; ask it rather than guess
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
      ? t("engineSetup.claude.connected")
      : auth.phase === "cancelled"
        ? t("engineSetup.device.cancelled")
        : auth.phase === "expired"
          ? t("engineSetup.device.expired")
          : auth.message || t("engineSetup.device.failed")
    : null;

  const codeField = (
    <>
      <label className="block text-[12px] text-ink-secondary" htmlFor={`claude-code-${instanceId}`}>
        {t(compact ? "accounts.sheet.pasteCode" : "engineSetup.claude.codeLabel")}
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
        {busy === "finish" ? t("engineSetup.claude.finishing") : t("engineSetup.claude.finish")}
      </button>
    </>
  );

  if (compact) {
    return (
      <div className="space-y-3" data-claude-sign-in>
        {outcome && <p role="status" className={auth?.phase === "succeeded" ? "text-[13px] text-success" : "text-[13px] text-ink-secondary"}>{outcome}</p>}
        {busy === "start" && !auth && (
          <p role="status" className="flex items-center gap-1.5 text-[13px] text-ink-secondary"><Loader2 size={13} className="animate-spin" /> {t("engineSetup.claude.starting")}</p>
        )}
        {auth?.phase === "waiting" && (link ? (
          <>
            <p role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-ink-secondary">
              <Loader2 size={13} className="animate-spin" /> {t("accounts.sheet.waiting")}
              <a href={link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-accent-text hover:underline" onClick={(event) => {
                if (window.laterdog?.openExternal) { event.preventDefault(); void openExternalLink(link); }
              }}>{t("accounts.sheet.reopen")} <ExternalLink size={12} /></a>
            </p>
            {codeField}
          </>
        ) : (
          <p role="alert" className="text-[13px] text-danger">{t("engineSetup.claude.invalidChallenge")}</p>
        ))}
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        {auth?.phase !== "succeeded" && (
          <div className="flex justify-end gap-2">
            {auth?.phase !== "waiting" && !busy && started && (
              <button type="button" onClick={() => void start()} className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45">
                {t("engineSetup.device.tryAgain")}
              </button>
            )}
            <button type="button" disabled={busy === "cancel"} onClick={() => void cancel()} className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45">
              {busy === "cancel" ? t("engineSetup.device.cancelling") : t("common.cancel")}
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2" data-claude-sign-in>
      {outcome ? (
        <p role="status" className={auth?.phase === "succeeded" ? "text-[12px] text-success" : "text-[12px] text-ink-secondary"}>{outcome}</p>
      ) : null}
      {auth?.phase === "waiting" ? (
        link ? (
          <div className="space-y-2 rounded-lg border border-hairline/50 bg-app p-3">
            <a href={link} target="_blank" rel="noopener noreferrer" className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110">
              {t("engineSetup.claude.open")} <ExternalLink size={13} />
            </a>
            {codeField}
            {auth.expiresAt && Number.isFinite(Date.parse(auth.expiresAt)) ? (
              <p className="text-[11px] text-ink-secondary">{t("engineSetup.device.expires", { time: new Date(auth.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}</p>
            ) : null}
            <p className="text-[11px] leading-relaxed text-ink-secondary">{t("engineSetup.claude.security")}</p>
            <button type="button" disabled={busy !== null} onClick={() => void cancel()} className="w-full rounded-lg bg-control px-3 py-2 text-[12px] font-medium text-ink disabled:opacity-50">
              {busy === "cancel" ? t("engineSetup.device.cancelling") : t("engineSetup.device.cancel")}
            </button>
          </div>
        ) : (
          <p role="alert" className="text-[12px] text-danger">{t("engineSetup.claude.invalidChallenge")}</p>
        )
      ) : auth?.phase !== "succeeded" ? (
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void start()}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <LogIn size={14} />}
          {busy === "start" ? t("engineSetup.claude.starting") : t("engineSetup.claude.start")}
        </button>
      ) : null}
      {error ? <p role="alert" className="text-[12px] text-danger">{error}</p> : null}
    </div>
  );
}
