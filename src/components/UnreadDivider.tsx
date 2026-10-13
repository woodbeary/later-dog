import { t } from "@/lib/i18n";

export function UnreadDivider() {
  return (
    <div role="separator" aria-label={t("chat.unread.aria")} data-unread-divider="" className="flex items-center gap-2.5 py-2">
      <span className="h-px flex-1 bg-accent/45" aria-hidden="true" />
      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-accent" aria-hidden="true">{t("chat.unread.new")}</span>
    </div>
  );
}
