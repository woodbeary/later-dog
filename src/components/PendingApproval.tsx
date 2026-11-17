import { ChevronRight } from "lucide-react";
import { memo } from "react";
import type { Bot, Message } from "@/state/store";
import { useStoreDispatch } from "@/state/store-selectors";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { toolLabel } from "./ApprovalCard";
import { outboundSummary } from "@/lib/approval-summary";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY, MAC_ALLOW_KEY } from "../../shared/cloud-home";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { LASTING_WHY_WORDS, type LastingOffer } from "../../shared/lasting-allows";
import "../composer-parity.css";

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  allowKey?: string;
  lasting?: LastingOffer;
  commandAllowlist?: { command: string; cwd: string; providerInstanceId: string };
  detail: string;
  held?: string;
  heldCode?: string;
}

export function isRoutineApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.routineRequest);
}

export function isSkillApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.skillRequest);
}

export function isProfileApproval(pending: Pending): boolean {
  return Boolean(pending.message.card?.profileRequest);
}

export function pendingApprovals(messages: Message[]): Pending[] {
  return messages
    .filter((m) => m.kind === "options" && m.card?.requestId && m.card.tool && !m.card.answered && !m.card.dismissed && !m.card.expired)
    .map((m) => ({
      message: m,
      requestId: m.card!.requestId!,
      tool: m.card!.tool!,
      allowKey: m.card!.allowKey,
      lasting: m.card!.lasting,
      commandAllowlist: m.card!.commandAllowlist,
      detail: m.card!.subtitle,
      held: m.card!.held,
      heldCode: m.card!.heldCode,
    }));
}

export function spokenApprovalPrompt(pending: Pending, requester: string): string {
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const isProfileRequest = isProfileApproval(pending);
  if (isSkillRequest) {
    const updating = pending.message.card?.skillRequest?.action === "update";
    const title = pending.message.card?.title.trim() || t(
      updating ? "approval.voice.defaultUpdateSkill" : "approval.voice.defaultEnableSkill",
    );
    return t("approval.voice.skill", {
      requester,
      title: `${title}${/[.!?]$/.test(title) ? "" : "."}`,
      action: t(updating ? "approval.voice.actionUpdate" : "approval.voice.actionEnable"),
    });
  }
  if (isProfileRequest) {
    const title = pending.message.card?.title.trim() || t("approval.voice.defaultUpdateProfile");
    return t("approval.voice.profile", { requester, title });
  }
  if (!isRoutineRequest) {
    return t("approval.voice.command", { requester, tool: toolLabel(pending.tool, pending.message.card?.approvalScope), detail: pending.detail });
  }
  const title = pending.message.card?.title.trim() || t("approval.voice.defaultConfirmRoutine");
  return t("approval.voice.routine", {
    requester,
    title: `${title}${/[.!?]$/.test(title) ? "" : "."}`,
  });
}

function label(pending: Pending, botName?: string): string {
  if (isSkillApproval(pending)) {
    return pending.message.card?.skillRequest?.action === "update"
      ? t("approval.label.updateSkill")
      : t("approval.label.enableSkill");
  }
  if (isProfileApproval(pending)) {
    return t("approval.label.confirmProfileChange");
  }
  if (isRoutineApproval(pending)) {
    return pending.message.card?.routineRequest?.operation.action === "create"
      ? t("approval.label.confirmRoutine")
      : t("approval.label.confirmRoutineChange");
  }
  const action = toolLabel(pending.tool, pending.message.card?.approvalScope);
  return botName ? t("approval.ask.named", { name: botName, action }) : t("approval.ask.unnamed", { action });
}

export const PendingApprovalPanel = memo(function PendingApprovalPanel({
  pending,
  count,
  index,
  botName,
  coversId,
}: {
  pending: Pending;
  count: number;
  index: number;
  botName?: string;
  onCancelTurn?: () => void;
  locale?: string;
  coversId?: string;
}) {
  const heldNote = tFromServer(pending.heldCode, pending.held);
  const outbound = pending.message.card ? outboundSummary(pending.message.card) : undefined;
  const reviewed = isSkillApproval(pending) || isRoutineApproval(pending) || isProfileApproval(pending) || Boolean(pending.message.card?.modelRequest);
  const command = pending.commandAllowlist?.command ?? pending.detail;
  const showCovers = () => {
    const covers = coversId ? document.getElementById(coversId) : null;
    if (covers instanceof HTMLDetailsElement) covers.open = !covers.open;
  };
  const details = (
    <pre
      tabIndex={0}
      data-approval-command
      onClick={showCovers}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        showCovers();
      }}
      aria-label={
        isSkillApproval(pending)
          ? t("approval.aria.reviewSkill")
          : isRoutineApproval(pending)
            ? t("approval.aria.reviewRoutine")
            : isProfileApproval(pending)
              ? t("approval.aria.reviewProfile")
              : t("approval.aria.reviewDetails")
      }
      className="approval-parity-command"
    >
      {command}
    </pre>
  );
  return (
    <div
      role="region"
      aria-label={
        isSkillApproval(pending)
          ? t("approval.aria.pendingSkill")
          : isRoutineApproval(pending)
            ? t("approval.aria.pendingRoutine")
            : isProfileApproval(pending)
              ? t("approval.aria.pendingProfile")
              : t("approval.aria.pending")
      }
      data-approval-panel
    >
      <div className="flex flex-wrap items-baseline gap-x-2" aria-live="polite">
        <span className="sr-only">{t("approval.pending")}</span>
        <span data-approval-title className="approval-parity-title">{outbound ? outbound.headline : label(pending, botName)}</span>
        {outbound && outbound.summary && <span className="text-[13px] leading-[17px] text-ink-secondary">{outbound.summary}</span>}
        {count > 1 && (
          <span className="ml-auto text-[13px] leading-[17px] tabular-nums text-ink-secondary">
            {t("approval.position", { index: index + 1, count })}
          </span>
        )}
      </div>
      {reviewed ? (
        <details className="group mt-1.5 text-[13px] text-ink-secondary">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 hover:text-ink">{t("approval.viewDetails")}<ChevronRight size={13} className="transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
          {details}
        </details>
      ) : command ? details : null}
      {pending.message.card?.profileRequest?.changes.avatarUrl && <img src={pending.message.card.profileRequest.changes.avatarUrl} alt={t("botSettings.avatar.generatedPreview")} className="mt-3 size-24 rounded-xl object-cover" />}
      {pending.message.card?.skillRequest && (
        <SkillRequestPreview request={pending.message.card.skillRequest} />
      )}
      {heldNote && !(outbound && pending.allowKey) && <div className="mt-1.5 text-[12px] text-ink-secondary">{heldNote}</div>}
    </div>
  );
});

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
  coversId,
}: {
  pending: Pending;
  threadId: string;
  bot?: Bot;
  coversId?: string;
}) {
  const outbound = pending.message.card ? outboundSummary(pending.message.card) : undefined;
  const dispatch = useStoreDispatch();
  const ownerOrAdmin = useOwnerOrAdmin();
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const isProfileRequest = isProfileApproval(pending);
  const durableRequest = isRoutineRequest || isSkillRequest || isProfileRequest;
  const reviewedSha256 = pending.message.card?.skillRequest
    ? reviewedSkillSha256(pending.message.card.skillRequest)
    : undefined;
  const macSend = pending.tool === "mac_send_text" || pending.tool === "mac_send_email";
  const macRequest = pending.tool.startsWith("mac_") && !macSend;
  const lasting = !durableRequest ? pending.lasting : undefined;
  const lastingAlways = Boolean(lasting?.offered && ownerOrAdmin === true);
  const outboundChoice = outbound && !(pending.lasting && !pending.lasting.offered && pending.lasting.why === "always-asks");
  const lastingWhy = lasting && !lasting.offered ? LASTING_WHY_WORDS[lasting.why] : lasting?.offered && !lastingAlways ? LASTING_WHY_WORDS["owner-only"] : null;
  const decide = (behavior: "allow" | "deny", always = false, never = false) => {
    const lastingGrant = always && bot && lastingAlways ? { botId: bot.id } : undefined;
    const grant = always && bot && pending.allowKey && !lasting ? { botId: bot.id, key: pending.allowKey } : undefined;
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? "Declined." : undefined,
      reviewedSha256: behavior === "allow" ? reviewedSha256 : undefined,
      alwaysAllow: grant,
      lastingGrant,
      scope: never ? "never" : behavior !== "allow" ? undefined : grant || lastingGrant ? "always" : "once",
    });
  };

  const base = "approval-parity-button";
  const quiet = "approval-parity-deny";
  const primary = "approval-parity-allow";
  const durable = "approval-parity-button approval-parity-quiet";
  const reach = lastingAlways && bot
    ? t("lasting.reach.search", { name: bot.name })
    : lasting
    ? outbound && bot && !lasting.offered && lasting.why === "always-asks"
      ? t("approval.reach.connectorSkip", { name: bot.name, app: outbound.app ?? t("approval.reach.connectorApp") })
      : null
    : !durableRequest && bot && pending.allowKey
    ? outbound
      ? t("approval.reach.connector", { name: bot.name, app: outbound.app ?? t("approval.reach.connectorApp") })
      : pending.allowKey === MAC_ALLOW_KEY
      ? t("approval.reach.mac")
      : pending.allowKey === DELETE_OUTSIDE_WORKSPACE_ALLOW_KEY
      ? t("approval.reach.everywhere", { name: bot.name })
      : t(bot.tasks?.some((task) => task.threadId === threadId) ? "approval.reach.chat" : "approval.reach.dog", { name: bot.name })
    : null;
  const commandShown = Boolean(pending.commandAllowlist?.command ?? pending.detail) && !(isSkillRequest || isRoutineRequest || isProfileRequest || pending.message.card?.modelRequest);
  return (
    <div data-approval-actions className="approval-parity-actions">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto flex min-w-0 flex-wrap items-center gap-1">
          {!durableRequest && bot && pending.allowKey && !lasting && (
            <button
              onClick={() => decide("allow", true)}
              className={durable}
            >
              {t("approval.action.alwaysAllow")}
            </button>
          )}
          {macRequest && (
            <button
              onClick={() => decide("deny", false, true)}
              data-mac-never=""
              className={durable}
            >
              {t("approval.action.never")}
            </button>
          )}
          {lastingAlways && bot && (
            <button
              onClick={() => decide("allow", true)}
              data-lasting-always=""
              className={durable}
            >
              {t("approval.action.alwaysAllow")}
            </button>
          )}
          {lasting && lastingWhy && (
            <span data-lasting-why={lasting.offered ? "owner-only" : lasting.why} className="px-1 text-[12.5px] text-ink-tertiary">{t(lastingWhy)}</span>
          )}
        </div>
        {!macRequest && (
          <button
            onClick={() => decide("deny")}
            className={cn(base, quiet)}
          >
            {isRoutineRequest || isProfileRequest ? t("approval.action.cancel") : outboundChoice ? t("approval.action.skip") : macSend ? t("approval.action.dontSend") : t("approval.action.deny")}
          </button>
        )}
        <button
          onClick={() => decide("allow")}
          disabled={isSkillRequest && !reviewedSha256}
          className={cn(base, primary, "disabled:cursor-not-allowed disabled:opacity-40")}
        >
          {isSkillRequest
            ? pending.message.card?.skillRequest?.action === "update"
              ? t("approval.action.update")
              : t("approval.action.enable")
            : isRoutineRequest || isProfileRequest
              ? t("approval.action.confirm")
              : macSend
                ? t("approval.action.send")
                : outboundChoice
                  ? t("approval.action.allow")
                  : t("approval.action.allowOnce")}
        </button>
      </div>
      {reach && (
        <details id={coversId} data-approval-covers className="group mt-1 text-[12px] text-ink-tertiary">
          <summary className={cn("flex w-fit cursor-pointer list-none items-center gap-1 px-1 hover:text-ink-secondary", coversId && commandShown && "sr-only")}>
            {t("approval.reach.what")}
            <ChevronRight size={12} className="transition-transform group-open:rotate-90" aria-hidden="true" />
          </summary>
          <p className="mt-1 px-1 leading-snug text-ink-tertiary">{reach}</p>
        </details>
      )}
    </div>
  );
}
