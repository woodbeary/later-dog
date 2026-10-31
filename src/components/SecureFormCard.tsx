import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Eye, EyeOff, Globe, KeyRound, Loader2, LockKeyhole, TriangleAlert, UserRound, X } from "lucide-react";

import { asksForDetails, SECURE_VALUE_CHARS, secureFormReady, shownSecureFormStatus, type SecureFormCardData, type SecureFormField, type SecureFormStatus } from "../../shared/secure-form";
import { detailsFill, savesAsLogin, vaultFieldPlan, type VaultDetailsView, type VaultLogin, type VaultOffers } from "../../shared/vault";
import { useModalDialog } from "@/hooks/use-modal-dialog";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { api, ApiError, type Message } from "@/state/store";
import { REQUEST_PRIMARY, RequestCard, RequestStatus } from "./RequestCard";

export function secureFormStatusLabel(status: SecureFormStatus): string | null {
  switch (status) {
    case "open":
      return null;
    case "sending":
      return t("secureForm.filling");
    case "filled":
      return t("secureForm.filled");
    case "superseded":
      return t("secureForm.replaced");
    default:
      return t("secureForm.notFilled");
  }
}

function SecureFormStatusBadge({ status }: { status: SecureFormStatus }) {
  const label = secureFormStatusLabel(status);
  if (!label) return null;
  if (status === "sending") return <RequestStatus tone="muted" leading={<Loader2 size={12} className="animate-spin" aria-hidden="true" />}>{label}</RequestStatus>;
  if (status === "filled") return <RequestStatus tone="success" leading={<Check size={12} aria-hidden="true" />}>{label}</RequestStatus>;
  return <RequestStatus tone={status === "expired" ? "danger" : "muted"}>{label}</RequestStatus>;
}

export { secureFormReady };

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
  const fillable = status === "open";
  const canOpen = fillable;
  const offers = useVaultOffers(fillable ? card.host : null);
  const details = useVaultDetails(fillable && asksForDetails(card.fields));

  return (
    <RequestCard
      label={t("secureForm.aria", { name: botName })}
      data={{ "data-secure-form": status }}
      media={<Globe size={17} aria-hidden="true" />}
      title={card.title}
      subtitle={card.saved ? t("secureForm.savedLogin", { username: card.saved.username || t("secureForm.noUsername") }) : t("secureForm.caption")}
      active={fillable}
      onActivate={canOpen ? () => setOpen(true) : undefined}
      trailing={canOpen ? (
        <button
          ref={openButton}
          type="button"
          onClick={() => setOpen(true)}
          aria-label={t("secureForm.openAria", { title: card.title })}
          aria-haspopup="dialog"
          className={REQUEST_PRIMARY}
        >
          {t("secureForm.open")}
        </button>
      ) : <SecureFormStatusBadge status={status} />}
    >
      {open && canOpen && (
        <SecureFormDialog
          botId={botId}
          botName={botName}
          threadId={threadId}
          messageId={message.id}
          card={card}
          offers={offers}
          details={details}
          onClose={() => {
            setOpen(false);
            openButton.current?.focus();
          }}
        />
      )}
    </RequestCard>
  );
}

const INPUT_TYPE: Record<SecureFormField["type"], { type: string; autoComplete: string; inputMode?: "email" | "text" }> = {
  text: { type: "text", autoComplete: "off" },
  email: { type: "email", autoComplete: "off", inputMode: "email" },
  password: { type: "password", autoComplete: "new-password" },
  code: { type: "text", autoComplete: "one-time-code", inputMode: "text" },
};

function useVaultDetails(wanted: boolean): VaultDetailsView | null {
  const [details, setDetails] = useState<VaultDetailsView | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let active = true;
    api<VaultDetailsView>("/api/vault/details", { timeoutMs: 10_000 })
      .then((next) => { if (active) setDetails(next); })
      .catch(() => {});
    return () => { active = false; };
  }, [wanted]);
  return details;
}

function useVaultOffers(host: string | null): VaultOffers | null {
  const [offers, setOffers] = useState<VaultOffers | null>(null);
  useEffect(() => {
    if (!host) return;
    let active = true;
    api<VaultOffers>(`/api/vault/offers?host=${encodeURIComponent(host)}`, { timeoutMs: 10_000 })
      .then((next) => { if (active) setOffers(next); })
      .catch(() => {});
    return () => { active = false; };
  }, [host]);
  return offers;
}

export function SecureFormDialog({
  botId,
  botName,
  threadId,
  messageId,
  card,
  offers,
  details = null,
  onClose,
}: {
  botId: string;
  botName: string;
  threadId: string;
  messageId: string;
  card: SecureFormCardData;
  offers: VaultOffers | null;
  details?: VaultDetailsView | null;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [always, setAlways] = useState(false);
  const [save, setSave] = useState(false);
  useModalDialog(dialogRef, onClose);
  const ready = secureFormReady(card.fields, values);
  const saved = offers && vaultFieldPlan(card.fields) ? offers.logins : [];
  const forDetails = asksForDetails(card.fields);
  const fromDetails = details?.available ? detailsFill(card.fields, details.details) : {};
  const canUseDetails = Object.keys(fromDetails).length > 0;
  const savable = forDetails ? details?.available === true : offers?.available === true && !offers.lookalike && savesAsLogin(card.fields);

  const send = async (body: Record<string, unknown>) => {
    setSending(true);
    setError(null);
    try {
      await api(`/api/bots/${encodeURIComponent(botId)}/secure-forms/${encodeURIComponent(messageId)}/submit`, {
        method: "POST",
        body: JSON.stringify({ threadId, ...body }),
      });
      setValues({});
      onClose();
    } catch (failure) {
      setSending(false);
      setError(failure instanceof ApiError && failure.status === 400 && !("login" in body) ? t("secureForm.invalid") : t("secureForm.failed"));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || sending) return;
    await send({ values: Object.fromEntries(card.fields.map((field) => [field.id, values[field.id] ?? ""])), ...(savable && save ? { save: true } : {}) });
  };

  const fillFromVault = (login: VaultLogin) => {
    if (!sending) void send({ login: login.id, ...(always ? { always: true } : {}) });
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
        {canUseDetails && (
          <button
            type="button"
            disabled={sending}
            data-use-details=""
            onClick={() => setValues((current) => ({ ...current, ...fromDetails }))}
            className="mt-4 inline-flex h-9 items-center gap-2 rounded-full bg-composer px-3.5 text-[13px] font-medium text-ink transition-colors hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 motion-reduce:transition-none"
          >
            <UserRound size={14} aria-hidden="true" />
            {t("secureForm.useDetails")}
          </button>
        )}
        {saved.length > 0 && (
          <div data-vault-offers="" className="mt-4 flex flex-col gap-2">
            <div className="text-[12.5px] font-medium text-ink-secondary">{t("secureForm.savedLogins")}</div>
            {saved.map((login) => {
              const username = login.username || t("secureForm.noUsername");
              return (
                <div key={login.id} className="flex items-center gap-2.5 rounded-xl bg-composer py-1.5 pl-3 pr-1.5">
                  <KeyRound size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{username}</span>
                  <button
                    type="button"
                    disabled={sending}
                    onClick={() => fillFromVault(login)}
                    aria-label={t("secureForm.useSavedAria", { site: login.site, username })}
                    className="h-8 shrink-0 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-app transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-40 motion-reduce:transition-none"
                  >
                    {t("secureForm.useSaved")}
                  </button>
                </div>
              );
            })}
            <label className="flex items-center gap-2 px-0.5 text-[12.5px] text-ink-secondary">
              <input type="checkbox" checked={always} onChange={(event) => setAlways(event.target.checked)} className="size-3.5 accent-[var(--color-accent)]" />
              {t("secureForm.always", { name: botName, site: saved[0]!.site })}
            </label>
            <div className="mt-1 text-[12px] text-ink-tertiary">{t("secureForm.orType")}</div>
          </div>
        )}
        {offers?.lookalike && (
          <p role="alert" data-vault-lookalike="" className="mt-4 flex items-start gap-2 rounded-xl bg-danger/10 px-3 py-2.5 text-[12.5px] leading-[17px] text-danger">
            <TriangleAlert size={14} className="mt-[1px] shrink-0" aria-hidden="true" />
            {t("secureForm.lookalike", { host: card.host, site: offers.lookalike })}
          </p>
        )}
        <div className="mt-4 flex flex-col gap-3.5">
          {card.fields.map((field, index) => {
            const inputId = `${titleId}-${field.id}`;
            const secret = field.type === "password";
            const visible = secret && shown[field.id] === true;
            const kind = INPUT_TYPE[field.type];
            return (
              <div key={field.id} className="flex flex-col gap-1.5">
                <label htmlFor={inputId} className="text-[12.5px] font-medium text-ink-secondary">
                  {field.label}
                  {field.optional && <span className="font-normal text-ink-tertiary"> · {t("secureForm.optional")}</span>}
                </label>
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
                    autoFocus={index === 0 && saved.length === 0}
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
        {savable && (
          <label className="mt-3.5 flex items-center gap-2 text-[12.5px] text-ink-secondary">
            <input type="checkbox" checked={save} onChange={(event) => setSave(event.target.checked)} data-vault-save="" className="size-3.5 accent-[var(--color-accent)]" />
            {t(forDetails ? "secureForm.saveDetails" : "secureForm.saveLogin")}
          </label>
        )}
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
