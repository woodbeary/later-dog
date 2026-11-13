import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { useMenuMotion } from "./MenuMotion";

export interface Choice<T extends string> {
  value: T;
  label: string;
}

export function ChoiceMenu<T extends string>({ label, value, choices, onChange, className }: {
  label: string;
  value: T;
  choices: readonly Choice<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = choices.find((choice) => choice.value === value) ?? choices[0];
  const items = () => [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])];
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  usePopoverDismiss(open, rootRef, () => close(false));
  const focusChecked = (menu: HTMLDivElement | null) => {
    if (!menu || menu.contains(document.activeElement)) return;
    (menu.querySelector<HTMLButtonElement>('[aria-checked="true"]') ?? menu.querySelector<HTMLButtonElement>('[role="menuitemradio"]'))?.focus();
  };
  const onMenuKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (index: number) => list[(index + list.length) % list.length]?.focus();
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") { event.preventDefault(); move(at + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); move(at - 1); }
    else if (event.key === "Home") { event.preventDefault(); move(0); }
    else if (event.key === "End") { event.preventDefault(); move(list.length - 1); }
    else if (event.key === "Tab") close(false);
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLowerCase();
      const after = [...list.slice(at + 1), ...list.slice(0, at + 1)];
      after.find((item) => item.textContent?.trim().toLowerCase().startsWith(letter))?.focus();
    }
  };
  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`${label}: ${current?.label ?? ""}`}
        onClick={() => setOpen((shown) => !shown)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          setOpen(true);
        }}
        className={cn("flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] text-ink hover:bg-raised/50", open && "bg-raised/50")}
      >
        {current?.label}
        <ChevronDown size={12} aria-hidden="true" className="text-ink-tertiary" />
      </button>
      {motion.shown && (
        <div
          ref={(menu) => { menuRef.current = menu; if (open) focusChecked(menu); }}
          id={menuId}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKey}
          {...motion.exitProps}
          className={cn("absolute left-0 top-full z-40 mt-1 w-48 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/50", motion.className)}
        >
          {choices.map((choice) => (
            <button
              key={choice.value}
              type="button"
              role="menuitemradio"
              aria-checked={choice.value === value}
              tabIndex={-1}
              onClick={() => { onChange(choice.value); close(); }}
              className={cn("flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink focus-visible:outline-none focus-visible:bg-raised", choice.value === value ? "bg-raised" : "hover:bg-raised/70")}
            >
              <span className="flex-1 truncate">{choice.label}</span>
              {choice.value === value && <Check size={14} aria-hidden="true" className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
