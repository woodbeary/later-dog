import { AlertTriangle, ChevronRight, X } from "lucide-react";
import { memo } from "react";
import { useStore, type Bot, type Message } from "@/state/store";
import { cn } from "@/lib/cn";
import { t, tFromServer } from "@/lib/i18n";
import { SkillRequestPreview } from "@/components/SkillRequestPreview";
import { toolLabel } from "./ApprovalCard";
import { outboundSummary } from "@/lib/approval-summary";
import { reviewedSkillSha256 } from "../../shared/skill-request";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";

const NEVER_MESSAGE = "The person chose Never for this action. Do not try it again.";

export interface Pending {
  message: Message;
  requestId: string;
  tool: string;
  allowKey?: string;
  allowSession?: boolean;
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
      allowSession: m.card!.allowSession,
      commandAllowlist: m.card!.commandAllowlist,
      detail: m.card!.subtitle,
      held: m.card!.held,
      heldCode: m.card!.heldCode,
    }));
}

export function spokenApprovalPrompt(pending: Pending, requester: string): string {
  if (pending.message.card?.teamSetupRequest) return `${requester}: ${pending.message.card.title} Review the details and choose ${pending.message.card.options[0]} or Cancel.`;
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
  if (pending.message.card?.teamSetupRequest) return pending.message.card.title;
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
  onCancelTurn,
}: {
  pending: Pending;
  count: number;
  index: number;
  botName?: string;
  onCancelTurn?: () => void;
  locale?: string;
}) {
  const heldNote = tFromServer(pending.heldCode, pending.held);
  const outbound = pending.message.card ? outboundSummary(pending.message.card) : undefined;
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
      className="rounded-t-[18px] bg-card px-4 pb-1 pt-3"
    >
      <div className="flex flex-wrap items-center gap-2" aria-live="polite">
        <span className="sr-only">{t("approval.pending")}</span>
        <AlertTriangle size={15} className="shrink-0 text-warning" aria-hidden="true" />
        {count > 1 && (
          <span className="rounded-full bg-control px-1.5 py-0.5 text-[11px] tabular-nums text-ink-secondary">
            {t("approval.position", { index: index + 1, count })}
          </span>
        )}
        <span className="text-[14px] font-medium text-ink">{outbound ? outbound.headline : label(pending, botName)}</span>
        {outbound && outbound.summary && <span className="text-[13px] text-ink-secondary">{outbound.summary}</span>}
        {onCancelTurn && (
          <button
            type="button"
            onClick={onCancelTurn}
            aria-label={t("approval.action.cancelTurn")}
            title={t("approval.action.cancelTurn")}
            className="-mr-1.5 ml-auto flex size-7 shrink-0 items-center justify-center rounded-full text-ink-tertiary transition-colors hover:bg-control hover:text-ink"
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      <details className="group mt-1.5 text-[13px] text-ink-secondary">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 hover:text-ink">{t("approval.viewDetails")}<ChevronRight size={13} className="transition-transform group-open:rotate-90" aria-hidden="true" /></summary>
      <pre
        tabIndex={0}
        aria-label={
          isSkillApproval(pending)
            ? t("approval.aria.reviewSkill")
            : isRoutineApproval(pending)
              ? t("approval.aria.reviewRoutine")
              : isProfileApproval(pending)
                ? t("approval.aria.reviewProfile")
                : t("approval.aria.reviewDetails")
        }
        className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink"
      >
        {pending.commandAllowlist?.command ?? pending.detail}
      </pre>
      </details>
      {pending.message.card?.profileRequest?.changes.avatarUrl && <img src={pending.message.card.profileRequest.changes.avatarUrl} alt={t("botSettings.avatar.generatedPreview")} className="mt-3 size-24 rounded-xl object-cover" />}
      {pending.message.card?.skillRequest && (
        <SkillRequestPreview request={pending.message.card.skillRequest} />
      )}
      {heldNote && <div className="mt-1.5 text-[12px] text-ink-secondary">{heldNote}</div>}
    </div>
  );
});

export function PendingApprovalActions({
  pending,
  threadId,
  bot,
}: {
  pending: Pending;
  threadId: string;
  bot?: Bot;
}) {
  const { dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const isRoutineRequest = isRoutineApproval(pending);
  const isSkillRequest = isSkillApproval(pending);
  const isProfileRequest = isProfileApproval(pending);
  const isTeamSetup = Boolean(pending.message.card?.teamSetupRequest);
  const durableRequest = isRoutineRequest || isSkillRequest || isProfileRequest || isTeamSetup;
  const canRememberCommand = ownerOrAdmin === true && !durableRequest && !pending.allowKey && Boolean(pending.commandAllowlist);
  const reviewedSha256 = pending.message.card?.skillRequest
    ? reviewedSkillSha256(pending.message.card.skillRequest)
    : undefined;
  const decide = (behavior: "allow" | "deny", always = false, rememberCommand = false) => {
    const grant = always && bot && pending.allowKey ? { botId: bot.id, key: pending.allowKey } : undefined;
    const forChat = always && !pending.allowKey && pending.allowSession ? true : undefined;
    dispatch({
      type: "decideRequest",
      threadId,
      requestId: pending.requestId,
      behavior,
      message: behavior === "deny" ? (durableRequest ? "Declined." : NEVER_MESSAGE) : undefined,
      reviewedSha256: behavior === "allow" ? reviewedSha256 : undefined,
      alwaysAllow: grant,
      always: forChat,
      rememberCommand: rememberCommand || undefined,
      scope: behavior !== "allow" ? undefined : grant || rememberCommand ? "always" : forChat ? "chat" : "once",
    });
  };

  const base = "rounded-full px-3.5 py-1.5 text-[13.5px] transition-colors";
  const quiet = "bg-control text-ink hover:bg-control-hover";
  const primary = "bg-accent font-medium text-white hover:brightness-110";
  const alwaysIsPrimary = !durableRequest && Boolean((bot && pending.allowKey) || (!pending.allowKey && !canRememberCommand && pending.allowSession));
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-[18px] bg-card px-3 pb-3 pt-1">
      {!durableRequest && bot && pending.allowKey && (
        <button
          onClick={() => decide("allow", true)}
          title={t("approval.action.stopAsking", { name: bot.name, key: pending.allowKey })}
          className={cn(base, primary)}
        >
          {t("approval.action.alwaysAllow")}
        </button>
      )}
      {!durableRequest && !pending.allowKey && !canRememberCommand && pending.allowSession && (
        <button
          onClick={() => decide("allow", true)}
          title={t("approval.action.alwaysAllowSessionHint")}
          className={cn(base, primary)}
        >
          {t("approval.action.alwaysAllowSession")}
        </button>
      )}
      {canRememberCommand && pending.commandAllowlist && (
        <button
          onClick={() => decide("allow", false, true)}
          title={t("approval.action.alwaysAllowCommandHint", { cwd: pending.commandAllowlist.cwd })}
          className={cn(base, quiet)}
        >
          {t("approval.action.alwaysAllowCommand")}
        </button>
      )}
      <button
        onClick={() => decide("allow")}
        disabled={isSkillRequest && !reviewedSha256}
        className={cn(
          base,
          alwaysIsPrimary ? quiet : primary,
          "disabled:cursor-not-allowed disabled:opacity-40",
        )}
      >
        {isTeamSetup ? pending.message.card?.options[0] : isSkillRequest
          ? pending.message.card?.skillRequest?.action === "update"
            ? t("approval.action.update")
            : t("approval.action.enable")
          : isRoutineRequest || isProfileRequest
            ? t("approval.action.confirm")
            : t("approval.action.allowOnce")}
      </button>
      <button
        onClick={() => decide("deny")}
        autoFocus={isTeamSetup}
        className={cn(base, quiet)}
      >
        {isRoutineRequest || isProfileRequest || isTeamSetup ? t("approval.action.cancel") : t("approval.action.never")}
      </button>
    </div>
  );
}
