import { t } from "@/lib/i18n";
import { replySnippet } from "@/lib/replies";
import { splitTranscriptCitations } from "@/lib/citations";
import { attachmentImageUrl, splitTranscriptAttachments } from "@/lib/composer-attachments";

export interface QueuedItem {
  queueId: string;
  text: string;
}

export function queuedMessageParts(text: string): { label: string; pictures: string[] } {
  const { display, images, files } = splitTranscriptAttachments(text);
  const words = splitTranscriptCitations(display).citations.length ? replySnippet(display, 500) : display;
  const pictures = images.map((image) => attachmentImageUrl(image.path)).filter((url): url is string => url !== null);
  const label =
    words ||
    files.map((file) => file.name).filter(Boolean).join(", ") ||
    (images.length === 1
      ? t("composer.queued.pictureOne")
      : images.length > 1
        ? t("composer.queued.pictureMany", { count: images.length })
        : "");
  return { label, pictures };
}

export function QueuedBubbles({ items, tint, onCancel }: {
  items: readonly QueuedItem[];
  tint?: string;
  onCancel: (queueId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <>
      {items.map((item) => {
        const { label, pictures } = queuedMessageParts(item.text);
        return (
          <div key={item.queueId} data-queued-bubble={item.queueId} data-from="user" className="flex w-full flex-col items-end">
            {pictures.length > 0 && (
              <div className="mb-1.5 flex max-w-[min(42rem,78%)] flex-wrap justify-end gap-1.5 opacity-70">
                {pictures.slice(0, 4).map((url) => (
                  <img key={url} src={url} alt="" className="size-16 rounded-lg object-cover" />
                ))}
              </div>
            )}
            {label && (
              <div
                dir="auto"
                data-dog-tint={tint}
                className="chat-text w-fit max-w-[min(42rem,78%)] whitespace-pre-wrap rounded-bubble bg-bubble-user px-3 py-[7px] text-[14px] leading-[21px] text-ink opacity-70"
              >
                {label}
              </div>
            )}
            <div className="mt-1 flex items-center gap-1.5 pr-1 text-[11px] text-ink-tertiary" role="status">
              <span>{t("chat.queued.waiting")}</span>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => onCancel(item.queueId)}
                aria-label={t("chat.queued.cancelAria")}
                className="rounded px-0.5 text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        );
      })}
    </>
  );
}
