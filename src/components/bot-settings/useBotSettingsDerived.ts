import { useDesktopCapabilities } from "../DesktopCapabilities";
import { stateForBot } from "@/lib/mascot";
import { useStore, type Bot } from "@/state/store";
import { approvalModeFor } from "../../../shared/approval-mode";

export type BotPatch = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "soul"
    | "notifications"
    | "cloudBackend"
    | "autoStartVps"
    | "color"
    | "mascotExpression"
    | "mascotBody"
    | "avatarUrl"
    | "avatarCrop"
    | "avatarZoom"
    | "avatarFocusX"
    | "avatarFocusY"
    | "alwaysAllow"
    | "autoApprove"
    | "approvalMode"
    | "outbound"
    | "fallback"
    | "speakReplies"
    | "memoryEnabled"
    | "voice"
    | "chiefOfStaff"
    | "managedSections"
    | "approvePeerComms"
    | "composio"
    | "browser"
    | "mcpServers"
    | "modelSelection"
  >
> & {
  computer?: Bot["computer"] | null;
  /** null drops the explicit record and returns the bot to the legacy
   * all-tools boolean. */
  connectorTools?: Bot["connectorTools"] | null;
  connectorScopes?: Bot["connectorScopes"] | null;
  acknowledgeLocalAuto?: boolean;
  confirmFullAccess?: boolean;
  acknowledgePeerScope?: boolean;
};

export function useBotSettingsDerived(bot: Bot) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const patch = (p: BotPatch) => dispatch({ type: "updateBot", botId: bot.id, patch: p });
  const activeState = stateForBot(bot);
  const engine = state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId);
  // The approval level (ask / auto / full / custom) as the shared rule reads
  // it from the record — bots saved before approvalMode existed still carry
  // only autoApprove. Full and Custom need the packaged desktop's trusted
  // channel (SettingsPanel used the same test before the dialog replaced it).
  const approvalMode = approvalModeFor(bot);
  const trustedModesAvailable = Boolean(window.laterdog?.approvals && capabilities.host.packaged);
  const botRoutines = state.routines.filter((routine) => routine.botId === bot.id);

  return {
    patch,
    engine,
    approvalMode,
    trustedModesAvailable,
    botRoutines,
    activeState,
  };
}
