import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { FileText, Image as ImageIcon, X } from "lucide-react";

import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { skillsLibraryEnabled } from "@/lib/feature-flags";
import { DOG_COLOR_NAMES, DOG_COLORS } from "@/lib/mascot";
import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { DEFAULT_MASCOT_BODY, MASCOT_BODIES, MASCOT_BODY_IDS } from "../../shared/mascot-bodies";
import { DogAvatar } from "./Avatar";
import { isDogBreed } from "./DogAvatar";
import { useCaptionChrome } from "./DesktopCapabilities";
import { ModelPicker } from "./ModelPicker";
import { Switch } from "./SettingsPrimitives";
import { SoulField } from "./SoulField";
import { useBotEditor } from "./bot-settings/BotEditorContext";
import { botLibraryItems } from "./bot-settings/library";
import { SimpleMemory } from "./bot-settings/SimpleMemory";
import { ComputerTab } from "./bot-settings/ComputerTab";
import { DogShareButton } from "./bot-settings/DogShare";
import { ProfileAvatar } from "./bot-settings/ProfileAvatar";
import { RoutinesCard } from "./bot-settings/RoutinesCard";
import { TEACH_TRICK_LINE } from "../../shared/learn-request";
import { BOT_SECTIONS, tabForSection } from "./bot-settings/sections";
import { SkillReviewDialog, useManagedSkills } from "./bot-settings/SkillsSection";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";

const BREEDS = MASCOT_BODY_IDS.filter((id) => isDogBreed(id));

const groupLabelCls = "mb-1.5 block px-1 text-[12px] font-medium text-ink-secondary";
const cardCls = "rounded-xl bg-card";
const rowCls = "px-4 py-3";
const dividedRowCls = "border-t border-hairline/40 px-4 py-3";
const profileInputCls = "w-full max-w-[18rem] rounded-lg bg-transparent px-2 py-0.5 text-center placeholder:text-ink-tertiary transition-colors hover:bg-control/60 focus:bg-inset focus:outline-none focus-visible:ring-1 focus-visible:ring-focus motion-reduce:transition-none";
const pillCls = "rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-control-hover disabled:opacity-45";
const itemTextCls = "min-w-0 flex-1";

export function looksLikeSkillSource(text: string): boolean {
  return /^(https?:\/\/|github\.com\/|github:)\S+$/i.test(text) || /^[\w.-]+\/[\w.-]+(?:\/\S*)?$/.test(text);
}

export function BotSettingsDialog({ bot, overlay = false }: {
  bot: Bot;
  overlay?: boolean;
}) {
  const { state, dispatch } = useStore();
  const { request: api } = useBotEditor();
  const derived = useBotSettingsDerived(bot);
  const { patch } = derived;
  const dialogRef = useRef<HTMLElement | null>(null);
  const { padClass } = useCaptionChrome();
  const tab = state.botSettingsExpandAccordion ? tabForSection(state.botSettingsSection) : "details";
  const memoryPage = tab === "library" && state.botSettingsSection === "memory";
  const skills = useManagedSkills(bot);
  const libraryOn = skillsLibraryEnabled(state.config);
  const [teaching, setTeaching] = useState(false);
  const [source, setSource] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState("");
  const teachButton = useRef<HTMLButtonElement | null>(null);

  const stopTeaching = () => {
    setTeaching(false);
    setSource("");
    setImportMessage("");
  };
  const escapeTeaching = (event: ReactKeyboardEvent) => {
    if (event.key !== "Escape" || !teaching || importing) return;
    event.preventDefault();
    event.stopPropagation();
    stopTeaching();
    teachButton.current?.focus();
  };

  const importSkill = async () => {
    const trimmed = source.trim();
    if (!trimmed || importing) return;
    if (!looksLikeSkillSource(trimmed)) {
      dispatch({ type: "send", botId: bot.id, threadId: bot.threadId, text: `${TEACH_TRICK_LINE} ${trimmed}` });
      setSource("");
      setTeaching(false);
      dispatch({ type: "toggleSettings", open: false });
      return;
    }
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
      const nested = dialog?.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
      if (nested && nested.getClientRects().length > 0) return;
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
  return (
    <>
      <aside
        ref={dialogRef}
        role="dialog"
        aria-labelledby="bot-settings-title"
        tabIndex={-1}
        className={cn(
          "animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel outline-none focus-visible:outline-none",
          overlay
            ? "md:inset-auto md:right-0 md:top-0 md:bottom-0 md:w-[min(420px,42vw)] md:shadow-2xl"
            : "md:static md:z-auto md:w-[min(420px,42vw)] md:shrink-0",
        )}
      >
        <div className={cn("flex shrink-0 items-center justify-end gap-1 px-4 py-3", padClass)}>
          <span id="bot-settings-title" className="sr-only">
            {bot.name}
          </span>
          <DogShareButton bot={bot} />
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
          <div data-profile-header className="flex flex-col items-center">
            <ProfileAvatar bot={bot} state={derived.activeState} onPatch={patch} />
            <label htmlFor={`simple-bot-name-${bot.id}`} className="sr-only">{t("botSettings.simple.name")}</label>
            <input
              id={`simple-bot-name-${bot.id}`}
              data-profile-name
              className={cn(profileInputCls, "mt-3 text-[20px] font-semibold text-ink")}
              maxLength={BOT_PROFILE_LIMITS.name}
              placeholder={t("botSettings.simple.name")}
              value={bot.name}
              onChange={(e) => patch({ name: e.target.value })}
            />
            <label htmlFor={`simple-bot-label-${bot.id}`} className="sr-only">{t("botSettings.simple.label")}</label>
            <input
              id={`simple-bot-label-${bot.id}`}
              data-profile-label
              className={cn(profileInputCls, "text-[13px] text-ink-secondary")}
              maxLength={BOT_PROFILE_LIMITS.title}
              placeholder={t("botSettings.simple.label")}
              value={bot.title}
              onChange={(e) => patch({ title: e.target.value })}
            />
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
                <span className={groupLabelCls}>{t("botSettings.simple.routines")}</span>
                <RoutinesCard bot={bot} />
              </div>
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
                    <SoulField bot={bot} onPatch={patch} />
                  </div>
                </div>
              </div>

              <div>
                <span className={groupLabelCls}>{t("botSettings.simple.runsOn")}</span>
                <div className={cardCls}>
                  <div className={rowCls} data-simple-default-model>
                    <ModelPicker bot={bot} contained label={<span className="text-[14px] text-ink">{t("botSettings.simple.runsOn")}</span>} />
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === "library" && !memoryPage && (
            <div role="tabpanel" className="mt-5 flex flex-col gap-5">
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-3 px-1">
                  <span className="text-[12px] font-medium text-ink-secondary">{t("botSettings.simple.skills")}</span>
                  <button
                    ref={teachButton}
                    type="button"
                    data-simple-add-skill
                    aria-expanded={teaching}
                    disabled={importing}
                    onKeyDown={escapeTeaching}
                    onClick={() => (teaching ? stopTeaching() : setTeaching(true))}
                    className={pillCls}
                  >
                    {!teaching ? t("botSettings.simple.addSkill") : importMessage ? t("botSettings.simple.teachDone") : t("common.cancel")}
                  </button>
                </div>
                <div className={cardCls}>
                  {teaching && (
                    libraryOn ? (
                      <div className={cn(rowCls, "flex items-center gap-2")} data-simple-teach onKeyDown={escapeTeaching}>
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
                        className={cn(rowCls, "flex flex-col gap-2")}
                        data-simple-teach
                        onKeyDown={escapeTeaching}
                        onSubmit={(e) => {
                          e.preventDefault();
                          void importSkill();
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            autoFocus
                            aria-label={t("botSettings.simple.addSkill")}
                            placeholder={t("botSettings.simple.teachPlaceholder", { name: bot.name })}
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
                    <div className={cn(teaching ? dividedRowCls : rowCls, "text-[12.5px] text-ink-tertiary")}>{t("botSettings.simple.noSkills")}</div>
                  ) : (
                    skills.skills.map((skill, index) => (
                      <div key={skill.name} className={cn(index === 0 && !teaching ? rowCls : dividedRowCls, "flex items-center gap-3")}>
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

              {library.length > 0 && (
              <div>
                <span className={groupLabelCls}>{t("botSettings.simple.files")}</span>
                <div className={cardCls}>
                  {library.map((item, index) => {
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
                    })}
                </div>
              </div>
              )}
            </div>
          )}

          <div hidden={tab !== "library"} className="mt-5">
            <SimpleMemory
              bot={bot}
              active={tab === "library"}
              page={memoryPage}
              onPage={(open) => dispatch({ type: "toggleSettings", open: true, section: open ? "memory" : "skills" })}
              onToggle={(enabled) => patch({ memoryEnabled: enabled })}
            />
          </div>

          {tab === "computer" && <ComputerTab bot={bot} />}

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
    </>
  );
}
