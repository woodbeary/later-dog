import type { RuntimeEvent } from "../../shared/runtime-events";
import type { WorkState } from "../../shared/work-state";
import { activeLocale, t } from "@/lib/i18n";
import { teammateNames } from "@/lib/waiting-on";
import { RESUME_REJECTED } from "../../shared/resume-pickup";

const LIVE = new Set<WorkState["kind"]>(["running", "retrying", "waiting-for-computer"]);

export function workAfterEvent(work: WorkState | undefined, event: RuntimeEvent): WorkState | undefined {
  if (!work) return work;
  switch (event.type) {
    case "turn.retrying":
      if (event.reason === RESUME_REJECTED) return work;
      return work.kind === "running" || work.kind === "retrying" ? { kind: "retrying", attempt: event.attempt + 1 } : work;
    case "turn.wait_started":
      return work.kind === "running" || work.kind === "retrying"
        ? { kind: "waiting-for-computer", ...(event.holder?.name ? { holder: event.holder.name } : {}) } : work;
    case "turn.wait_ended":
      return work.kind === "waiting-for-computer" ? { kind: "running" } : work;
    case "session.exited":
      return LIVE.has(work.kind) ? { kind: "stopped", cause: "engine", detail: "closed" } : work;
    default:
      return work;
  }
}

export function resetTime(until: number, now: number, locale: string = activeLocale()): string {
  const sameDay = new Date(until).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(locale, sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" }).format(until);
}

export function workLine(work: WorkState | undefined, now: number = Date.now()): string | null {
  switch (work?.kind) {
    case "needs-you":
      return work.what ? t("work.needsYouWhat", { what: work.what }) : t("work.needsYou");
    case "waiting-for-usage": {
      const time = work.until !== undefined && work.until > now ? resetTime(work.until, now) : undefined;
      if (time && work.account) return t("work.usageOnUntil", { account: work.account, time });
      if (time) return t("work.usageUntil", { time });
      return work.account ? t("work.usageOn", { account: work.account }) : t("work.usage");
    }
    case "running": {
      const names = teammateNames((work.dogs ?? []).map((dog) => ({ botId: dog.id, name: dog.name })));
      if (!names && work.computerJobs) {
        if (work.computerBackground === work.computerJobs) return work.computerJobs > 1 ? t("work.computerBackgroundMany", { count: work.computerJobs }) : t("work.computerBackground");
        return work.computerJobs > 1 ? t("work.computerJobs", { count: work.computerJobs }) : t("work.computerJob");
      }
      if (!names) return null;
      return t(work.dogs!.length > 1 ? "work.roomWorkingMany" : "work.roomWorkingOne", { names });
    }
    case "waiting-on-dog": {
      const names = teammateNames(work.dogs.map((dog) => ({ botId: dog.id, name: dog.name })));
      return names ? t("chat.waitingOn", { names }) : null;
    }
    case "waiting-for-computer":
      return work.holder ? t("work.computerHeld", { name: work.holder }) : t("work.computer");
    case "retrying":
      return work.attempt ? t("work.retryingTry", { attempt: work.attempt }) : t("work.retrying");
    case "stopped":
      if (work.cause === "you") return t("work.stoppedByYou");
      if (work.detail === "stalled") return t("work.stoppedStalled");
      if (work.detail === "closed") return t("work.stoppedClosed");
      return t("work.stoppedEngine");
    default:
      return null;
  }
}

export function sidebarWorkLine(work: WorkState | undefined, now: number = Date.now()): string | null {
  if (!work || work.kind === "needs-you" || (work.kind === "stopped" && work.cause === "you")) return null;
  return workLine(work, now);
}

export function roomRowLine(work: WorkState | undefined, now: number = Date.now()): string | null {
  return work?.kind === "needs-you" ? workLine(work, now) : sidebarWorkLine(work, now);
}

export function somethingRunsFor(bot: { waitingForTeammates?: boolean; helpersWorking?: number; waitingOn?: readonly unknown[]; work?: WorkState } | undefined): boolean {
  return Boolean(bot && (bot.waitingForTeammates || (bot.helpersWorking ?? 0) > 0 || (bot.waitingOn?.length ?? 0) > 0 || bot.work?.kind === "running"));
}
