// The dog editor: a right-hand panel with the dog's face and three tabs.
// Details is what a person changes about a dog (how it looks, its name and
// label, its instructions, what it runs on, how much it decides alone);
// Library is its tricks, what it made in chat, and its memory; Computer is
// where it works. Every field writes through patch → updateBot → PATCH
// /api/bots/:id. Which tab shows is the store's botSettingsSection folded
// onto a tab, so older deep links from other panels still land somewhere.
import { useEffect, useRef, useState } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";

import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { DOG_COLOR_NAMES, DOG_COLORS } from "@/lib/mascot";
import { placeFacts, placeViewFor, usePlaceSeat } from "@/lib/place-view";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { DEFAULT_MASCOT_BODY, MASCOT_BODIES, MASCOT_BODY_IDS } from "../../shared/mascot-bodies";
import type { ApprovalMode } from "../../shared/approval-mode";
import { approvalModeOptionsFor } from "./ApprovalModeSelector";
import { BotAvatar, DogAvatar } from "./Avatar";
import { isDogBreed } from "./DogAvatar";
import { useCaptionChrome, useDesktopCapabilities } from "./DesktopCapabilities";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { ModelPicker } from "./ModelPicker";
import { Switch } from "./SettingsPrimitives";
import { SoulField } from "./SoulField";
import { ThreadModelsLine } from "./ThreadModelsLine";
import { TreatCount } from "./TreatCount";
import { useBotEditor } from "./bot-settings/BotEditorContext";
import { botLibraryItems } from "./bot-settings/library";
import { MemorySection } from "./bot-settings/MemorySection";
import { BOT_SECTIONS, tabForSection } from "./bot-settings/sections";
import { SkillReviewDialog, useManagedSkills } from "./bot-settings/SkillsSection";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";

const BREEDS = MASCOT_BODY_IDS.filter((id) => isDogBreed(id));

const groupLabelCls = "mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary";
const cardCls = "rounded-xl bg-card";
const rowCls = "px-4 py-3";
const dividedRowCls = "border-t border-hairline/40 px-4 py-3";
const rowLabelCls = "block text-[12px] text-ink-secondary";
const rowInputCls = "mt-1 w-full bg-transparent text-[14px] text-ink placeholder:text-ink-tertiary focus:outline-none";
const pillCls = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45";
const itemTextCls = "min-w-0 flex-1";

export function BotSettingsDialog({ bot, overlay = false }: {
  bot: Bot;
  /** Float over the chat instead of taking a column: the inspector or
   * computer panel is open too and the window cannot seat both (App). */
  overlay?: boolean;
}) {
  const { state, dispatch } = useStore();
  const { request: api } = useBotEditor();
  const derived = useBotSettingsDerived(bot);
  const { patch, approvalMode, engine, trustedModesAvailable } = derived;
  const dialogRef = useRef<HTMLElement | null>(null);
  // Windows draws its caption buttons over the top-right corner, where this
  // panel's close button sits; drop the header below them.
  const { padClass } = useCaptionChrome();
  const { capabilities } = useDesktopCapabilities();
  const placeSeat = usePlaceSeat(state.config, capabilities.host?.platform ?? "other");
  // A bare open (the mascot, the header button) lands on Details; a deep
  // link from another panel, or a tab press here, names a section.
  const tab = state.botSettingsExpandAccordion ? tabForSection(state.botSettingsSection) : "details";
  const skills = useManagedSkills(bot);
  const libraryOn = skillsLibraryEnabled(state.config);
  const [localAutoWarning, setLocalAutoWarning] = useState<string | null>(null);
  const [teaching, setTeaching] = useState(false);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");

  // Match the full selector's old rule: Antigravity's Auto still executes as
  // Ask. Show that without changing the saved mode.
  const displayedApprovalMode = engine?.driverKind === "antigravityAgent" && approvalMode === "auto" ? "ask" : approvalMode;
  // Heel (Ask) is always offered; Off-leash is the provider's own Auto,
  // which a few engines do not have.
  const autoOffered = approvalModeOptionsFor(engine?.driverKind ?? "", trustedModesAvailable)
    .some((option) => option.mode === "auto");
  const chooseMode = (mode: Extract<ApprovalMode, "ask" | "auto">) => {
    // No change while a turn runs, and Auto on this computer needs its warning first.
    if (bot.busy || mode === approvalMode) return;
    if (mode === "auto" && bot.computer === "local") {
      setLocalAutoWarning(bot.id);
      return;
    }
    patch({ approvalMode: mode });
  };
  const customMode = displayedApprovalMode !== "ask" && displayedApprovalMode !== "auto";

  const importSkill = async () => {
    const trimmed = source.trim();
    if (!trimmed || importing) return;
    setImporting(true);
    skills.setError("");
    setImportMessage("");
    try {
      const result = (await api(`/api/bots/${bot.id}/skills`, {
        method: "POST",
        body: JSON.stringify({ source: trimmed }),
      })) as { installed?: unknown[] };
      setImportMessage(t("botSettings.simple.teachImported", { count: (result.installed ?? []).length }));
      setSource("");
      await skills.refresh();
    } catch (cause) {
      skills.setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();

    const onKey = (event: KeyboardEvent) => {
      // A dialog opened from inside this one (a skill review, the model
      // picker, a computer warning) owns Escape while it is up — but only a
      // *visible* one: a hidden or zero-size leftover must not trap the
      // panel's own dismiss path.
      const nested = dialog?.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      if (nested && nested.getClientRects().length > 0) return;
      // A key pressed with focus outside this panel belongs to whatever
      // holds focus, never to us.
      if (dialog && event.target instanceof Node && !dialog.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        dispatch({ type: "toggleSettings", open: false });
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previousFocus?.focus();
    };
  }, [dispatch]);

  const close = () => dispatch({ type: "toggleSettings", open: false });
  const breed = bot.mascotBody ?? DEFAULT_MASCOT_BODY;
  const library = tab === "library" ? botLibraryItems(bot) : [];
  const approvalHint = customMode
    ? t("botSettings.simple.customMode")
    : displayedApprovalMode === "auto"
      ? t("botSettings.simple.decideHint")
      : t("botSettings.simple.askHint");

  return (
    <>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-labelledby="bot-settings-title"
        tabIndex={-1}
        className={cn(
          // focus() lands here when the panel opens; the global :focus-visible
          // ring would frame the whole sheet, so it is off for the container.
          "animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel outline-none focus-visible:outline-none",
          overlay
            // Below md every panel already covers the window; from md up
            // this one hugs the right edge over the chat, shadowed so it
            // reads as a sheet on top of the panel that stays beneath it.
            ? "md:inset-auto md:right-0 md:top-0 md:bottom-0 md:w-[min(420px,42vw)] md:shadow-2xl"
            : "md:static md:z-auto md:w-[min(420px,42vw)] md:shrink-0",
        )}
      >
        <div className={cn("flex shrink-0 items-center justify-between px-4 py-3", padClass)}>
          <span id="bot-settings-title" className="truncate text-[15px] font-semibold text-ink">
            {bot.name}
          </span>
          <button
            type="button"
            onClick={close}
            aria-label={t("botSettings.simple.close")}
            title={t("botSettings.simple.close")}
            className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"
          >
            <X size={18} className="pointer-events-none" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-6">
          <div className="flex flex-col items-center gap-2">
            <BotAvatar bot={bot} size={112} state={derived.activeState} />
            <TreatCount botId={bot.id} />
          </div>

          <div className="mt-4 flex justify-center">
            <div role="tablist" aria-label={t("botSettings.simple.tabs")} className="inline-flex rounded-full bg-inset p-1">
              {BOT_SECTIONS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  data-simple-tab={entry.id}
                  onClick={() => dispatch({ type: "toggleSettings", open: true, section: entry.section })}
                  className={cn(
                    "rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
                    tab === entry.id ? "bg-raised text-ink shadow-sm" : "text-ink-secondary hover:text-ink",
                  )}
                >
                  {t(entry.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {tab === "details" && (
            <div role="tabpanel" className="mt-5 flex flex-col gap-5">
              <div>
                <span className={groupLabelCls}>{t("botSettings.simple.look")}</span>
                <div className={cardCls}>
                  <div role="radiogroup" aria-label={t("onboarding.bot.breed")} className="grid grid-cols-4 gap-1 p-2">
                    {BREEDS.map((id) => (
                      <button
                        key={id}
                        type="button"
                        role="radio"
                        aria-checked={id === breed}
                        aria-label={MASCOT_BODIES[id].name}
                        title={MASCOT_BODIES[id].name}
                        data-breed={id}
                        onClick={() => patch({ mascotBody: id })}
                        className={cn(
                          "flex h-[76px] items-center justify-center rounded-lg transition-colors duration-150",
                          id === breed ? "bg-raised ring-1 ring-ink/40" : "hover:bg-raised/60",
                        )}
                      >
                        <DogAvatar color={bot.color} bodyId={id} state={id === breed ? "happy" : "idle"} size={56} label={MASCOT_BODIES[id].name} animated={id === breed} />
                      </button>
                    ))}
                  </div>
                  <div role="radiogroup" aria-label={t("onboarding.bot.color")} className={cn(dividedRowCls, "flex flex-wrap justify-between gap-2")}>
                    {DOG_COLOR_NAMES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={c === bot.color}
                        aria-label={t("onboarding.bot.colorAria", { color: c })}
                        title={c}
                        data-color={c}
                        onClick={() => patch({ color: c })}
                        className={cn(
                          "size-7 rounded-full ring-offset-2 ring-offset-card transition-transform duration-150 hover:scale-110 active:scale-95",
                          c === bot.color && "ring-2 ring-ink/70",
                        )}
                        style={{ backgroundColor: DOG_COLORS[c] }}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <span className={groupLabelCls}>{t("botSettings.simple.about")}</span>
                <div className={cardCls}>
                  <div className={rowCls}>
                    <label htmlFor={`simple-bot-name-${bot.id}`} className={rowLabelCls}>{t("botSettings.simple.name")}</label>
                    <input
                      id={`simple-bot-name-${bot.id}`}
                      className={rowInputCls}
                      maxLength={BOT_PROFILE_LIMITS.name}
                      value={bot.name}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                  </div>
                  <div className={dividedRowCls}>
                    <label htmlFor={`simple-bot-label-${bot.id}`} className={rowLabelCls}>{t("botSettings.simple.label")}</label>
                    <input
                      id={`simple-bot-label-${bot.id}`}
                      className={rowInputCls}
                      maxLength={BOT_PROFILE_LIMITS.title}
                      placeholder={t("botSettings.simple.labelPlaceholder")}
                      value={bot.title}
                      onChange={(e) => patch({ title: e.target.value })}
                    />
                  </div>
                  <div className={dividedRowCls}>
                    <SoulField bot={bot} onPatch={patch} />
                  </div>
                </div>
              </div>

              <div>
                <span className={groupLabelCls}>{t("botSettings.simple.runsOn")}</span>
                <div className={cardCls}>
                  {/* The dog's engine, account and model in the same plain-words
                      picker as the chat header, shown in place (a floating
                      popover would be clipped by this scrolling panel). A pick
                      is the dog's model: every thread without its own model
                      moves with it, and the line below counts the ones that don't. */}
                  <div className={rowCls} data-simple-default-model>
                    <ModelPicker bot={bot} contained label={<span className="text-[14px] text-ink">{t("botSettings.simple.runsOn")}</span>} />
                    <ThreadModelsLine bot={bot} className="mt-2" />
                  </div>
                  <div className={dividedRowCls}>
                    <div className="flex items-center justify-between gap-3">
                      <div className={itemTextCls}>
                        <div className="text-[14px] text-ink">{t("botSettings.simple.beforeActs", { name: bot.name })}</div>
                        <div className="text-[12px] text-ink-secondary" data-approval-custom={customMode || undefined}>{approvalHint}</div>
                      </div>
                      <div role="group" aria-label={t("botSettings.simple.beforeActs", { name: bot.name })} className="inline-flex shrink-0 rounded-full bg-inset p-1">
                        {([
                          { mode: "ask", title: t("botSettings.simple.ask"), offered: true },
                          { mode: "auto", title: t("botSettings.simple.decide"), offered: autoOffered },
                        ] as const).map((choice) => {
                          const selected = displayedApprovalMode === choice.mode;
                          return (
                            <button
                              key={choice.mode}
                              type="button"
                              data-approval-choice={choice.mode}
                              aria-pressed={selected}
                              disabled={Boolean(bot.busy) || !choice.offered}
                              onClick={() => chooseMode(choice.mode)}
                              className={cn(
                                "rounded-full px-3 py-1 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                                selected ? "bg-raised text-ink shadow-sm" : "text-ink-secondary enabled:hover:text-ink",
                              )}
                            >
                              {choice.title}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "library" && (
            <div role="tabpanel" className="mt-5 flex flex-col gap-5">
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-3 px-1">
                  <span className="text-[12px] font-medium text-ink-secondary">{t("botSettings.simple.skills")}</span>
                  <button
                    type="button"
                    data-simple-add-skill
                    aria-expanded={teaching}
                    onClick={() => setTeaching((open) => !open)}
                    className={pillCls}
                  >
                    {t("botSettings.simple.addSkill")}
                  </button>
                </div>
                <div className={cardCls}>
                  <p data-simple-tricks-hint className={cn(rowCls, "text-[12px] leading-relaxed text-ink-tertiary")}>{t("skills.tricksHint")}</p>
                  {teaching && (
                    libraryOn ? (
                      <div className={cn(dividedRowCls, "flex items-center gap-2")} data-simple-teach>
                        {skills.libraryPool.length > 0 ? (
                          <>
                            <select
                              aria-label={t("botSettings.simple.teachFromLibrary")}
                              value={skills.addFromLibrary}
                              disabled={Boolean(skills.working)}
                              onChange={(e) => skills.setAddFromLibrary(e.target.value)}
                              className="min-w-0 flex-1 truncate rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink"
                            >
                              <option value="">{t("botSettings.simple.teachFromLibrary")}</option>
                              {skills.libraryPool.map((entry) => (
                                <option key={entry.name} value={entry.name}>{entry.name}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              disabled={!skills.addFromLibrary || Boolean(skills.working)}
                              onClick={() => void skills.addToBot()}
                              className={cn(pillCls, "shrink-0")}
                            >
                              {t("botSettings.simple.teachAdd")}
                            </button>
                          </>
                        ) : (
                          <span className="text-[12px] text-ink-secondary">{t("botSettings.simple.teachAllAssigned")}</span>
                        )}
                      </div>
                    ) : (
                      <form
                        className={cn(dividedRowCls, "flex flex-col gap-2")}
                        data-simple-teach
                        onSubmit={(e) => {
                          e.preventDefault();
                          void importSkill();
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            aria-label={t("botSettings.simple.addSkill")}
                            placeholder={t("botSettings.simple.teachPlaceholder")}
                            value={source}
                            disabled={importing}
                            onChange={(e) => setSource(e.target.value)}
                            className="min-w-0 flex-1 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none"
                          />
                          <button type="submit" disabled={importing || !source.trim()} className={cn(pillCls, "shrink-0")}>
                            {importing ? t("botSettings.simple.teachImporting") : t("botSettings.simple.teachImport")}
                          </button>
                        </div>
                        {importMessage && <div className="text-[12px] text-ink-secondary">{importMessage}</div>}
                      </form>
                    )
                  )}
                  {!skills.loading && skills.skills.length === 0 ? (
                    <div className={cn(dividedRowCls, "text-[12.5px] text-ink-tertiary")}>{t("botSettings.simple.noSkills")}</div>
                  ) : (
                    skills.skills.map((skill) => (
                      <div key={skill.name} className={cn(dividedRowCls, "flex items-center gap-3")}>
                        <div className={itemTextCls}>
                          <div className="truncate text-[13.5px] font-medium text-ink">{skill.name}</div>
                          <div className="truncate text-[12px] text-ink-secondary">{skill.description || skill.source}</div>
                        </div>
                        <Switch
                          checked={skill.enabled}
                          aria-label={t("botSettings.simple.skillToggle", { name: skill.name })}
                          disabled={Boolean(skills.working)}
                          onClick={() => void skills.toggle(skill)}
                        />
                      </div>
                    ))
                  )}
                  {skills.error && !skills.reviewing && (
                    <div role="alert" className={cn(dividedRowCls, "text-[12px] text-danger")}>{skills.error}</div>
                  )}
                </div>
              </div>

              <div>
                <span className={groupLabelCls}>{t("botSettings.simple.files")}</span>
                <div className={cardCls}>
                  {library.length === 0 ? (
                    <div className={cn(rowCls, "text-[13px] leading-relaxed text-ink-secondary")}>
                      {t("botSettings.simple.libraryEmpty", { name: bot.name })}
                    </div>
                  ) : (
                    library.map((item, index) => {
                      const Icon = item.kind === "image" ? ImageIcon : FileText;
                      return (
                        <button
                          key={item.key}
                          type="button"
                          data-library-item={item.messageId}
                          title={t("botSettings.simple.libraryOpen", { name: item.name })}
                          onClick={() => dispatch({ type: "focusMessage", threadId: bot.threadId, messageId: item.messageId })}
                          className={cn(index === 0 ? rowCls : dividedRowCls, "flex w-full items-center gap-3 text-left hover:bg-raised/60")}
                        >
                          <Icon size={16} className="shrink-0 text-ink-secondary" />
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{item.name}</span>
                          <span className="shrink-0 text-[12px] text-ink-tertiary">
                            {new Date(item.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Memory has its own Save button; it stays mounted (hidden on the
              other tabs) so an unsaved draft survives a visit elsewhere, and
              it fetches when it becomes the active tab. */}
          <div hidden={tab !== "library"} className="mt-5">
            <MemorySection bot={bot} active={tab === "library"} onToggle={(enabled) => patch({ memoryEnabled: enabled })} />
          </div>

          {tab === "computer" && (
            <div role="tabpanel" className="mt-5">
              <span className={groupLabelCls}>{t("botSettings.simple.computer")}</span>
              <div className={cn(cardCls, rowCls, "flex items-center justify-between gap-3")} data-testid="access-works-on">
                <div className={cn(itemTextCls, "text-[14px] leading-relaxed text-ink")}>
                  {t("access.worksOn", {
                    name: bot.name,
                    short: placeViewFor(placeFacts({
                      bot,
                      place: bot.computer ?? "auto",
                      seat: placeSeat,
                      config: state.config,
                      instances: state.instances,
                    })).short,
                  })}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    close();
                    dispatch({ type: "toggleComputer", open: true });
                  }}
                  className={cn(pillCls, "shrink-0")}
                >
                  {t("place.action.openComputerPanel")}
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      {skills.reviewing && (
        <SkillReviewDialog
          skill={skills.reviewing.skill}
          text={skills.reviewing.text}
          error={skills.error}
          working={skills.working === skills.reviewing.skill.name}
          onCancel={() => skills.setReviewing(null)}
          onEnable={() => void skills.enableReviewed()}
        />
      )}
      <LocalComputerAutoWarning
        open={localAutoWarning !== null}
        onCancel={() => setLocalAutoWarning(null)}
        onConfirm={() => {
          const target = localAutoWarning;
          setLocalAutoWarning(null);
          if (!target) return;
          dispatch({ type: "updateBot", botId: target, patch: { approvalMode: "auto", acknowledgeLocalAuto: true } });
        }}
      />
    </>
  );
}
