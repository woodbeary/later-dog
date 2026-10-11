import { useEffect, useState } from "react";

import { BOT_PROFILE_LIMITS } from "../../shared/bot-profile";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { soulPatchFor, utf8Bytes } from "@/lib/soul";
import { useStore, type Bot } from "@/state/store";
import { useBotEditor } from "./bot-settings/BotEditorContext";

type SoulRead = { soul: string; revision: string; bytes: number; limit: number; file: string; drift: boolean; fileText?: string };

export function SoulField({ bot, onPatch }: { bot: Bot; onPatch: (patch: { soul?: string }) => void }) {
  const { dispatch, flushBotPatches } = useStore();
  const { request: api } = useBotEditor();
  const limit = BOT_PROFILE_LIMITS.soul;
  const [draft, setDraft] = useState(bot.soul ?? "");
  const [info, setInfo] = useState<SoulRead | null>(null);
  const [resolving, setResolving] = useState(false);

  // A new bot, or a server-side change (drift resolved, another client),
  // replaces the draft. While the user types, the draft leads.
  useEffect(() => {
    setDraft(bot.soul ?? "");
  }, [bot.id, bot.soul]);

  const refresh = () => {
    return flushBotPatches(bot.id)
      .then(() => api(`/api/bots/${bot.id}/soul`))
      .then((read: SoulRead) => setInfo(read))
      .catch(() => setInfo(null));
  };
  useEffect(() => { void refresh(); }, [bot.id, bot.soulDrift, flushBotPatches]);

  const bytes = utf8Bytes(draft);
  const over = bytes > limit;
  const change = (value: string) => {
    setDraft(value);
    const patch = soulPatchFor(value, limit);
    if (patch) onPatch(patch);
  };
  const resolve = async (action: "apply-file" | "discard-file") => {
    if (resolving || !info?.revision || typeof info.fileText !== "string") return;
    setResolving(true);
    try {
      await flushBotPatches(bot.id);
      await api(`/api/bots/${bot.id}/soul/${action}`, {
        method: "POST",
        body: JSON.stringify({ fileText: info.fileText, expectedRevision: info.revision }),
      });
    } catch (error: unknown) {
      dispatch({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      await refresh();
      setResolving(false);
    }
  };

  return (
    <div>
      <label htmlFor={`bot-soul-${bot.id}`} className="block text-[12px] text-ink-secondary">
        {t("botSettings.simple.instructions")}
      </label>
      {info?.drift && (
        <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-ink">
          <div className="font-medium">{t("botSettings.soul.drift")}</div>
          <div className="mt-1 break-all text-ink-secondary">{t("botSettings.soul.driftHint", { name: bot.name, file: info.file })}</div>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-control p-2 text-[11.5px]">{info.fileText}</pre>
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={resolving} onClick={() => void resolve("apply-file")} className="rounded-full bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:brightness-110 disabled:opacity-45">
              {t("botSettings.soul.useFile")}
            </button>
            <button type="button" disabled={resolving} onClick={() => void resolve("discard-file")} className="rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-raised-hover disabled:opacity-45">
              {t("botSettings.soul.keepSaved")}
            </button>
          </div>
        </div>
      )}
      <textarea
        id={`bot-soul-${bot.id}`}
        className={cn(
          "mt-1 min-h-[120px] w-full resize-y bg-transparent text-[14px] leading-relaxed text-ink placeholder:text-ink-tertiary focus:outline-none",
          over && "rounded-md ring-2 ring-red-500/60",
        )}
        placeholder={t("botSettings.simple.instructionsPlaceholder", { name: bot.name })}
        aria-invalid={over || undefined}
        disabled={resolving}
        value={draft}
        onChange={(e) => change(e.target.value)}
      />
      {over && (
        <div className="mt-1 text-[11px] font-medium tabular-nums text-red-500">
          {t("botSettings.soul.overLimit", { bytes: bytes.toLocaleString(), limit: limit.toLocaleString() })}
        </div>
      )}
    </div>
  );
}
