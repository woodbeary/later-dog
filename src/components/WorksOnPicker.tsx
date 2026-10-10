import { useId, useState } from "react";
import { useStore, type Bot } from "@/state/store";
import type { BotUpdatePatch } from "@/state/bot-patch-queue";
import { allowComputer } from "@/lib/allow-computer";
import { browserAvailable } from "@/lib/feature-flags";
import { t } from "@/lib/i18n";
import { instanceSupportsLocalComputer, localComputerDisabledReason, localComputerSelectable } from "@/lib/local-computer";
import { placeOffered } from "@/lib/place";
import { openPlaceAction, placeBlocked, placeFacts, placeHasIssue, placeViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import { turnOnBrowser } from "@/lib/turn-on-browser";
import { approvalModeFor } from "../../shared/approval-mode";
import type { PlaceActionId } from "../../shared/place-view";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";

export type WorksOn = NonNullable<Bot["computer"]> | "auto";

export const WORKS_ON: readonly WorksOn[] = ["auto", "cloud", "vm", "local", "browser", "off"];

const PICKER_ACTIONS: ReadonlySet<PlaceActionId> = new Set([
  "choose-model", "allow-computer", "sign-in", "see-plan", "manage-computers", "open-my-cloud", "add-boat-key", "turn-on-browser",
]);

export function worksOnPatch(place: WorksOn): BotUpdatePatch {
  if (place === "auto") return { computer: null };
  if (place === "browser") return { computer: "browser", browser: true };
  return { computer: place };
}

export function WorksOnPicker({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const platform = capabilities.host.platform;
  const seat = usePlaceSeat(state.config, platform);
  const selectId = useId();
  const [warning, setWarning] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const providerSupportsLocal = instanceSupportsLocalComputer(state.instances, bot);
  const local = {
    ready: placeOffered("local", state.config) && localComputerSelectable({ capabilities, providerSupportsLocal }),
    reason: localComputerDisabledReason({ capabilities, providerSupportsLocal }) ?? t("computer.unavailableLocal"),
  };
  const policy = state.config?.managedPolicy;
  const current: WorksOn = bot.computer ?? "auto";
  const browserCanTurnOn = browserAvailable(state.config) || state.config?.browserEngine?.installable === true;
  const options = WORKS_ON.filter((place) => place === "auto" || place === "off" || placeOffered(place, state.config)).map((place) => {
    const view = placeViewFor(placeFacts({ bot, place, seat, config: state.config, instances: state.instances, local }));
    const managedKind = place === "local" ? "thisComputer" : place === "vm" ? "localVm" : place === "cloud" ? (bot.cloudBackend === "vps" ? "vps" : "box") : null;
    const managedBy = policy && managedKind && !policy.computers[managedKind] ? t("policy.managedBy", { organization: policy.organizationName }) : undefined;
    const note = managedBy ?? (placeHasIssue(view) ? view.short : undefined);
    const blocked = placeBlocked(view) && !(view.state === "browser-off" && view.action && browserCanTurnOn);
    const label = worksOnSimpleLabel(place === "auto" ? undefined : place, platform);
    return {
      place,
      view,
      label: note ? t("computer.simple.optionNote", { place: label, note }) : label,
      title: managedBy ?? view.line,
      disabled: place !== current && (Boolean(managedBy) || blocked),
    };
  });
  const chosen = options.find(({ place }) => place === current) ?? options[0]!;
  const action = chosen.view.action && PICKER_ACTIONS.has(chosen.view.action.id) ? chosen.view.action : null;
  const choose = (place: WorksOn) => {
    if (place === current) return;
    setError(null);
    if (place === "local" && approvalModeFor(bot) === "auto") {
      setWarning(true);
      return;
    }
    dispatch({ type: "updateBot", botId: bot.id, patch: worksOnPatch(place) });
  };
  const run = async (id: PlaceActionId) => {
    if (id !== "allow-computer" && id !== "turn-on-browser") {
      openPlaceAction(id, { botId: bot.id, threadId: bot.threadId }, dispatch);
      return;
    }
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      if (id === "allow-computer") await allowComputer(bot);
      else await turnOnBrowser(state.config, bot, dispatch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  };
  return (
    <div data-testid="works-on">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={selectId} className="min-w-0 flex-1 text-[14px] text-ink">
          {t("computer.simple.whereWorks", { name: bot.name })}
        </label>
        <select
          id={selectId}
          data-testid="works-on-select"
          value={current}
          onChange={(event) => choose(event.target.value as WorksOn)}
          className="min-w-0 max-w-[60%] shrink-0 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-1.5 text-[13px] text-ink"
        >
          {options.map(({ place, label, title, disabled }) => (
            <option key={place} value={place} disabled={disabled} title={title}>{label}</option>
          ))}
        </select>
      </div>
      <p data-testid="works-on-line" className="mt-1.5 text-[12px] leading-relaxed text-ink-secondary">{chosen.view.line}</p>
      {action && (
        <button
          type="button"
          data-testid="works-on-action"
          disabled={working}
          onClick={() => void run(action.id)}
          className="mt-1 text-[12px] font-medium text-accent hover:underline disabled:opacity-50"
        >
          {action.label}
        </button>
      )}
      {error && <p role="alert" className="mt-1 text-[12px] text-danger">{error}</p>}
      <LocalComputerAutoWarning
        open={warning}
        onCancel={() => setWarning(false)}
        onConfirm={() => {
          setWarning(false);
          dispatch({ type: "updateBot", botId: bot.id, patch: { computer: "local", acknowledgeLocalAuto: true } });
        }}
      />
    </div>
  );
}
