import { CircleHelp, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { effortLevelsFor, effortName, effortNote, recommendedEffort } from "@/lib/model-friendly";
import { useOwnerOrAdmin } from "@/lib/use-owner-or-admin";
import { useStore, type Bot } from "@/state/store";
import type { EffortLevel } from "../../shared/wire";
import { fitEffort } from "../../shared/effort";
import { fastModeFits } from "@/lib/fast-mode";
import { useMenuMotion } from "./MenuMotion";
import { Switch } from "./SettingsPrimitives";

export function EffortButton({ bot, threadId }: { bot: Bot; threadId?: string }) {
  const { state, dispatch } = useStore();
  const ownerOrAdmin = useOwnerOrAdmin();
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const selection = bot.modelSelection;
  const instance = state.instances.find((candidate) => candidate.instanceId === selection.instanceId);
  const levels: EffortLevel[] = effortLevelsFor(instance, selection.model).filter((level) => level !== "none");
  const option = instance?.models?.options.find((candidate) => candidate.id === selection.model);
  const name = (level: EffortLevel) => effortName(level, instance?.driverKind);
  const fast = fastModeFits(instance, selection.model);
  const updateBotDefault = Boolean(threadId) && (!state.config?.cloudHome || ownerOrAdmin === true);

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (levels.length === 0 && !fast) return null;
  const save = (next: typeof selection) => dispatch({ type: "setModel", botId: bot.id, threadId,
    ...(updateBotDefault ? { updateBotDefault: true } : {}), selection: next });
  const current = fitEffort(levels, selection.effort);
  const recommended = recommendedEffort(levels, option?.defaultEffort);
  const label = current ? name(current) : t("model.effort.default");
  const note = current ? effortNote(current) : undefined;
  const columns = { gridTemplateColumns: `repeat(${levels.length}, minmax(0, 1fr))` };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        data-effort-button
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t("model.simple.effort")}
        onClick={() => setOpen((was) => !was)}
        className={cn("flex h-8 items-center gap-1 rounded-full px-2 text-[13px] text-ink-secondary hover:bg-control hover:text-ink", open && "bg-control text-ink")}
      >
        {selection.fast && fast && <Zap size={13} aria-label={t("model.fast")} className="fill-current" />}
        {levels.length > 0 ? label : t("model.fast")}
      </button>
      {motion.shown && (
        <div
          role="dialog"
          aria-label={t("model.simple.effort")}
          data-effort-menu
          {...motion.exitProps}
          className={cn("absolute bottom-full right-0 z-30 mb-2 w-52 rounded-xl border border-hairline/50 bg-card p-2.5 shadow-2xl shadow-black/50", motion.className)}
        >
          {levels.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] text-ink-secondary">
                  {t("model.effort.title")} <span className="text-ink">{label}</span>
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
                    className="flex h-5 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    {level === current
                      ? <span className="h-4 w-5 rounded-[5px] bg-ink shadow-sm" />
                      : !current && level === recommended
                        ? <span className="h-4 w-5 rounded-[5px] bg-ink/35" />
                        : <span className="size-1 rounded-full bg-ink-tertiary" />}
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
              {note && <p data-effort-note className="mt-2 text-[11px] leading-snug text-ink-tertiary">{note}</p>}
            </>
          )}
          {fast && (
            <div data-effort-fast className={cn("flex items-center justify-between gap-3", levels.length > 0 && "mt-2 border-t border-hairline/40 pt-2")}>
              <span className="text-[12.5px] text-ink">{t("model.fast")}</span>
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
      )}
    </div>
  );
}
