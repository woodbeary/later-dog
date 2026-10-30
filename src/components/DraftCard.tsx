import { useContext, useMemo, useState } from "react";
import { AtSign, Check, Copy, Mail, MessageCircle, Pencil, Send } from "lucide-react";
import { cn } from "@/lib/cn";
import { useCopyFeedback } from "@/lib/copy-text";
import { draftBlock, earlierVersion, wordChanges, type DraftCard as Draft } from "@/lib/draft-card";
import { t } from "@/lib/i18n";
import { DraftContext } from "./draft-context";

const FRAME = "my-2 w-full max-w-[520px] rounded-card bg-card px-3.5 py-3 ring-[0.5px] ring-ink/10";
const BUTTON = "inline-flex items-center gap-1.5 rounded-full bg-control px-3 py-1 text-[12.5px] text-ink transition-colors hover:bg-control-hover disabled:cursor-default disabled:opacity-60";
const ICON = { email: Mail, text: MessageCircle, x: AtSign, message: Pencil } as const;

export function draftTitle(card: Draft): string {
  const to = card.to.join(", ");
  if (card.via === "email") return to ? t("draft.title.email", { to }) : t("draft.title.emailNoTo");
  if (card.via === "text") return to ? t("draft.title.text", { to }) : t("draft.title.textNoTo");
  if (card.via === "x") return to ? t("draft.title.xReply", { to }) : t("draft.title.x");
  return t("draft.title.message");
}

export function DraftCardView({ card, messageId }: { card: Draft; messageId?: string }) {
  const scope = useContext(DraftContext);
  const [body, setBody] = useState(card.body);
  const [editing, setEditing] = useState(false);
  const [changesShown, setChangesShown] = useState(false);
  const [sent, setSent] = useState(false);
  const { state: copied, copy } = useCopyFeedback(body);
  const earlier = useMemo(() => earlierVersion(scope.earlier(messageId), card), [scope, messageId, card]);
  const changes = useMemo(() => (earlier ? wordChanges(earlier.body, card.body) : null), [earlier, card.body]);
  const Icon = ICON[card.via];
  const edited = body.trim() !== card.body.trim();

  const send = () => {
    if (!scope.send || !body.trim()) return;
    scope.send(`${t(edited ? "draft.sendEdited" : "draft.sendAsIs")}\n\n${draftBlock(card, body)}`);
    setEditing(false);
    setSent(true);
  };

  return (
    <div className={FRAME} data-rich-card="draft" data-draft-via={card.via}>
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <Icon size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
        <span className="min-w-0 truncate">{draftTitle(card)}</span>
      </div>
      {card.cc.length > 0 && <div className="mt-0.5 truncate text-[12px] text-ink-secondary">{t("draft.cc", { cc: card.cc.join(", ") })}</div>}
      {card.subject && <div className="mt-1.5 text-[13.5px] font-semibold text-ink">{card.subject}</div>}
      {editing ? (
        <textarea value={body} onChange={(event) => setBody(event.target.value)} aria-label={t("draft.editLabel")} rows={Math.min(14, Math.max(4, body.split("\n").length + 1))}
          className="mt-1.5 w-full resize-y rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[14px] leading-relaxed text-ink focus:outline-none" />
      ) : changesShown && changes && !edited ? (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink" data-draft-changes>
          {changes.map((part, index) => (
            <span key={index} className={cn(part.change === "added" && "rounded-sm bg-accent/20 font-semibold", part.change === "removed" && "text-ink-tertiary line-through")}>{part.text}</span>
          ))}
        </p>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-ink">{body}</p>
      )}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {scope.send && (
          <button type="button" onClick={send} disabled={sent || !body.trim()} className={cn(BUTTON, "bg-accent font-medium text-white hover:bg-accent hover:brightness-110")}>
            {sent ? <Check size={13} aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}
            {sent ? t("draft.asked", { name: scope.botName ?? "" }) : t("draft.send")}
          </button>
        )}
        <button type="button" onClick={() => setEditing((open) => !open)} disabled={sent} className={BUTTON}>
          <Pencil size={13} aria-hidden="true" />{editing ? t("draft.doneEditing") : t("draft.edit")}
        </button>
        <button type="button" onClick={copy} className={BUTTON}>
          {copied === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied === "copied" ? t("draft.copied") : t("draft.copy")}
        </button>
        {changes && !editing && !edited && (
          <button type="button" onClick={() => setChangesShown((shown) => !shown)} className={cn(BUTTON, "bg-transparent text-ink-secondary hover:text-ink")}>
            {changesShown ? t("draft.hideChanges") : t("draft.showChanges")}
          </button>
        )}
      </div>
    </div>
  );
}
