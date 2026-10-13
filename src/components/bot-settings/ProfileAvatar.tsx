import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ImageUp, Loader2, PawPrint, Pencil, Sparkles } from "lucide-react";

import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { imageAttachmentFromFile } from "@/lib/composer-attachments";
import type { DogState } from "@/lib/mascot";
import { AVATAR_FOCUS_CENTER, AVATAR_ZOOM_MIN, botAvatarUrlFromStoredPath } from "../../../shared/bot-avatar";
import { BotAvatar } from "../Avatar";
import { useBotEditor } from "./BotEditorContext";
import type { BotPatch } from "./useBotSettingsDerived";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const PROMPT_MAX = 400;
const ITEMS = '[role^="menuitem"]:not([disabled])';
const FRESH_FRAME = { avatarZoom: AVATAR_ZOOM_MIN, avatarFocusX: AVATAR_FOCUS_CENTER, avatarFocusY: AVATAR_FOCUS_CENTER };

type Menu = "closed" | "menu" | "generate";

function MenuItem({ id, icon: Icon, label, hint, checked, disabled, onSelect }: {
  id: string;
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean | "true" }>;
  label: string;
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      disabled={disabled}
      data-avatar-option={id}
      onClick={onSelect}
      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink transition-colors hover:bg-raised-hover focus-visible:bg-raised-hover focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
    >
      <Icon size={15} className="shrink-0 text-ink-secondary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block text-[11.5px] leading-snug text-ink-tertiary">{hint}</span>}
      </span>
      {checked && <Check size={14} className="shrink-0 text-ink-secondary" aria-hidden="true" />}
    </button>
  );
}

export function ProfileAvatar({ bot, state, onPatch }: { bot: Bot; state: DogState; onPatch: (patch: BotPatch) => void }) {
  const { state: app, flushBotPatches } = useStore();
  const { request, uploadAvatar } = useBotEditor();
  const [menu, setMenu] = useState<Menu>("closed");
  const [prompt, setPrompt] = useState("");
  const [working, setWorking] = useState<"upload" | "generate" | null>(null);
  const [error, setError] = useState("");
  const wrap = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  const canGenerate = app.config?.imageGen?.configured === true;
  const usesDog = !bot.avatarUrl || bot.avatarCrop === "mascot";
  const crop = bot.avatarCrop && bot.avatarCrop !== "mascot" ? bot.avatarCrop : "circle";
  const label = t("botSettings.avatar.edit", { name: bot.name });

  useEffect(() => {
    if (menu === "closed") return;
    const onDown = (event: PointerEvent) => {
      if (wrap.current && event.target instanceof Node && wrap.current.contains(event.target)) return;
      setMenu("closed");
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  useEffect(() => {
    if (menu === "menu") wrap.current?.querySelector<HTMLElement>(ITEMS)?.focus();
  }, [menu]);

  const close = () => {
    setMenu("closed");
    trigger.current?.focus();
  };

  const onMenuKey = (event: ReactKeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (menu !== "menu" || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    if (items.length === 0) return;
    const down = event.key === "ArrowDown";
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (down ? 0 : items.length - 1) : (at + (down ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };

  const useDog = () => {
    close();
    setError("");
    if (!usesDog) onPatch({ avatarUrl: null, avatarCrop: "mascot", ...FRESH_FRAME });
  };

  const pick = () => {
    close();
    setError("");
    file.current?.click();
  };

  const upload = async (picked: File | undefined) => {
    if (file.current) file.current.value = "";
    if (!picked) return;
    setWorking("upload");
    setError("");
    try {
      const saved = uploadAvatar ? null : await imageAttachmentFromFile(picked);
      const avatarUrl = uploadAvatar ? await uploadAvatar(picked) : saved ? botAvatarUrlFromStoredPath(saved.path) : null;
      if (!avatarUrl) throw new Error(t("botSettings.avatar.wrongType"));
      onPatch({ avatarUrl, avatarCrop: crop, ...FRESH_FRAME });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  const generate = async () => {
    close();
    setWorking("generate");
    setError("");
    try {
      await flushBotPatches(bot.id);
      const result = await request<{ avatarUrl: string; bot: Pick<Bot, "avatarCrop"> }>(`/api/bots/${bot.id}/avatar/generate`, {
        method: "POST",
        body: JSON.stringify({ prompt: prompt.trim() }),
        timeoutMs: 150_000,
      });
      onPatch({ avatarUrl: result.avatarUrl, avatarCrop: result.bot.avatarCrop ?? "circle", ...FRESH_FRAME });
      setPrompt("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(null);
    }
  };

  return (
    <div ref={wrap} className="flex flex-col items-center">
      <div className="relative">
        <button
          ref={trigger}
          type="button"
          data-avatar-edit
          aria-haspopup="menu"
          aria-expanded={menu !== "closed"}
          aria-label={label}
          title={label}
          aria-busy={working !== null}
          onClick={() => {
            if (!working) setMenu((current) => (current === "closed" ? "menu" : "closed"));
          }}
          className="group relative block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-panel aria-busy:cursor-wait"
        >
          <BotAvatar bot={bot} size={96} state={state} />
          <span
            aria-hidden="true"
            className={cn(
              "absolute bottom-0.5 right-0.5 flex size-7 items-center justify-center rounded-full bg-raised text-ink shadow-md ring-1 ring-hairline/40 transition-opacity duration-150 motion-reduce:transition-none",
              working || menu !== "closed" ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
            )}
          >
            {working ? <Loader2 size={14} className="animate-spin" /> : <Pencil size={13} />}
          </span>
        </button>
        {menu !== "closed" && (
          <div
            data-avatar-menu={menu}
            onKeyDown={onMenuKey}
            className="absolute left-1/2 top-full z-30 mt-2 w-60 -translate-x-1/2 rounded-xl bg-raised p-1 shadow-xl ring-1 ring-hairline/40"
          >
            {menu === "menu" ? (
              <div role="menu" aria-label={label}>
                <MenuItem id="dog" icon={PawPrint} label={t("botSettings.avatar.dog")} checked={usesDog} onSelect={useDog} />
                <MenuItem
                  id="generate"
                  icon={Sparkles}
                  label={t("botSettings.avatar.generate")}
                  hint={canGenerate ? undefined : t("botSettings.avatar.generateOff")}
                  disabled={!canGenerate}
                  onSelect={() => setMenu("generate")}
                />
                <MenuItem id="upload" icon={ImageUp} label={t("botSettings.avatar.upload")} onSelect={pick} />
              </div>
            ) : (
              <form
                data-avatar-generate
                className="flex flex-col gap-2 p-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void generate();
                }}
              >
                <input
                  autoFocus
                  aria-label={t("botSettings.avatar.describe")}
                  placeholder={t("botSettings.avatar.describe")}
                  maxLength={PROMPT_MAX}
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  className="w-full rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink placeholder:text-ink-tertiary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                />
                <button
                  type="submit"
                  className="self-end rounded-full bg-control px-3 py-1.5 text-[13px] font-medium text-ink transition-colors hover:bg-raised-hover"
                >
                  {t("botSettings.avatar.generate")}
                </button>
              </form>
            )}
          </div>
        )}
      </div>
      <input
        ref={file}
        type="file"
        accept={ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        data-avatar-file
        className="sr-only"
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      {working === "generate" && (
        <span role="status" className="mt-1.5 text-[12px] text-ink-secondary">{t("botSettings.avatar.generating")}</span>
      )}
      {error && <span role="alert" className="mt-1.5 max-w-[18rem] text-center text-[12px] text-danger">{error}</span>}
    </div>
  );
}
