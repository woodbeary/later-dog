import { useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";

export const messageActionClass =
  "rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-secondary";

export function MessageActions({
  side,
  forceOpen = false,
  more = [],
  className,
  children,
}: {
  side: "user" | "bot";
  forceOpen?: boolean;
  more?: SidebarMenuItem[];
  className?: string;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const open = forceOpen || menuOpen;
  return (
    <div
      className={cn(
        "flex items-center gap-0.5 self-end pb-0.5 transition-opacity",
        side === "user" && "flex-row-reverse",
        open ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
        className,
      )}
      data-testid="message-actions"
      data-open={open ? "true" : undefined}
    >
      {children}
      {more.length > 0 && (
        <SidebarPopoverMenu
          items={more}
          ariaLabel={t("chat.messageActions")}
          placement="auto"
          align={side === "user" ? "start" : "end"}
          onOpenChange={setMenuOpen}
          renderTrigger={({ open: shown }) => (
            <span title={t("chat.messageActions")} className={cn(messageActionClass, "flex", shown && "bg-raised text-ink")}>
              <Ellipsis size={14} aria-hidden="true" />
            </span>
          )}
        />
      )}
    </div>
  );
}
