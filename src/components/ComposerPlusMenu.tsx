import { Check, Paperclip, Plug, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { approvalModeOptions, approvalModeOptionsFor, approvalModeSelectionRequiresLocalDesktop } from "./ApprovalModeSelector";
import { useMenuMotion } from "./MenuMotion";

export interface PlusMenuPermissions {
  approvalMode?: ApprovalMode;
  autoApprove?: boolean;
  driverKind: string;
  trustedModesAvailable: boolean;
  disabled: boolean;
  onSelect: (mode: ApprovalMode) => void;
}

export function ComposerPlusMenu({ onAttach, permissions, onConnectors }: {
  onAttach: () => void;
  permissions?: PlusMenuPermissions | null;
  onConnectors?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const motion = useMenuMotion(open);
  const wrapperRef = useRef<HTMLDivElement>(null);

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

  const savedMode = permissions ? approvalModeFor({ approvalMode: permissions.approvalMode, autoApprove: permissions.autoApprove }) : undefined;
  const mode = permissions?.driverKind === "antigravityAgent" && savedMode === "auto" ? "ask" : savedMode;
  const options = permissions ? approvalModeOptionsFor(permissions.driverKind, permissions.trustedModesAvailable)
    .filter((option) => option.mode === "ask" || option.mode === "auto" || option.mode === mode) : [];
  const shown = options.length > 0 ? options : permissions ? approvalModeOptions().filter((option) => option.mode === mode) : [];
  const locked = permissions ? permissions.disabled || approvalModeSelectionRequiresLocalDesktop(mode ?? "ask", permissions.trustedModesAvailable) : true;
  const row = "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] text-ink hover:bg-raised-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:opacity-45 disabled:hover:bg-transparent";

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        data-composer-plus
        onClick={() => setOpen((was) => !was)}
        aria-label={t("composer.plus")}
        title={t("composer.plus")}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-control hover:text-ink", open && "bg-control text-ink")}
      >
        <Plus size={18} className={cn("transition-transform", open && "rotate-45")} />
      </button>
      {motion.shown && (
        <div
          role="menu"
          data-composer-plus-menu
          {...motion.exitProps}
          className={cn("absolute bottom-full left-0 z-30 mb-2 w-60 rounded-menu origin-bottom-left border border-hairline/50 bg-card p-1 shadow-popover", motion.className)}
        >
          <button type="button" role="menuitem" className={row} onClick={() => { setOpen(false); onAttach(); }}>
            <Paperclip size={16} className="shrink-0 text-ink-secondary" />
            {t("composer.attach")}
          </button>
          {onConnectors && (
            <button type="button" role="menuitem" className={row} onClick={() => { setOpen(false); onConnectors(); }}>
              <Plug size={16} className="shrink-0 text-ink-secondary" />
              {t("composer.connectors")}
            </button>
          )}
          {permissions && shown.length > 0 && (
            <div role="group" aria-label={t("composer.permissions")} className="mt-1 border-t border-hairline/40 pt-1">
              <div className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium text-ink-tertiary">{t("composer.permissions")}</div>
              {shown.map(({ mode: option, label, description, Icon }) => (
                <button
                  key={option}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option === mode}
                  title={description}
                  disabled={locked}
                  data-plus-permission={option}
                  className={row}
                  onClick={() => {
                    setOpen(false);
                    if (option !== mode) permissions.onSelect(option);
                  }}
                >
                  <Icon size={16} className="shrink-0 text-ink-secondary" />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {option === mode && <Check size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
