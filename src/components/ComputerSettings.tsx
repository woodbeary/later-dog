import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { api, useStore, type Bot } from "@/state/store";
import { t } from "@/lib/i18n";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import { approvalModeOptions, approvalModeOptionsFor, type ApprovalModeOption } from "./ApprovalModeSelector";
import { BotAvatar } from "./Avatar";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";

const EVERYDAY_MODES: readonly ApprovalMode[] = ["ask", "auto"];

export function computerName(label: unknown): string | null {
  if (typeof label !== "string") return null;
  return label.trim().replace(/\.local$/i, "") || null;
}

export function executionChoices(bot: Bot, driverKind: string | undefined): { current: ApprovalMode; options: ApprovalModeOption[] } {
  const kind = driverKind ?? "";
  const mode = approvalModeFor(bot);
  const current = kind === "antigravityAgent" && mode === "auto" ? "ask" : mode;
  const options = approvalModeOptionsFor(kind).filter((option) => EVERYDAY_MODES.includes(option.mode) || option.mode === current);
  if (options.some((option) => option.mode === current)) return { current, options };
  return { current, options: [...options, ...approvalModeOptions().filter((option) => option.mode === current)] };
}

export function ThisComputerRow() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api<{ label?: unknown }>("/.well-known/laterdog/environment", { timeoutMs: 5_000 })
      .then((environment) => { if (active) setName(computerName(environment.label)); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  return (
    <div data-this-computer="" className="flex min-h-14 items-center gap-3 py-3">
      <Monitor size={18} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{name ?? t("place.local")}</span>
    </div>
  );
}

export function ExecutionRows() {
  const { state, dispatch } = useStore();
  const [warning, setWarning] = useState<string | null>(null);
  const dogs = state.bots.filter((bot) => !bot.hidden);

  const choose = (bot: Bot, mode: ApprovalMode) => {
    if (bot.busy || mode === approvalModeFor(bot)) return;
    if (mode === "auto" && bot.computer === "local") {
      setWarning(bot.id);
      return;
    }
    dispatch({ type: "updateBot", botId: bot.id, patch: { approvalMode: mode } });
  };

  const confirmLocal = () => {
    if (warning) dispatch({ type: "updateBot", botId: warning, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
    setWarning(null);
  };

  return (
    <div data-execution-rows="" className="rounded-xl bg-card px-4">
      <p className="pt-3 text-[12px] leading-relaxed text-ink-secondary">{t("settings.computer.executionHint")}</p>
      {dogs.length === 0 ? (
        <p className="py-4 text-[13px] text-ink-secondary">{t("settings.computer.noDogs")}</p>
      ) : (
        <ul className="flex flex-col py-1.5">
          {dogs.map((bot) => {
            const { current, options } = executionChoices(bot, state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId)?.driverKind);
            return (
              <li key={bot.id} data-execution-dog={bot.id} className="flex min-h-12 items-center gap-3 py-1.5">
                <BotAvatar bot={bot} size={28} label="" trackPointer={false} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{bot.name}</span>
                <select
                  aria-label={t("settings.computer.levelFor", { name: bot.name })}
                  value={current}
                  disabled={bot.busy === true || options.length < 2}
                  title={bot.busy ? t("approvalMode.busy") : undefined}
                  onChange={(event) => choose(bot, event.target.value as ApprovalMode)}
                  className="min-h-8 w-[136px] shrink-0 rounded-lg border border-hairline/40 bg-inset px-2.5 py-1.5 text-[13px] text-ink focus:border-focus disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {options.map((option) => <option key={option.mode} value={option.mode}>{option.label}</option>)}
                </select>
              </li>
            );
          })}
        </ul>
      )}
      <LocalComputerAutoWarning open={warning !== null} onCancel={() => setWarning(null)} onConfirm={confirmLocal} />
    </div>
  );
}
