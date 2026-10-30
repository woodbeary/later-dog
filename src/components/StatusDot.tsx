import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { AttentionKind } from "@/lib/dog-status";

const TESTID: Record<AttentionKind, string> = {
  waiting: "waiting-dot",
  unread: "unread-dot",
};

const TONE: Record<AttentionKind, string> = {
  waiting: "bg-waiting",
  unread: "bg-unread",
};

function label(kind: AttentionKind): string {
  return kind === "waiting" ? t("sidebar.preview.waiting") : t("task.unread");
}

export function StatusDot({
  kind,
  ring,
  size = "size-2",
  announce = kind === "waiting",
  className,
}: {
  kind: AttentionKind | null;
  ring?: string;
  size?: string;
  announce?: boolean;
  className?: string;
}) {
  if (!kind) return null;
  const words = label(kind);
  return (
    <span
      data-testid={TESTID[kind]}
      data-status={kind}
      role={announce ? "status" : "img"}
      aria-label={words}
      title={words}
      className={cn("status-dot shrink-0 rounded-full", ring && "border-2", ring, size, TONE[kind], className)}
    />
  );
}
