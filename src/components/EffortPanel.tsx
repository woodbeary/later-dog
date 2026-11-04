import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { declaredEffort, effortLevelsFor, effortName, effortNote, recommendedEffort } from "@/lib/model-friendly";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot, type InstanceInfo } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import { fitEffort } from "../../shared/effort";
import { fastModeFits } from "@/lib/fast-mode";
import { Switch } from "./SettingsPrimitives";

export function effortChoices(instance: InstanceInfo | undefined, model: string): EffortLevel[] {
  return effortLevelsFor(instance, model).filter((level) => level !== "none");
}

export function chosenEffort(instance: InstanceInfo | undefined, model: string, effort: EffortLevel | undefined): EffortLevel | undefined {
  const levels = effortChoices(instance, model);
  return fitEffort(levels, effort) ?? declaredEffort(levels, instance?.models?.options.find((option) => option.id === model)?.defaultEffort);
}

export function effortIsDefault(instance: InstanceInfo | undefined, model: string, effort: EffortLevel | undefined): boolean {
  const levels = effortChoices(instance, model);
  const declared = declaredEffort(levels, instance?.models?.options.find((option) => option.id === model)?.defaultEffort);
  return chosenEffort(instance, model, effort) === declared;
}

export function EffortPanel({ bot, threadId, className }: { bot: Bot; threadId?: string; className?: string }) {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  const levels = effortChoices(instance, selection.model);
  const option = instance?.models?.options.find((candidate) => candidate.id === selection.model);
  const name = (level: EffortLevel) => effortName(level, instance?.driverKind);
  const fast = fastModeFits(instance, selection.model);
  const updateBotDefault = Boolean(threadId) && (!state.config?.cloudHome || ownerOrAdmin === true);

  if (levels.length === 0 && !fast) return null;
  const save = (next: typeof selection) => dispatch({ type: "setModel", botId: bot.id, threadId,
    ...(updateBotDefault ? { updateBotDefault: true } : {}), selection: next });
  const current = chosenEffort(instance, selection.model, selection.effort);
  const recommended = recommendedEffort(levels, option?.defaultEffort);
  const label = current ? name(current) : t("model.effort.auto");
  const note = current ? effortNote(current) : undefined;
  const columns = { gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` };

  return (
    <div data-effort-panel className={cn("px-3.5 py-3", className)}>
      {levels.length > 0 && (
        <>
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-medium text-ink">
              {t("model.effort.title")} <span className="font-normal text-ink-secondary">{label}</span>
            </span>
            <span title={t("model.effort.help")} className="text-ink-tertiary">
              <CircleHelp size={13} aria-label={t("model.effort.help")} />
            </span>
          </div>
          <div className="mt-2 flex justify-between text-[11px] text-ink-tertiary">
            <span>{t("model.effort.faster")}</span>
            <span>{t("model.effort.smarter")}</span>
          </div>
          <div role="radiogroup" aria-label={t("model.simple.effort")} className="mt-1 grid rounded-lg bg-inset p-0.5" style={columns}>
            {levels.map((level) => (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={level === current}
                aria-label={name(level)}
                title={effortNote(level) ? `${name(level)} · ${effortNote(level)}` : name(level)}
                data-effort-level={level}
                onClick={() => save({ ...selection, effort: level })}
                className="group/level flex h-6 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              >
                {level === current
                  ? <span className="h-5 w-6 rounded-[6px] bg-ink shadow-sm" />
                  : !current && level === recommended
                    ? <span className="h-5 w-6 rounded-[6px] bg-ink/35 transition-colors group-hover/level:bg-ink/55" />
                    : <span className="size-1 rounded-full bg-ink-tertiary transition-transform group-hover/level:scale-[2] group-hover/level:bg-ink-secondary" />}
              </button>
            ))}
          </div>
          <div className="mt-1 grid" style={columns}>
            {levels.map((level) => (
              <span key={level} className="flex justify-center overflow-visible whitespace-nowrap text-[10.5px] text-ink-tertiary">
                {level === recommended ? t("model.effort.recommended") : ""}
              </span>
            ))}
          </div>
          {note && <p data-effort-note className="mt-1.5 text-[11.5px] leading-snug text-ink-tertiary">{note}</p>}
        </>
      )}
      {fast && (
        <div data-effort-fast className={cn("flex items-center justify-between gap-3", levels.length > 0 && "mt-2.5 border-t border-hairline/40 pt-2.5")}>
          <span className="text-[13px] text-ink">{t("model.fast")}</span>
          <Switch
            checked={selection.fast === true}
            aria-label={t("model.fast")}
            onClick={() => {
              const { fast: _wasFast, ...rest } = selection;
              save(selection.fast ? rest : { ...rest, fast: true });
            }}
          />
        </div>
      )}
    </div>
  );
}
