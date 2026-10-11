import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Clock, Square, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import type { SendDelivery } from "../../shared/send-delivery";
import { navigateThreadMenu } from "./BotProjects";
import { useMenuMotion } from "./MenuMotion";
import { ShortcutHint } from "./ShortcutHint";

export interface SendChoice {
  delivery: SendDelivery;
  Icon: LucideIcon;
  label: string;
  hint: string;
}

export function sendChoices(name: string, canSteer: boolean): SendChoice[] {
  const steer: SendChoice = { delivery: "steer", Icon: ArrowUp, label: t("composer.sendChoice.steer"), hint: t("composer.sendChoice.steerHint", { name }) };
  return [
    ...(canSteer ? [steer] : []),
    { delivery: "queue", Icon: Clock, label: t("composer.sendChoice.queue"), hint: t("composer.sendChoice.queueHint", { name }) },
    { delivery: "stop", Icon: Square, label: t("composer.sendChoice.stop"), hint: t("composer.sendChoice.stopHint", { name }) },
  ];
}

export function enterDelivery(canSteer: boolean): SendDelivery {
  return canSteer ? "steer" : "queue";
}

export function SendChoiceMenu({ name, canSteer, disabled = false, onChoose }: {
  name: string;
  canSteer: boolean;
  disabled?: boolean;
  onChoose: (delivery: SendDelivery) => void;
}) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const onEnter = enterDelivery(canSteer);

  usePopoverDismiss(open, rootRef, () => setOpen(false));

  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("[aria-keyshortcuts]")?.focus();
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("composer.sendChoice.open")}
        title={t("composer.sendChoice.open")}
        className="flex h-8 w-6 shrink-0 items-center justify-center rounded-full text-ink-secondary transition-colors hover:bg-raised hover:text-ink disabled:opacity-40"
      >
        <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
      </button>
      {motion.shown && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={t("composer.sendChoice.menu", { name })}
          {...motion.exitProps}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              setOpen(false);
              triggerRef.current?.focus();
            } else if (event.key === "Tab") setOpen(false);
            else navigateThreadMenu(event);
          }}
          className={cn(
            "absolute bottom-full right-0 z-30 mb-1.5 w-[290px] max-w-[calc(100vw-2rem)] rounded-xl border border-hairline bg-panel p-1.5 text-left shadow-2xl",
            motion.className,
          )}
        >
          {sendChoices(name, canSteer).map(({ delivery, Icon, label, hint }) => (
            <button
              key={delivery}
              type="button"
              role="menuitem"
              data-delivery={delivery}
              aria-keyshortcuts={delivery === onEnter ? "Enter" : undefined}
              onClick={() => {
                setOpen(false);
                onChoose(delivery);
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-raised focus-visible:bg-raised"
            >
              <Icon size={15} aria-hidden="true" className={cn("mt-0.5 shrink-0 text-ink-secondary", delivery === "stop" && "fill-current")} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-ink">{label}</span>
                <span className="mt-0.5 block text-[11.5px] leading-[1.4] text-ink-secondary">{hint}</span>
              </span>
              {delivery === onEnter && <ShortcutHint id="send-message" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
