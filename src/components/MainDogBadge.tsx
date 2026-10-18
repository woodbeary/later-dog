import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";

export function MainDogBadge({ size = "size-3", ring = "border-panel" }: { size?: string; ring?: string }) {
  const words = t("mainDog.badge");
  return (
    <span
      data-testid="main-dog-badge"
      role="img"
      aria-label={words}
      title={words}
      className={cn("absolute -left-0.5 -bottom-0.5 rounded-full border-2 bg-ink", size, ring)}
    />
  );
}
