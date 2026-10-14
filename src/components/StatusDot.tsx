import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { DogStatusKind } from "@/lib/dog-status";

const TESTID: Record<DogStatusKind, string> = {
  waiting: "waiting-dot",
  working: "working-dot",
  teammates: "teammate-wait-dot",
  queued: "queued-dot",
};

const TONE: Record<DogStatusKind, string> = {
  waiting: "bg-warning",
  working: "bg-success",
  teammates: "bg-accent",
  queued: "bg-ink-secondary",
};

function label(kind: DogStatusKind): string {
  switch (kind) {
    case "waiting": return t("sidebar.preview.waiting");
    case "working": return t("chat.activity.working");
    case "teammates": return t("sidebar.preview.waitingOnTeammate");
    case "queued": return t("task.queued");
  }
}

export function StatusDot({
  kind,
  ring,
  size = "size-2.5",
  announce = kind !== "working",
  className,
}: {
  kind: DogStatusKind | null;
  ring: string;
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
      role={announce ? "status" : undefined}
      aria-label={announce ? words : undefined}
      title={announce ? words : undefined}
      className={cn(
        "status-dot absolute -right-0.5 -bottom-0.5 rounded-full border-2",
        size,
        ring,
        TONE[kind],
        className,
      )}
    />
  );
}
