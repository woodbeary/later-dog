import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Eye, EyeOff, Loader2, LockKeyhole, X } from "lucide-react";

import { SECURE_VALUE_CHARS, shownSecureFormStatus, type SecureFormCardData, type SecureFormField, type SecureFormStatus } from "../../shared/secure-form";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, ApiError, type Message } from "@/state/store";

export function secureFormCaption(status: SecureFormStatus): string {
  switch (status) {
    case "open":
      return t("secureForm.caption");
    case "sending":
      return t("secureForm.filling");
    case "filled":
      return t("secureForm.filled");
    default:
      return t("secureForm.notFilled");
  }
}

export function secureFormReady(fields: readonly SecureFormField[], values: Readonly<Record<string, string>>): boolean {
  return fields.every((field) => {
    const value = values[field.id] ?? "";
    return (field.type === "password" ? value : value.trim()).length > 0;
  });
}

function useShownStatus(card: SecureFormCardData): SecureFormStatus {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (card.status !== "sending" || card.until === undefined) return;
    const wait = card.until - Date.now();
    if (wait <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2_000_000_000));
    return () => window.clearTimeout(timer);
  }, [card.status, card.until]);
  return shownSecureFormStatus(card, now);
}

export function SecureFormCard({
  botId,
  botName,
  threadId,
  message,
}: {
  botId: string;
  botName: string;
  threadId: string;
  message: Message;
}) {
  const card = message.secureForm!;
  const status = useShownStatus(card);
  const [open, setOpen] = useState(false);
  const openButton = useRef<HTMLButtonElement>(null);
  const remoteClient = window.laterdog?.remoteClient?.active === true;
  const fillable = status === "open";

  return (
    <section aria-label={t("secureForm.aria", { name: botName })} data-secure-form={status} className="flex w-full justify-start">
      <div className="w-full max-w-[420px] overflow-hidden rounded-[18px] bg-card ring-[0.5px] ring-ink/10">
        <div className="flex items-center gap-3 px-3.5 py-3">
          <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl bg-control", fillable ? "text-ink" : "text-ink-tertiary")}>
            <LockKeyhole size={16} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <p className={cn("truncate text-[14px] font-medium leading-snug", fillable ? "text-ink" : "text-ink-secondary")}>{card.title}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink-secondary">
              {status === "sending" && <Loader2 size={11} className="shrink-0 animate-spin" aria-hidden="true" />}
              {status === "filled" && <Check size={11} className="shrink-0 text-success" aria-hidden="true" />}
              <span className="truncate">{secureFormCaption(status)}</span>
            </p>
          </div>
          {fillable && !remoteClient && (
            <button
              ref={openButton}
              type="button"
              onClick={() => setOpen(true)}
              aria-label={t("secureForm.openAria", { title: card.title })}
              aria-haspopup="dialog"
              className="flex h-8 shrink-0 items-center rounded-full bg-ink px-3.5 text-[13px] font-medium text-app transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 motion-reduce:transition-none"
            >
              {t("secureForm.open")}
            </button>
          )}
        </div>
        {fillable && remoteClient && (
          <p className="px-3.5 pb-3 text-[12.5px] leading-relaxed text-ink-secondary">{t("secureForm.remote")}</p>
        )}
      </div>
      {open && fillable && !remoteClient && (
        <SecureFormDialog
          botId={botId}
          threadId={threadId}
          messageId={message.id}
          card={card}
          onClose={() => {
            setOpen(false);
            openButton.current?.focus();
          }}
        />
      )}
    </section>
  );
}

const INPUT_TYPE: Record<SecureFormField["type"], { type: string; autoComplete: string; inputMode?: "email" | "text" }> = {
  text: { type: "text", autoComplete: "off" },
  email: { type: "email", autoComplete: "off", inputMode: "email" },
  password: { type: "password", autoComplete: "new-password" },
  code: { type: "text", autoComplete: "one-time-code", inputMode: "text" },
};

export function SecureFormDialog({
  botId,
  threadId,
  messageId,
  card,
  onClose,
}: {
  botId: string;
  threadId: string;
  messageId: string;
  card: SecureFormCardData;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useModalDialog(dialogRef, onClose);
  const ready = secureFormReady(card.fields, values);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setError(null);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/secure-forms/${encodeURIComponent(messageId)}/submit`, {
        method: "POST",
        body: JSON.stringify({ threadId, values: Object.fromEntries(card.fields.map((field) => [field.id, values[field.id] ?? ""])) }),
      });
      setValues({});
      onClose();
    } catch (failure) {
      setSending(false);
      setError(failure instanceof ApiError && failure.status === 400 ? t("secureForm.invalid") : t("secureForm.failed"));
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      aria-busy={sending || undefined}
      data-secure-form-dialog=""
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 outline-none sm:items-center"
    >
      <form
        onSubmit={(event) => void submit(event)}
        autoComplete="off"
        className="relative w-full max-w-sm rounded-2xl bg-panel p-5 text-ink shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("secureForm.close")}
          className="absolute right-3 top-3 flex size-8 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
        >
          <X size={16} aria-hidden="true" />
        </button>
        <h2 id={titleId} className="pr-9 text-[16px] font-semibold leading-snug">{card.title}</h2>
        <div className="mt-4 flex flex-col gap-3.5">
          {card.fields.map((field, index) => {
            const inputId = `${titleId}-${field.id}`;
            const secret = field.type === "password";
            const visible = secret && shown[field.id] === true;
            const kind = INPUT_TYPE[field.type];
            return (
              <div key={field.id} className="flex flex-col gap-1.5">
                <label htmlFor={inputId} className="text-[12.5px] font-medium text-ink-secondary">{field.label}</label>
                <div className="relative">
                  <input
                    id={inputId}
                    data-secure-field={field.id}
                    type={visible ? "text" : kind.type}
                    inputMode={kind.inputMode}
                    autoComplete={kind.autoComplete}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    autoFocus={index === 0}
                    maxLength={SECURE_VALUE_CHARS}
                    value={values[field.id] ?? ""}
                    readOnly={sending}
                    onChange={(event) => {
                      const next = event.target.value;
                      setValues((current) => ({ ...current, [field.id]: next }));
                    }}
                    className={cn(
                      "h-10 w-full rounded-xl border-[0.5px] border-ink/15 bg-composer px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-tertiary focus:border-accent read-only:opacity-60 motion-reduce:transition-none",
                      secret && "pr-10",
                    )}
                  />
                  {secret && (
                    <button
                      type="button"
                      onClick={() => setShown((current) => ({ ...current, [field.id]: !visible }))}
                      aria-label={t(visible ? "secureForm.hide" : "secureForm.show", { label: field.label })}
                      aria-pressed={visible}
                      aria-controls={inputId}
                      className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-lg text-ink-tertiary transition-colors hover:bg-raised-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus motion-reduce:transition-none"
                    >
                      {visible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-4 flex items-start gap-1.5 text-[12px] leading-[17px] text-ink-tertiary">
          <LockKeyhole size={12} className="mt-[2px] shrink-0" aria-hidden="true" />
          {t("secureForm.lock", { host: card.host })}
        </p>
        {error && <p role="alert" className="mt-2 text-[12px] text-danger">{error}</p>}
        <button
          type="submit"
          disabled={!ready}
          aria-busy={sending || undefined}
          className="mt-4 flex h-10 w-full items-center justify-center gap-1.5 rounded-full bg-ink text-[14px] font-medium text-app transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 disabled:opacity-40 disabled:hover:opacity-40 motion-reduce:transition-none"
        >
          {sending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {t("secureForm.continue")}
        </button>
      </form>
    </div>,
    document.body,
  );
}
