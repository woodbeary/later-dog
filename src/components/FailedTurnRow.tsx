import { AlertTriangle, RefreshCw } from "lucide-react";
import { useDesktopCapabilities } from "@/components/DesktopCapabilities";
import type { InstanceInfo, Message } from "@/state/store";
import { dogIn, useStoreDispatch, useStoreSelector } from "@/state/store-selectors";
import { openExternalLink } from "@/lib/app-links";
import { claudeUpdateTarget } from "@/lib/claude-update-target";
import { failedTurnCause, signedOutEngine } from "@/lib/failed-turn";
import { t } from "@/lib/i18n";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { openPlaceAction, placeRowViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import type { PlaceRow } from "../../shared/place-view";
import { isProviderSafetyBlock, PROVIDER_SAFETY_GUIDANCE, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { CHATGPT_USAGE_URL } from "./ChatGptPlanStatus";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { EngineSetup } from "./EngineSetup";
import { LimitRow } from "./LimitRow";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";

export function ErrorRow({
  message,
  headline: plainHeadline,
  onRetry,
  action,
  setupInstance,
  claudeUpdateInstance,
}: {
  message: string;
  headline?: string;
  onRetry?: () => void;
  action?: { label: string; onClick: () => void } | null;
  setupInstance?: InstanceInfo;
  claudeUpdateInstance?: InstanceInfo;
}) {
  const { capabilities, ready } = useDesktopCapabilities();
  const failedPermissions = missingMacCuaPermissions(message);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  const macCuaReason = ready && capabilities.host.platform === "darwin" &&
    capabilities.localComputer.available === false && capabilities.localComputer.reasonCode !== "remote-server" &&
    message.startsWith("CUA Driver is not ready for this computer — ") &&
    failedPermissions.length > 0 && failedPermissions.join(",") === currentPermissions.join(",")
    ? macCuaPermissionMessage(currentPermissions)
    : null;
  const headline = macCuaReason ?? plainHeadline ?? message;
  return (
    <div className="flex justify-start">
      <div data-turn-error className="w-fit max-w-[min(42rem,78%)] rounded-bubble bg-card px-3 py-[7px] text-[14px] leading-[21px] text-ink">
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-[3.5px] shrink-0 text-ink-secondary" />
          <span className="min-w-0 break-words">{headline}</span>
        </div>
        {headline !== message && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{macCuaReason ? t("computer.mac.permission.driverDetail") : t("chat.error.details")}</summary><p className="mt-1 break-words">{message}</p></details>}
        {macCuaReason &&
          <MacCuaRecoveryActions reason={message} />}
        {message.includes("subscription_sharing_usage_limit_exceeded") ? (
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-app" onClick={(event) => {
            if (window.laterdog?.openExternal) { event.preventDefault(); void openExternalLink(CHATGPT_USAGE_URL); }
          }}>{t("engineSetup.chatgpt.manageUsage")}</a>
        ) : claudeUpdateInstance ? (
          <ClaudeUpdatePrompt instance={claudeUpdateInstance} onRetry={onRetry} />
        ) : isProviderSafetyBlock(message) ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            {PROVIDER_SAFETY_GUIDANCE}{" "}
            <a href={PROVIDER_SAFETY_HELP_URL} target="_blank" rel="noreferrer" className="underline transition-opacity hover:opacity-80">About provider safety checks</a>
          </p>
        ) : setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : action !== undefined ? (
          action && (
            <button
              type="button"
              onClick={action.onClick}
              className="mt-1.5 mb-0.5 flex items-center gap-1.5 rounded-full bg-control px-3 py-1 text-[13px] text-ink hover:bg-control-hover"
            >
              {action.label}
            </button>
          )
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 mb-0.5 flex items-center gap-1.5 rounded-full bg-control px-3 py-1 text-[13px] text-ink hover:bg-control-hover"
            >
              <RefreshCw size={12} /> {t("chat.retry")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function PlaceFailedRow({ place, botId, threadId, onRetry }: {
  place: PlaceRow;
  botId: string;
  threadId?: string;
  onRetry?: () => void;
}) {
  const dispatch = useStoreDispatch();
  const config = useStoreSelector((state) => state.config);
  const computer = useStoreSelector((state) => dogIn(state, botId)?.computer);
  const { capabilities } = useDesktopCapabilities();
  const seat = usePlaceSeat(config, capabilities.host.platform);
  const view = placeRowViewFor(place, seat, worksOnSimpleLabel(computer, capabilities.host.platform));
  const id = view.action?.id;
  const onClick = !id ? undefined
    : id === "try-again" ? onRetry
    : () => { openPlaceAction(id, { botId, threadId }, dispatch); };
  return <ErrorRow message={view.line} action={view.action && onClick ? { label: view.action.label, onClick } : null} />;
}

export function FailedTurnRow({ tool, engine, onRetry, botId, threadId }: {
  tool: NonNullable<Message["tool"]>;
  engine: InstanceInfo | undefined;
  onRetry?: () => void;
  botId?: string;
  threadId?: string;
}) {
  if (tool.place && botId) return <PlaceFailedRow place={tool.place} botId={botId} threadId={threadId} onRetry={onRetry} />;
  if (tool.quota) return <LimitRow tool={tool} onRetry={onRetry} botId={botId} threadId={threadId} />;
  const signedOut = signedOutEngine(tool, engine);
  return (
    <ErrorRow
      message={failedTurnCause(tool.name) ?? tool.name}
      headline={signedOut && t("chat.error.signedOut", { name: signedOut.displayName })}
      onRetry={onRetry}
      setupInstance={tool.setup ? engine : undefined}
      claudeUpdateInstance={tool.claudeUpdate ? claudeUpdateTarget(engine) : undefined}
    />
  );
}
