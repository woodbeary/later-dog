import { useState, type FormEvent } from "react";
import { Check, ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw, X } from "lucide-react";

import { credentialConfigPatch, credentialResumeOutcome } from "../../shared/credential-request";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus, type Message } from "@/state/store";

export function SecretRequestCard({
  botId,
  threadId,
  message,
}: {
  botId: string;
  threadId: string;
  message: Message;
}) {
  const { dispatch } = useStore();
  const secret = message.secret!;
  const remoteClient = window.laterdog?.remoteClient?.active === true;
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/secret-cards/${encodeURIComponent(message.id)}`;
  const error = localError ?? secret.error;
  const outcome = credentialResumeOutcome(secret);
  const provided = outcome === "provided";
  const declined = outcome === "dismissed";
  const superseded = secret.superseded === true;
  const pending = !provided && !declined && !superseded;
  const description = superseded
    ? "This request was replaced by a newer one for the same key. Use the newest card to provide it."
    : provided
    ? secret.resumed
      ? "Saved securely. Your dog is continuing the task."
      : "Saved securely. Your dog will continue when its current turn settles."
    : declined
      ? "You chose not to provide this credential. later.dog could not resume the dog yet."
      : secret.description;
  const footerLabel = declined
    ? "Continuing without this credential failed"
    : secret.resumed
      ? "Dog resumed without seeing the key"
      : error
        ? "The key is safe; resuming failed"
        : "Waiting to resume safely";

  if (declined && (secret.resumed || !error)) return null;

  const notifyProvided = async () => {
    await api(`${endpoint}/provided`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    });
  };

  const retryResume = async () => {
    if (saving) return;
    setSaving(true);
    setLocalError(null);
    try {
      await api(`${endpoint}/resume`, {
        method: "POST",
        body: JSON.stringify({ threadId }),
      });
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (saving || (!value.trim() && !savedLocally)) return;
    setSaving(true);
    setLocalError(null);
    let saved = savedLocally;
    try {
      if (!savedLocally) {
        const next = value.trim();
        const status: ConfigStatus = window.laterdog?.setCredential
          ? await window.laterdog.setCredential(secret.target, next)
          : await api("/api/config", {
              method: "PUT",
              body: JSON.stringify(credentialConfigPatch(secret.target, next)),
            });
        dispatch({ type: "configStatus", config: status });
        setValue("");
        setSavedLocally(true);
        saved = true;
      }
      await notifyProvided();
    } catch (error) {
      setLocalError(saved ? error instanceof Error ? error.message : String(error) : t("credentialStore.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const dismiss = () => {
    void api(`${endpoint}/dismiss`, {
      method: "POST",
      body: JSON.stringify({ threadId }),
    }).catch(() => {});
  };

  return (
    <div className="flex w-full justify-start">
      <div className="w-full max-w-[420px] overflow-hidden rounded-card bg-card ring-[0.5px] ring-ink/10">
        <div className="flex items-start gap-2.5 px-3.5 pb-2 pt-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-control text-ink">
            <KeyRound size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-medium text-ink">{secret.label}</span>
              {provided && (
                <span className="flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success">
                  <Check size={11} /> Saved
                </span>
              )}
              {superseded && (
                <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] font-medium text-warning">
                  Replaced
                </span>
              )}
            </div>
            <p className="text-[13px] leading-[18px] text-ink-secondary">
              {description}
            </p>
            {pending && (
              <p className="mt-1 flex items-center gap-1 text-[11.5px] text-ink-tertiary">
                <LockKeyhole size={11} /> Never shown in chat.
              </p>
            )}
            {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
          </div>
          {pending && (
            <button
              onClick={dismiss}
              aria-label="Not now"
              title="Not now"
              className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
            >
              <X size={15} />
            </button>
          )}
        </div>
        {remoteClient && pending && (
          <div className="px-3.5 pb-3 text-[12.5px] leading-relaxed text-ink-secondary">
            This key must be saved on the host computer. Open this conversation on the host to continue securely.
          </div>
        )}
        {!remoteClient && pending && (
          <form onSubmit={(event) => void save(event)} className="px-3.5 pb-3">
            <div className="flex gap-2">
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={secret.placeholder}
                disabled={saving || savedLocally}
                aria-label={secret.label}
                className="h-8 min-w-0 flex-1 rounded-full border-[0.5px] border-ink/15 bg-composer px-3 text-[13px] text-ink outline-none placeholder:text-ink-tertiary focus:border-accent disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={saving || (!value.trim() && !savedLocally)}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-accent px-3 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving && <Loader2 size={13} className="animate-spin" />}
                {savedLocally ? "Continue task" : localError ? t("chat.retry") : "Save securely"}
              </button>
            </div>
            <a
              href={secret.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
            >
              Where to get this key <ExternalLink size={11} />
            </a>
          </form>
        )}
        {(provided || declined) && (
          <div className={cn(
            "flex items-center justify-between px-3.5 pb-3 text-[12px]",
            declined ? "text-danger" : "text-success",
          )}>
            <span className="flex items-center gap-1.5">
              {secret.resumed ? <Check size={12} /> : error ? <KeyRound size={12} /> : <Loader2 size={12} className="animate-spin" />}
              {footerLabel}
            </span>
            {!secret.resumed && error && (
              <button
                onClick={() => void retryResume()}
                disabled={saving}
                className="flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Try again
              </button>
            )}
          </div>
        )}
        {superseded && (
          <div className="flex items-center px-3.5 pb-3 text-[12px] text-ink-secondary">
            <span className="flex items-center gap-1.5">
              <X size={12} /> Replaced by a newer request
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
