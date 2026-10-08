// The exit beat: the first dog gets a breed, a color and a name. The breeds are drawn in the chosen color, so the
// picker is the preview: the selected dog shows once, in its tile, never again beside the form. Everything is optional
// with a sensible default, and Start chatting always works, even when the save fails (the dog can be changed later
// from its profile). What the dog is for is not asked here: the person tells the dog in chat.
import { useEffect, useState } from "react";
import { DogAvatar } from "@/components/Avatar";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { DOG_COLOR_NAMES, DOG_COLORS, type DogColor } from "@/lib/mascot";
import { api, type Bot } from "@/state/store";
import { DEFAULT_MASCOT_BODY, MASCOT_BODIES, MASCOT_BODY_IDS, type MascotBodyId } from "../../../../shared/mascot-bodies";
import { isDogBreed } from "@/components/DogAvatar";
import { inputClass, PrimaryButton, QuietButton, staggerIndex, type BeatProps } from "./shared";

const BREEDS = MASCOT_BODY_IDS.filter((id) => isDogBreed(id));

export function MeetYourBotBeat({
  bot,
  onFinish,
  setMascot,
  bump,
}: Pick<BeatProps, "setMascot" | "bump"> & {
  bot: Bot | null;
  onFinish: () => void;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [color, setColor] = useState<DogColor>(bot?.color ?? "green");
  const [breed, setBreed] = useState<MascotBodyId>(bot?.mascotBody && isDogBreed(bot.mascotBody) ? bot.mascotBody : DEFAULT_MASCOT_BODY);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setMascot("celebrate");
    bump("celebrate");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The dog speaks first: its chat greets the person and, when its engine can answer, asks what to start on.
  const sayHello = (id: string) => void api(`/api/bots/${encodeURIComponent(id)}/hello`, { method: "POST", body: "{}" }).catch(() => {});

  const save = async () => {
    if (!bot) {
      onFinish();
      return;
    }
    const patch: Record<string, unknown> = {};
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== bot.name) patch.name = trimmedName;
    if (color !== bot.color) patch.color = color;
    if (breed !== (bot.mascotBody ?? DEFAULT_MASCOT_BODY)) patch.mascotBody = breed;
    if (!Object.keys(patch).length) {
      sayHello(bot.id);
      onFinish();
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      await api(`/api/bots/${encodeURIComponent(bot.id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      sayHello(bot.id);
      onFinish();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stagger flex flex-col">
      <p className="animate-rise mt-1 text-[14px] leading-relaxed text-ink-secondary" style={staggerIndex(0)}>
        {t("onboarding.bot.intro")}
      </p>

      <div role="radiogroup" aria-label={t("onboarding.bot.breed")} className="animate-rise mt-4 grid grid-cols-4 gap-2" style={staggerIndex(1)}>
        {BREEDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === breed}
            aria-label={MASCOT_BODIES[id].name}
            title={MASCOT_BODIES[id].name}
            onClick={() => {
              setBreed(id);
              bump("customize");
            }}
            className={cn(
              "flex h-[84px] items-center justify-center rounded-xl border transition-colors duration-150",
              id === breed ? "border-ink/70 bg-raised" : "border-transparent hover:bg-raised/60",
            )}
          >
            <DogAvatar color={color} bodyId={id} state={id === breed ? "happy" : "idle"} size={64} label={MASCOT_BODIES[id].name} animated={id === breed} />
          </button>
        ))}
      </div>

      <div role="radiogroup" aria-label={t("onboarding.bot.color")} className="animate-rise mt-4 flex flex-wrap justify-between gap-2" style={staggerIndex(2)}>
        {DOG_COLOR_NAMES.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === color}
            aria-label={t("onboarding.bot.colorAria", { color: c })}
            title={c}
            onClick={() => {
              setColor(c);
              bump("customize");
            }}
            className={cn(
              "size-7 rounded-full ring-offset-2 ring-offset-panel transition-transform duration-150 hover:scale-110 active:scale-95",
              c === color && "ring-2 ring-ink/70",
            )}
            style={{ backgroundColor: DOG_COLORS[c] }}
          />
        ))}
      </div>

      <input
        id="welcome-bot-name"
        autoFocus
        type="text"
        aria-label={t("onboarding.bot.name")}
        value={name}
        maxLength={100}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void save()}
        placeholder={t("onboarding.bot.name")}
        className={`animate-rise mt-5 ${inputClass}`}
        style={staggerIndex(3)}
      />

      {failed && (
        <p className="animate-rise mt-3 text-[13px] text-danger" role="alert">
          {t("onboarding.bot.error")}
        </p>
      )}

      <PrimaryButton onClick={() => void save()} disabled={saving} className="animate-rise mt-4" style={staggerIndex(4)}>
        {saving ? t("onboarding.bot.saving") : t("onboarding.bot.finish")}
      </PrimaryButton>
      {failed && (
        <QuietButton onClick={onFinish} className="mt-3 self-center">
          {t("onboarding.bot.finishAnyway")}
        </QuietButton>
      )}
    </div>
  );
}
