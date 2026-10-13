import { activeLocale, t } from "@/lib/i18n";

export function resetDistance(resetsAt: string | null | undefined, now: number): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.floor((at - now) / 60_000);
  if (minutes < 1) return t("planUsage.lessThanMinute");
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return hours > 0 ? t("planUsage.daysHours", { days, hours }) : t("planUsage.days", { days });
  if (hours > 0) return mins > 0 ? t("planUsage.hoursMinutes", { hours, minutes: mins }) : t("planUsage.hours", { hours });
  return t("planUsage.minutes", { minutes: mins });
}

export function resetClock(until: string, now: number): string {
  const at = new Date(until);
  return at.toDateString() === new Date(now).toDateString()
    ? at.toLocaleTimeString(activeLocale(), { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString(activeLocale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
