import { useEffect, useState, type FormEvent } from "react";
import { Check, ExternalLink, KeyRound, Loader2, LockKeyhole, RefreshCw, X } from "lucide-react";

import { credentialConfigPatch, credentialResumeOutcome } from "../../shared/credential-request";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, useStore, type ConfigStatus, type Message } from "@/state/store";
import { REQUEST_PRIMARY, REQUEST_QUIET, RequestCard, RequestStatus } from "./RequestCard";

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
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedLocally, setSavedLocally] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [savedOnMac, setSavedOnMac] = useState<Array<{ id: string; label: string; hint: string | null }>>([]);
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

  useEffect(() => {
    const find = window.laterdog?.findSavedCredential;
    if (!pending || !find) return;
    let live = true;
    void find(secret.target).then((found) => {
      if (live) setSavedOnMac(found);
    });
    return () => {
      live = false;
    };
  }, [pending, secret.target]);

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

  const useSaved = async (id: string) => {
    const use = window.laterdog?.useSavedCredential;
    if (saving || !use) return;
    setSaving(true);
    setLocalError(null);
    try {
      if (!savedLocally) {
        dispatch({ type: "configStatus", config: await use(secret.target, id) });
        setSavedLocally(true);
      }
      await notifyProvided();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : t("credentialStore.saveFailed"));
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
    <RequestCard
      label={secret.label}
      data={{ "data-secret-card": provided ? "provided" : declined ? "declined" : superseded ? "superseded" : "pending" }}
      media={<KeyRound size={17} aria-hidden="true" />}
      title={secret.label}
      subtitle={pending && (
        <span className="flex items-center gap-1">
          <LockKeyhole size={11} aria-hidden="true" /> Never shown in chat.
        </span>
      )}
      active={pending}
      trailing={pending ? (
        <button type="button" onClick={dismiss} aria-label="Not now" title="Not now" className={cn(REQUEST_QUIET, "w-8 justify-center px-0")}>
          <X size={15} />
        </button>
      ) : provided ? (
        <RequestStatus tone="success" leading={<Check size={12} />}>Saved</RequestStatus>
      ) : superseded ? (
        <RequestStatus tone="muted">Replaced</RequestStatus>
      ) : null}
    >
      <div className="px-3.5 pb-3.5">
        <p className="text-[12.5px] leading-[18px] text-ink-secondary">{description}</p>
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
        {pending && savedOnMac.length > 0 && !savedLocally && (
          <div className="mt-3 flex flex-col gap-1.5" data-saved-keys="">
            {savedOnMac.map((found) => (
              <div key={found.id} className="flex items-center justify-between gap-2 rounded-xl bg-composer px-3 py-2 ring-[0.5px] ring-ink/10">
                <span className="min-w-0 truncate text-[12.5px] text-ink">
                  {found.label}
                  {found.hint && <span className="ml-1.5 font-mono text-ink-tertiary">{found.hint}</span>}
                </span>
                <button type="button" onClick={() => void useSaved(found.id)} disabled={saving} className={REQUEST_PRIMARY}>
                  {saving && <Loader2 size={13} className="animate-spin" />}
                  Use this key
                </button>
              </div>
            ))}
            <p className="text-[11.5px] text-ink-tertiary">Found on this Mac. Your dog never sees it.</p>
          </div>
        )}
        {pending && (
          <form onSubmit={(event) => void save(event)} className="mt-3">
            <input
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={secret.placeholder}
              disabled={saving || savedLocally}
              aria-label={secret.label}
              className="h-9 w-full rounded-xl bg-composer px-3 font-mono text-[13px] text-ink outline-none ring-[0.5px] ring-ink/15 transition-shadow placeholder:font-sans placeholder:text-ink-tertiary focus:ring-2 focus:ring-focus disabled:opacity-60 motion-reduce:transition-none"
            />
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <a
                href={secret.helpUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(REQUEST_QUIET, "-ml-2 px-2 text-[12px]")}
              >
                Where to get this key <ExternalLink size={11} aria-hidden="true" />
              </a>
              <button type="submit" disabled={saving || (!value.trim() && !savedLocally)} className={REQUEST_PRIMARY}>
                {saving && <Loader2 size={13} className="animate-spin" />}
                {savedLocally ? "Continue task" : localError ? t("chat.retry") : "Save securely"}
              </button>
            </div>
          </form>
        )}
        {(provided || declined) && (
          <div className={cn("mt-2.5 flex items-center justify-between gap-2 text-[12px]", declined ? "text-danger" : "text-ink-secondary")}>
            <span className="flex items-center gap-1.5">
              {secret.resumed ? <Check size={12} /> : error ? <KeyRound size={12} /> : <Loader2 size={12} className="animate-spin" />}
              {footerLabel}
            </span>
            {!secret.resumed && error && (
              <button type="button" onClick={() => void retryResume()} disabled={saving} className={REQUEST_PRIMARY}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Try again
              </button>
            )}
          </div>
        )}
        {superseded && (
          <p className="mt-2.5 flex items-center gap-1.5 text-[12px] text-ink-secondary">
            <X size={12} /> Replaced by a newer request
          </p>
        )}
      </div>
    </RequestCard>
  );
}
