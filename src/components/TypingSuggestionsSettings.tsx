import { useEffect, useRef, useState } from "react";
import { api, useStore, type ConfigStatus } from "@/state/store";
import { typingSuggestionsEnabled } from "@/lib/feature-flags";
import { forgetPhrases } from "@/lib/typing-suggestions";
import { t } from "@/lib/i18n";
import { SettingRow, Switch } from "./SettingsPrimitives";

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const FIELD = "w-full rounded-lg border border-hairline bg-inset px-3 py-2 text-[13px] text-ink outline-none focus:border-accent/60";

type Checked = { ok: true; ms: number } | { ok: false; reason: string };

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

function SwitchRow() {
  const { state, dispatch } = useStore();
  const mounted = useMounted();
  const on = typingSuggestionsEnabled(state.config);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [forgotten, setForgotten] = useState(false);
  const toggle = async () => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      const config: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ features: { typingSuggestions: !on } }) });
      dispatch({ type: "configStatus", config });
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const typing = state.config?.typing;
  const hasService = Boolean(typing?.included || typing?.cloudflare.configured);
  return (
    <SettingRow
      title={t("settings.typing.switchTitle")}
      subtitle={
        <>
          <span>{t("settings.typing.hint")}</span>
          {typing && !hasService && <span className="mt-1 block">{t("settings.typing.noService")}</span>}
          <button
            type="button"
            data-typing-forget
            disabled={forgotten}
            onClick={() => {
              forgetPhrases();
              setForgotten(true);
            }}
            className="mt-1.5 block text-[12px] font-medium text-accent hover:underline disabled:text-ink-tertiary disabled:no-underline"
          >
            {forgotten ? t("settings.typing.forgotten") : t("settings.typing.forget")}
          </button>
        </>
      }
      message={failed && <span role="alert" className="text-danger">{t("settings.typing.error")}</span>}
    >
      <Switch checked={on} disabled={saving} aria-label={t("settings.typing.switchTitle")} onClick={() => void toggle()} />
    </SettingRow>
  );
}

function failureText(reason: string): string {
  if (reason === "refused") return t("settings.typing.cloudflare.refused");
  if (reason === "unavailable" || reason === "timeout") return t("settings.typing.cloudflare.unreachable");
  return t("settings.typing.cloudflare.failed");
}

function CloudflareRow() {
  const { state, dispatch } = useStore();
  const mounted = useMounted();
  const saved = state.config?.typing?.cloudflare;
  const [open, setOpen] = useState(false);
  const [accountId, setAccountId] = useState("");
  const [token, setToken] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const idOk = ACCOUNT_ID.test(accountId.trim());

  const close = () => {
    setOpen(false);
    setToken("");
    setMessage(null);
  };

  const save = async () => {
    if (!idOk || !token.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const draft = { accountId: accountId.trim(), token: token.trim(), ...(model.trim() ? { model: model.trim() } : {}) };
      const checked: Checked = await api("/api/typing/test", { method: "POST", body: JSON.stringify(draft) });
      if (!checked.ok) {
        if (mounted.current) setMessage({ error: true, text: failureText(checked.reason) });
        return;
      }
      const patch = { typing: { accountId: draft.accountId, model: draft.model ?? "" } };
      await api("/api/config", { method: "PATCH", body: JSON.stringify(patch) });
      const status: ConfigStatus = window.laterdog?.setCredential
        ? await window.laterdog.setCredential("cloudflareAiToken", draft.token)
        : await api("/api/config", { method: "PATCH", body: JSON.stringify({ typing: { token: draft.token } }) });
      dispatch({ type: "configStatus", config: status });
      if (!mounted.current) return;
      setToken("");
      setOpen(false);
      setMessage({ error: false, text: t("settings.typing.cloudflare.saved", { ms: checked.ms }) });
    } catch {
      if (mounted.current) setMessage({ error: true, text: t("settings.typing.cloudflare.failed") });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const status: ConfigStatus = window.laterdog?.setCredential
        ? await window.laterdog.setCredential("cloudflareAiToken", "")
        : await api("/api/config", { method: "PATCH", body: JSON.stringify({ typing: { token: "" } }) });
      const cleared: ConfigStatus = await api("/api/config", { method: "PATCH", body: JSON.stringify({ typing: { accountId: "", model: "" } }) });
      dispatch({ type: "configStatus", config: { ...status, ...cleared } });
    } catch {
      if (mounted.current) setMessage({ error: true, text: t("settings.typing.cloudflare.failed") });
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <SettingRow
      title={t("settings.typing.cloudflare.title")}
      subtitle={t("settings.typing.cloudflare.hint")}
      message={message && <span role={message.error ? "alert" : "status"} className={message.error ? "text-danger" : "text-ink-secondary"}>{message.text}</span>}
    >
      {saved?.configured && !open ? (
        <div className="flex items-center justify-end gap-3 text-[12.5px]">
          <span className="min-w-0 truncate text-ink-secondary">{t("settings.typing.cloudflare.on", { account: `${saved.accountId.slice(0, 6)}…` })}</span>
          <button type="button" disabled={busy} onClick={() => void remove()} className="shrink-0 font-medium text-accent hover:underline disabled:opacity-50">
            {t("settings.typing.cloudflare.remove")}
          </button>
        </div>
      ) : !open ? (
        <button
          type="button"
          data-typing-cloudflare-open
          onClick={() => setOpen(true)}
          className="w-full rounded-lg bg-raised px-3 py-1.5 text-[12.5px] font-medium text-ink hover:bg-raised-hover sm:w-auto"
        >
          {t("settings.typing.cloudflare.set")}
        </button>
      ) : (
        <form
          data-typing-cloudflare-form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            placeholder={t("settings.typing.cloudflare.accountId")}
            aria-label={t("settings.typing.cloudflare.accountId")}
            autoComplete="off"
            spellCheck={false}
            className={FIELD}
          />
          {accountId.trim() && !idOk && <span role="alert" className="text-[12px] text-danger">{t("settings.typing.cloudflare.badAccount")}</span>}
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={t("settings.typing.cloudflare.token")}
            aria-label={t("settings.typing.cloudflare.token")}
            autoComplete="off"
            spellCheck={false}
            className={FIELD}
          />
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            placeholder={saved?.model ?? "@cf/meta/llama-3.2-3b-instruct"}
            aria-label={t("settings.typing.cloudflare.model")}
            autoComplete="off"
            spellCheck={false}
            className={FIELD}
          />
          <div className="flex gap-2">
            <button type="submit" disabled={!idOk || !token.trim() || busy} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:brightness-110 disabled:opacity-50">
              {busy ? t("settings.typing.cloudflare.checking") : t("settings.typing.cloudflare.save")}
            </button>
            <button type="button" disabled={busy} onClick={close} className="rounded-lg px-3 py-1.5 text-[12.5px] text-ink-secondary hover:bg-raised">
              {t("settings.typing.cloudflare.cancel")}
            </button>
          </div>
        </form>
      )}
    </SettingRow>
  );
}

export function TypingSuggestionsRows() {
  return (
    <>
      <SwitchRow />
      <CloudflareRow />
    </>
  );
}
