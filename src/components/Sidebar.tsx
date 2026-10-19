import { cloudWakeupOf, wakeupLine } from "@/lib/cloud-tasks";
import { track } from "@/lib/analytics";
import { OrganizationIdentity } from "./OrganizationIdentity";
import { approvalAction, approvalCardOutcome } from "./ApprovalCard";
import { pendingApprovals } from "./PendingApproval";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Dispatch } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  Bell,
  BellDot,
  Bot as BotIcon,
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Eye,
  EyeOff,
  FolderMinus,
  FolderPlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  PanelLeftOpen,
  Phone,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { api, useStore, formatTime, visibleMessages, openNotificationTarget, currentTaskBot, type Action, type AppState, type Bot, type Group, type InstanceInfo, type Message } from "@/state/store";
import { avatarCropRadius, botAvatarProfile } from "../../shared/bot-avatar";
import { peerLine } from "@/lib/peer-message";

import { BotAvatar } from "./Avatar";
import { stateForBot } from "@/lib/mascot";
import { cn } from "@/lib/cn";
import { PaneErrorLine } from "./PaneErrorLine";
import { useHeldMenuMotion, useMenuMotion } from "./MenuMotion";
import { UpdatePill } from "./UpdateButton";
import { lastNonReceipt } from "@/lib/receipts";
import { activityPreview, botEngine } from "@/lib/failed-turn";
import { activeLocale, t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { WorkingDots } from "./WorkingIndicator";
import { currentDogName } from "@/lib/dog-refs";
import { nextRename } from "@/lib/rename";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { AddDogSheet, droppedDogFile, type AddDogResult, type AddDogSource } from "./AddDogSheet";
import { SectionRenameDialog } from "./SectionRenameDialog";
import { RenameTitle } from "./RenameTitle";
import { BotPickerList } from "./BotPickerList";
import { MainDogBadge } from "./MainDogBadge";
import { MainDogPicker } from "./MainDogPicker";
import { navigateMenu } from "@/lib/menu-keys";
import {
  loadCollapsedSections,
  loadPinOrder,
  loadSidebarWidth,
  clampSidebarWidth,
  saveCollapsedSections,
  savePinOrder,
  saveSidebarWidth,
  setSidebarDensity,
  toggleCollapsedSection,
  useSidebarDensity,
  type SidebarDensity,
} from "@/lib/sidebar-preferences";
import {
  HIDDEN_SECTION_ID,
  UNASSIGNED_SECTION_ID,
  moveSection,
  orderPinnedBots,
  partitionSidebarBots,
  partitionSidebarGroups,
  placeSection,
  sidebarConnectorPreview,
  sidebarLayoutInteractive,
  sidebarSectionCollapsed,
  sidebarSectionNames,
  userSectionId,
  userSectionName,
  type SectionDropPlace,
} from "@/lib/sidebar-layout";
import { publishSidebarOrder } from "@/lib/sidebar-order";
import { MoreUnreadsPills } from "./MoreUnreadsPills";
import { sidebarSectionAttention } from "@/lib/sidebar-attention";
import { DOG_DRAG_TYPE, GROUP_DRAG_TYPE, PIN_DRAG_TYPE, dogDropChangesSection, sectionForDogDrop } from "@/lib/section-drop";
import { botListItemPointerIntent } from "@/lib/sidebar-selection";
import { ConnectAppsPill, SidebarFooterNav } from "./SidebarFooterNav";
import { GlassBar, GlassScrollFrame, GlassScroller } from "./GlassScrollFrame";
import { SidebarProfileMenu } from "./SidebarProfileMenu";
import { SidebarSectionHeader } from "./SidebarSectionHeader";
import { dogRowFacts } from "@/lib/dog-row";
import { botShowsUnread } from "@/lib/bot-unread";
import { useLiveMedia } from "@/lib/live-call-media";
import { LiveCallPill, liveBadgeFor } from "./LiveCallPill";
import { ShortcutHint } from "./ShortcutHint";
import { citationPreviewText } from "@/lib/citations";
import { markdownPreview } from "../../shared/markdown-preview";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { StatusDot } from "./StatusDot";
import { Collapsible } from "./Collapsible";
import { copyConversationId } from "@/lib/copy-conversation-id";
import { dogStatusKind } from "@/lib/dog-status";

export const MAC_TRAFFIC_LIGHT_CENTER_Y = 23;

function sectionLabel(id: string): string {
  return userSectionName(id) ?? t("sidebar.section.unassigned");
}

export function waitingLine(visible: Message[]): string {
  const open = pendingApprovals(visible).at(-1)?.message.card;
  return open ? t("sidebar.preview.waitingFor", { action: approvalAction(open) }) : t("sidebar.preview.waiting");
}

function preview(bot: Bot, visible: Message[], instances: InstanceInfo[]): string {
  if (bot.activity === "waiting-on-you") return waitingLine(visible);
  if (bot.waitingForTeammates) return t("sidebar.preview.waitingOnTeammate");
  if (bot.busy) return t("sidebar.preview.working");
  const last = lastNonReceipt(visible);
  if (!last) return "";
  if (last.kind === "options" && last.card) {
    return (last.card.requestId && last.card.tool && !last.card.questionRequest && approvalCardOutcome(last.card)) || last.card.title;
  }
  if (last.kind === "activity" && last.tool) return activityPreview(last.tool, botEngine(bot, instances));
  if (last.kind === "screen") return t("sidebar.preview.screenFrame");
  if (last.kind === "connector" && last.connector) return sidebarConnectorPreview(last.connector, t);
  const wakeup = cloudWakeupOf(last);
  if (wakeup) return wakeupLine(wakeup.event);
  const peer = peerLine(last);
  if (peer) return `${peer.name}: ${markdownPreview(peer.body)}`;
  const text = citationPreviewText(last.text ?? "");
  return last.role === "user" ? text : markdownPreview(text);
}

interface MenuState {
  botId: string;
  x: number;
  y: number;
}

function openBotContextMenu(onMenu: (menu: MenuState) => void, botId: string, event: React.MouseEvent) {
  event.preventDefault();
  onMenu({ botId, x: event.clientX, y: event.clientY });
}

function groupPreview(group: Group, bots: Bot[], instances: InstanceInfo[]): string {
  if (group.busyBotId) {
    return t("sidebar.preview.botWorking", {
      name: bots.find((b) => b.id === group.busyBotId)?.name ?? t("sidebar.preview.aBot"),
    });
  }
  if (group.working) return t("sidebar.preview.teamWorking");
  const last = lastNonReceipt(group.messages);
  if (!last) return t("sidebar.preview.noMessages");
  const readable = last.kind === "activity" && last.tool
    ? activityPreview(last.tool, botEngine(bots.find((bot) => bot.id === last.from?.botId), instances))
    : last.kind === "connector" && last.connector
      ? sidebarConnectorPreview(last.connector, t)
      : markdownPreview(citationPreviewText(last.text ?? ""));
  const wakeup = cloudWakeupOf(last);
  if (wakeup) return wakeupLine(wakeup.event);
  if (last.role === "user") return t("sidebar.preview.you", { text: readable });
  return last.from ? `${currentDogName(bots.filter((bot) => !bot.hidden), last.from.botId, last.from.name)}: ${readable}` : readable;
}

function StackedDogs({ members, density }: { members: Bot[]; density: SidebarDensity }) {
  const iconOnly = density === "icons";
  const slotSize = iconOnly ? "size-12" : "size-8";
  const singleSize = iconOnly ? 44 : 32;
  if (members.length <= 1) {
    const b = members[0];
    return (
      <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
        {b ? <BotAvatar bot={b} state="happy" size={singleSize} animated={false} /> : <Users size={24} className="text-ink-secondary" />}
      </div>
    );
  }
  const shown = members.slice(0, 2);
  const extra = members.length - shown.length;
  return (
    <div className={cn("flex shrink-0 items-center justify-center", slotSize)}>
      <div className="flex items-center -space-x-2.5">
        {shown.map((b) => (
          <BotAvatar key={b.id} bot={b} state="happy" size={iconOnly ? 30 : 20} animated={false} />
        ))}
        {extra > 0 && (
          <span className="z-10 flex size-4 items-center justify-center rounded-full border border-hairline/40 bg-raised text-[9px] font-medium text-ink-secondary">
            +{extra}
          </span>
        )}
      </div>
    </div>
  );
}

export function GroupListItem({
  group,
  density,
  onMenu,
  draggableToSection = false,
}: {
  group: Group;
  density: SidebarDensity;
  onMenu: (menu: { groupId: string; x: number; y: number }) => void;
  draggableToSection?: boolean;
}) {
  const { state, dispatch } = useStore();
  const selected = state.selectedId === group.id;
  const groupStatus = Boolean(group.busyBotId) || Boolean(group.working);
  const members = group.memberIds
    .map((id) => state.bots.find((b) => b.id === id))
    .filter((b): b is Bot => Boolean(b));
  const last = group.messages.at(-1);
  return (
    <button
      data-sidebar-group-row={group.id}
      data-sidebar-unread={group.unread ? "" : undefined}
      aria-current={selected ? "page" : undefined}
      draggable={draggableToSection && density !== "icons"}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(GROUP_DRAG_TYPE, group.id);
      }}
      onClick={() => dispatch({ type: "select", id: group.id })}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu({ groupId: group.id, x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onMenu({ groupId: group.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
      }}
      className={cn(
        "relative flex w-full items-center rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
        density === "icons" ? "justify-center px-1 py-1.5" : "gap-3 py-2 pl-2 pr-2",
        selected ? "bg-raised/70" : "hover:bg-raised/40",
      )}
      title={density === "icons" ? group.name : undefined}
      aria-label={density === "icons" ? `${group.name}${group.unread ? ` · ${t("task.unread")}` : ""}` : undefined}
    >
      <span className="relative flex shrink-0">
        <StackedDogs members={members} density={density} />
        <StatusDot kind={dogStatusKind({ waiting: false, working: groupStatus })} ring="border-panel" size={density === "icons" ? "size-3" : "size-2.5"} announce={false} />
      </span>
      <div className={cn("min-w-0 flex-1", density === "icons" && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[14px] font-semibold text-ink">{group.name}</span>
          {selected && last && <span className="shrink-0 text-[10px] text-ink-secondary">{formatTime(last.at)}</span>}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[11px] text-ink-secondary">{groupPreview(group, state.bots, state.instances)}</span>
          {group.unread && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label={t("task.unread")} />}
        </div>
      </div>
      {density === "icons" && group.unread && (
        <span className="absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
    </button>
  );
}

export function roomDeleteCopy(group: Pick<Group, "name">) {
  return {
    title: t("sidebar.room.deleteConfirmTitle", { name: group.name }),
    body: t("sidebar.room.deleteChannelBody", { name: group.name }),
    confirmLabel: t("sidebar.room.deleteChannel"),
    tone: "danger" as const,
  };
}

function RoomContextMenu({
  menu,
  onClose,
  onMoveToSection,
  onDelete,
}: {
  menu: { groupId: string; x: number; y: number } | null;
  onClose: () => void;
  onMoveToSection: (groupId: string) => void;
  onDelete: (groupId: string) => void;
}) {
  const motion = useHeldMenuMotion(menu);
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const group = shown ? state.groups.find((g) => g.id === shown.groupId) : undefined;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(group?.name ?? "");

  useEffect(() => {
    if (!menu) return;
    setDraft(state.groups.find((g) => g.id === menu.groupId)?.name ?? "");
    setRenaming(false);
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-room-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);

  if (!motion.shown || !group || !shown) return null;
  const saveRename = () => {
    const name = nextRename(group.name, draft);
    if (name) dispatch({ type: "patchGroup", groupId: group.id, patch: { name } });
    onClose();
  };
  const top = Math.min(shown.y, window.innerHeight - 244);
  const left = Math.min(shown.x, window.innerWidth - 240);
  return createPortal(
    <div
      data-room-menu
      data-sidebar
      style={{ top, left }}
      className={cn("fixed z-40 w-[228px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60", motion.className)} {...motion.exitProps}
    >
      <button
        onClick={() => {
          onClose();
          onMoveToSection(group.id);
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <FolderPlus size={16} className="text-ink-secondary" />
        {t("sidebar.section.moveToContext")}
      </button>
      <button
        onClick={() => {
          dispatch({ type: "patchGroup", groupId: group.id, patch: { unread: !group.unread } });
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        {group.unread ? <Bell size={16} className="text-ink-secondary" /> : <BellDot size={16} className="text-ink-secondary" />}
        {group.unread ? t("sidebar.bot.markRead") : t("sidebar.bot.markUnread")}
      </button>
      {renaming ? (
        <div className="flex items-center gap-1 px-2 py-1">
          <input
            autoFocus
            value={draft}
            maxLength={100}
            aria-label={t("sidebar.room.renameAria", { name: group.name })}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                saveRename();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
            className="min-w-0 flex-1 rounded-lg bg-raised px-2 py-1.5 text-[14px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="button"
            onClick={saveRename}
            aria-label={t("sidebar.room.saveChannelName")}
            title={t("common.save")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <Check size={15} />
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("sidebar.room.cancelChannelRename")}
            title={t("common.cancel")}
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-secondary hover:bg-raised hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => {
            setDraft(group.name);
            setRenaming(true);
          }}
          className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
        >
          <Pencil size={16} className="text-ink-secondary" />
          {t("sidebar.room.renameChannel")}
        </button>
      )}
      <button
        onClick={() => {
          void copyConversationId(group.threadId);
          onClose();
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
      >
        <ClipboardCopy size={16} className="text-ink-secondary" />
        {t("sidebar.copyConversationId")}
      </button>
      <button
        onClick={() => {
          onClose();
          onDelete(group.id);
        }}
        className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger hover:bg-raised/70"
      >
        <Trash2 size={16} />
        {t("sidebar.room.deleteChannel")}
      </button>
    </div>,
    document.body,
  );
}

function NewRoomPanel({ onClose }: { onClose: () => void }) {
  const { state, dispatch } = useStore();
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const bots = state.bots.filter((b) => !b.hidden);
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const create = () => {
    if (!picked.size) return;
    dispatch({
      type: "createGroup",
      memberIds: [...picked],
      name: name.trim() || undefined,
    });
    track("room_created", { members: picked.size });
    onClose();
  };
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-[340px] rounded-2xl border border-hairline/50 bg-card p-4 shadow-2xl">
        <div className="mb-3 text-[15px] font-semibold text-ink">{t("sidebar.newChannel.title")}</div>
        <input
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") create();
            if (e.key === "Escape") onClose();
          }}
          placeholder={t("sidebar.newChannel.name")}
          className="mb-3 w-full rounded-lg bg-raised/70 px-3 py-2 text-[14px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <BotPickerList
          bots={bots}
          picked={picked}
          onToggle={toggle}
          emptyHint={t("sidebar.newChannel.emptyHint")}
        />
        <button
          onClick={create}
          disabled={!picked.size}
          className="mt-3 w-full rounded-lg bg-accent py-2 text-[14px] font-medium text-white hover:brightness-110 disabled:opacity-40"
        >
          {picked.size === 0
            ? t("sidebar.newChannel.create")
            : picked.size === 1
              ? t("sidebar.newChannel.createOne")
              : t("sidebar.newChannel.createMany", { count: picked.size })}
        </button>
      </div>
    </div>
  );
}

function SectionPicker({
  current,
  anchor,
  onClose,
  onAssign,
}: {
  current: string | undefined;
  anchor: { x: number; y: number } | null;
  onClose: () => void;
  onAssign: (section: string) => void;
}) {
  const { state } = useStore();
  const [name, setName] = useState("");
  const motion = useHeldMenuMotion(anchor);
  const shown = motion.value;
  const heldCurrent = useRef(current);
  if (anchor) heldCurrent.current = current;
  const trimmed = name.trim();

  useEffect(() => {
    if (!anchor) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-section-picker]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [anchor, onClose]);

  const sections = [
    ...new Set([
      ...(state.sections ?? []),
      ...state.bots.filter((b) => !b.hidden && b.section).map((b) => b.section!),
      ...state.groups.filter((g) => g.section).map((g) => g.section!),
    ]),
  ];

  const assign = (section: string) => {
    onAssign(section);
    onClose();
  };

  if (!motion.shown || !shown) return null;
  const sectionCurrent = heldCurrent.current;
  const top = Math.max(8, Math.min(shown.y, window.innerHeight - 300));
  const left = Math.min(shown.x, window.innerWidth - 260);

  return (
    <div
      data-section-picker
      style={{ top, left }}
      className={cn("fixed z-40 w-[236px] overflow-hidden rounded-xl border border-hairline/50 bg-menu py-2 shadow-2xl shadow-black/60", motion.className)} {...motion.exitProps}
    >
      <div className="px-3.5 pb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-secondary">
        {t("sidebar.section.moveToContext")}
      </div>
      {sections.length > 0 && (
        <div className="flex flex-col gap-0.5 px-1.5 py-1">
          {sections.map((section) => (
            <button
              key={section}
              onClick={() => assign(section)}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]",
                section === sectionCurrent ? "bg-raised text-ink" : "text-ink hover:bg-raised/70",
              )}
            >
              <span className="truncate">{section}</span>
              {section === sectionCurrent && <Check size={14} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-1.5 px-2.5 py-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed || trimmed.length > 60) return;
          assign(trimmed);
        }}
      >
        <input
          autoFocus
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("sidebar.section.newContext")}
          aria-label={t("sidebar.section.newContextAria")}
          className="w-full rounded-lg bg-raised/70 px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        <button
          type="submit"
          disabled={!trimmed || trimmed.length > 60}
          className={cn(
            "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium",
            trimmed ? "bg-accent text-panel hover:brightness-110" : "bg-raised/70 text-ink-secondary",
          )}
        >
          {t("common.add")}
        </button>
      </form>
      {sectionCurrent && (
        <>
          <div className="mx-2 my-1 border-t border-hairline/40" />
          <button
            onClick={() => assign("")}
            className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] text-danger hover:bg-raised/70"
          >
            <FolderMinus size={15} />
            {t("sidebar.section.removeFromContext")}
          </button>
        </>
      )}
    </div>
  );
}

export function BotContextMenu({
  menu,
  onClose,
  onHide,
  onShow,
  onRename,
  onDelete,
  onReplaceMainDog,
  onMoveToSection,
}: {
  menu: MenuState | null;
  onClose: () => void;
  onHide: (bot: Bot) => void;
  onShow: (bot: Bot) => void;
  onRename: (bot: Bot) => void;
  onDelete: (bot: Bot) => void;
  onReplaceMainDog: (bot: Bot) => void;
  onMoveToSection: (botId: string) => void;
}) {
  const motion = useHeldMenuMotion(menu);
  const shown = motion.value;
  const { state, dispatch } = useStore();
  const bot = shown ? state.bots.find((b) => b.id === shown.botId) : undefined;
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element || !shown) return;
    const place = () => {
      const { width, height } = element.getBoundingClientRect();
      element.style.top = `${Math.max(8, Math.min(shown.y, window.innerHeight - height - 8))}px`;
      element.style.left = `${Math.max(8, Math.min(shown.x, window.innerWidth - width - 8))}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });
  useEffect(() => {
    if (!menu) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest("[data-bot-menu]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onClose);
    };
  }, [menu, onClose]);

  if (!motion.shown || !bot || !shown) return null;
  const deleting = state.deletingBots[bot.id] === true;
  const unread = botShowsUnread(bot);
  const item = (
    icon: React.ReactNode,
    label: string,
    onClick?: () => void,
    opts?: { danger?: boolean },
  ) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      onClick={() => {
        onClick?.();
        onClose();
      }}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] hover:bg-raised/70",
        opts?.danger ? "text-danger" : "text-ink",
      )}
    >
      {icon}
      {label}
    </button>
  );
  const divider = (key: string) => <div key={key} className="mx-2 my-1 border-t border-hairline/40" />;
  const readItem = unread
    ? item(<Bell size={16} className="text-ink-secondary" />, t("sidebar.bot.markRead"), () => dispatch({ type: "markRead", botId: bot.id }))
    : item(<BellDot size={16} className="text-ink-secondary" />, t("sidebar.bot.markUnread"), () => dispatch({ type: "markUnread", botId: bot.id }));
  const lastItem = bot.chiefOfStaff
    ? item(<ArrowLeftRight size={16} className="text-ink-secondary" />, t("mainDog.replace"), () => onReplaceMainDog(bot))
    : <BotDeleteMenuItem key="delete" deleting={deleting} onClick={() => { onClose(); onDelete(bot); }} />;
  const items = bot.hidden
    ? [
        readItem,
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, t("sidebar.bot.rename"), () => onRename(bot)),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("sidebar.copyConversationId"), () => { void copyConversationId(bot.threadId); }),
        divider("d3"),
        item(<Eye size={16} className="text-ink-secondary" />, t("sidebar.bot.show"), () => onShow(bot)),
        lastItem,
      ]
    : [
        item(
          bot.pinned ? <PinOff size={16} className="text-ink-secondary" /> : <Pin size={16} className="text-ink-secondary" />,
          bot.pinned ? t("sidebar.bot.unpin") : t("sidebar.bot.pin"),
          () => dispatch({ type: "updateBot", botId: bot.id, patch: { pinned: !bot.pinned } }),
        ),
        item(<FolderPlus size={16} className="text-ink-secondary" />, t("sidebar.bot.moveToSection"), () => onMoveToSection(bot.id)),
        readItem,
        divider("d1"),
        item(<Pencil size={16} className="text-ink-secondary" />, t("sidebar.bot.rename"), () => onRename(bot)),
        divider("d2"),
        item(<ClipboardCopy size={16} className="text-ink-secondary" />, t("sidebar.copyConversationId"), () => { void copyConversationId(bot.threadId); }),
        divider("d3"),
        item(<EyeOff size={16} className="text-ink-secondary" />, t("sidebar.bot.hide"), () => onHide(bot)),
        lastItem,
      ];

  return createPortal(
    <div
      ref={menuRef}
      data-bot-menu
      data-sidebar
      role="menu"
      aria-label={t("sidebar.bot.actions", { name: bot.name })}
      onKeyDown={navigateMenu}
      style={{ top: shown.y, left: shown.x }}
      className={cn("fixed z-40 max-h-[calc(100dvh-16px)] w-[248px] max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60", motion.className)} {...motion.exitProps}
    >
      {items}
    </div>,
    document.body,
  );
}

export function botDeleteCopy(name: string) {
  return {
    title: t("sidebar.confirm.deleteTitle", { name }),
    body: t("sidebar.confirm.deleteBody", { name }),
    confirmLabel: t("common.delete"),
    tone: "danger" as const,
  };
}

export function BotDeleteMenuItem({ deleting, onClick }: { deleting: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={deleting}
      aria-busy={deleting || undefined}
      onClick={onClick}
      title={deleting ? t("sidebar.bot.deleteCheckingTitle") : undefined}
      className={cn(
        "flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-danger",
        deleting ? "cursor-default opacity-40" : "hover:bg-raised/70",
      )}
    >
      {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
      {deleting ? t("sidebar.bot.deleteChecking") : t("common.delete")}
    </button>
  );
}

export interface BotRowProps {
  bot: Bot;
  selected: boolean;
  deleting: boolean;
  mascotMotion: AppState["mascotMotion"];
  pendingQueued: AppState["pendingQueued"];
  instances: InstanceInfo[];
  liveCall: AppState["liveCall"];
  locale: string;
  density: SidebarDensity;
  dispatch: Dispatch<Action>;
  onMenu: (menu: MenuState) => void;
  draggableToSection?: boolean;
  renameRequest?: number;
  onRenameHandled?: () => void;
}

export function botRowProps(
  state: AppState,
  dispatch: Dispatch<Action>,
  bot: Bot,
  layout: Pick<BotRowProps, "density" | "onMenu" | "onRenameHandled"> & { renameRequest?: { botId: string; at: number } | null },
): BotRowProps {
  const selected = state.selectedId === bot.id;
  const { renameRequest, ...rest } = layout;
  return {
    ...rest,
    renameRequest: renameRequest?.botId === bot.id ? renameRequest.at : 0,
    bot,
    selected,
    deleting: state.deletingBots[bot.id] === true,
    mascotMotion: selected && state.mascotMotion?.botId === bot.id ? state.mascotMotion : null,
    pendingQueued: state.pendingQueued,
    instances: state.instances,
    liveCall: state.liveCall,
    locale: activeLocale(),
    dispatch,
  };
}

function useVisibleMessages(bot: Bot): Message[] {
  const { messages, activeLeafId } = bot;
  return useMemo(() => visibleMessages({ messages, activeLeafId }), [messages, activeLeafId]);
}

export const PinnedBotCircle = memo(function PinnedBotCircle({ bot, selected, mascotMotion, pendingQueued, dispatch, onMenu, onPinDrop }: BotRowProps & { onPinDrop?: (draggedId: string, targetId: string) => void }) {
  const visible = useVisibleMessages(bot);
  const { waiting, working, unread } = dogRowFacts(bot, pendingQueued);
  const radius = avatarCropRadius(botAvatarProfile(bot).avatarCrop);
  return (
    <button
      type="button"
      data-sidebar-bot-row={bot.id}
      data-sidebar-unread={unread ? "" : undefined}
      aria-current={selected ? "page" : undefined}
      aria-label={`${bot.name}${bot.chiefOfStaff ? ` · ${t("mainDog.badge")}` : ""}${waiting ? ` · ${waitingLine(visible)}` : working ? ` · ${t("chat.activity.working")}` : ""}${unread ? ` · ${t("task.unread")}` : ""}`}
      title={bot.name}
      draggable={Boolean(onPinDrop)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(PIN_DRAG_TYPE, bot.id);
      }}
      onDragOver={(event) => {
        if (!onPinDrop || !event.dataTransfer.types.includes(PIN_DRAG_TYPE)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        const dragged = event.dataTransfer.getData(PIN_DRAG_TYPE);
        if (!onPinDrop || !dragged) return;
        event.preventDefault();
        event.stopPropagation();
        onPinDrop(dragged, bot.id);
      }}
      onClick={() => dispatch({ type: "select", id: bot.id })}
      onContextMenu={(event) => openBotContextMenu(onMenu, bot.id, event)}
      className="flex min-w-0 flex-col items-center gap-1 rounded-lg px-1 py-1 text-center outline-none focus-visible:ring-1 focus-visible:ring-accent/60 transition-colors hover:bg-raised/60"
    >
      <span className="relative">
        <span
          className={cn(
            "flex size-16 items-center justify-center overflow-hidden",
            selected && "ring-2 ring-accent ring-offset-2 ring-offset-panel",
          )}
          style={{ borderRadius: radius }}
        >
          <BotAvatar
            bot={bot}
            state={stateForBot({ ...bot, messages: visible })}
            size={64}
            motion={mascotMotion?.kind ?? "none"}
            motionKey={mascotMotion?.nonce ?? 0}
            animated={working || unread || (mascotMotion?.kind ?? "none") !== "none"}
          />
        </span>
        {unread && (
          <span className="absolute top-0.5 right-0.5 size-2.5 rounded-full border-2 border-panel bg-accent" aria-label={t("task.unreadMany")} />
        )}
        {bot.chiefOfStaff && <MainDogBadge />}
        <StatusDot kind={dogStatusKind({ waiting, working })} ring="border-panel" size="size-3" announce={waiting} />
      </span>
      <span className="w-full truncate text-center text-[11px] leading-4 text-ink">{bot.name}</span>
    </button>
  );
});

function PinnedBotRoster({
  bots,
  density,
  row,
  onPinDrop,
}: {
  bots: Bot[];
  density: SidebarDensity;
  row: (bot: Bot) => BotRowProps;
  onPinDrop: (draggedId: string, targetId: string) => void;
}) {
  if (density !== "icons") {
    return (
      <div
        data-sidebar-pinned-grid=""
        className="grid gap-1 px-1 pb-1"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}
      >
        {bots.map((bot) => <PinnedBotCircle key={bot.id} {...row(bot)} onPinDrop={onPinDrop} />)}
      </div>
    );
  }
  return (
    <>
      {bots.map((bot) => <BotListItem key={bot.id} {...row(bot)} />)}
    </>
  );
}

export const BotListItem = memo(function BotListItem(props: BotRowProps) {
  const { bot, selected, deleting, mascotMotion, pendingQueued, instances, liveCall, density, dispatch, onMenu, draggableToSection = false, renameRequest = 0, onRenameHandled } = props;
  const liveMedia = useLiveMedia();
  const [renaming, setRenaming] = useState(false);
  const iconOnly = density === "icons";
  useEffect(() => {
    if (iconOnly) setRenaming(false);
  }, [iconOnly]);
  const avatarSize = iconOnly ? 44 : 32;
  const visible = useVisibleMessages(bot);
  const last = visible.at(-1);
  const title = bot.title.trim();
  const rowClass = cn(
    "flex w-full items-center rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60",
    iconOnly
      ? "justify-center px-1 py-1.5"
      : "gap-3 py-2 pl-2 pr-9",
    selected ? "bg-raised/70" : "hover:bg-raised/40",
  );
  const { waiting, working, teammates: teammateWait, queued, unread } = dogRowFacts(bot, pendingQueued);
  const onLiveCall = liveBadgeFor(bot.id, liveMedia, liveCall);
  const body = (
    <>
      <span className="relative flex shrink-0">
        <BotAvatar
          bot={bot}
          state={stateForBot({ ...bot, messages: visible })}
          size={avatarSize}
          motion={mascotMotion?.kind ?? "none"}
          motionKey={mascotMotion?.nonce ?? 0}
          animated={working || unread || (mascotMotion?.kind ?? "none") !== "none"}
        />
        <StatusDot kind={dogStatusKind({ waiting, working, teammates: teammateWait, queued })} ring="border-panel" size={iconOnly ? "size-3" : "size-2.5"} announce={waiting || teammateWait || (queued && !working)} />
        {bot.chiefOfStaff && <MainDogBadge size={iconOnly ? "size-3" : "size-2.5"} />}
        {onLiveCall && iconOnly && (
          <span className="absolute -right-1 -top-1 flex rounded-full bg-panel p-0.5">
            <Phone className="size-3 shrink-0 text-success" role="img" aria-label={t("call.live.badge")} data-testid="live-call-badge">
              <title>{t("call.live.badge")}</title>
            </Phone>
          </span>
        )}
      </span>
      <div className={cn("min-w-0 flex-1", iconOnly && "hidden")}>
        {title && !renaming && (
          <div className="truncate text-[11px] font-medium leading-4 text-ink-secondary">{title}</div>
        )}
        <div className="flex items-baseline justify-between gap-2">
          <span className="flex min-w-0 grow items-center gap-1.5 truncate text-[14px] font-semibold text-ink">
            {bot.pinned && <Pin size={12} className="shrink-0 text-ink-secondary" />}
            <RenameTitle
              key={iconOnly ? "icons" : "expanded"}
              value={bot.name}
              onCommit={(name) => dispatch({ type: "updateBot", botId: bot.id, patch: { name } })}
              onEditingChange={(editing) => {
                setRenaming(editing);
                if (editing && renameRequest > 0) onRenameHandled?.();
              }}
              editRequest={iconOnly ? 0 : renameRequest}
              className="truncate"
              inputClassName="w-full rounded bg-inset px-1 py-0.5 text-[14px] font-semibold"
            />
            {onLiveCall && !iconOnly && !renaming && (
              <Phone className="size-3 shrink-0 text-success" role="img" aria-label={t("call.live.badge")} data-testid="live-call-badge">
                <title>{t("call.live.badge")}</title>
              </Phone>
            )}
          </span>
          {selected && last && !renaming && (
            <span className="shrink-0 text-xs text-ink-secondary transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 touch:opacity-0">
              {formatTime(last.at)}
            </span>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          {deleting ? (
            <span role="status" className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-ink-secondary">
              <Loader2 size={12} className="shrink-0 animate-spin" />
              {t("sidebar.bot.deletingRow")}
            </span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-ink-secondary">
              {working ? (
                <span className="flex h-[1.5em] items-center" role="status">
                  <WorkingDots size={3.5} />
                  <span className="sr-only">{t("sidebar.preview.working")}</span>
                </span>
              ) : (
                <span className="truncate">{waiting ? waitingLine(visible) : teammateWait ? t("sidebar.preview.waitingOnTeammate") : queued ? t("task.queued") : preview(bot, visible, instances)}</span>
              )}
            </span>
          )}
          {unread && (
            <span className="size-2 shrink-0 rounded-full bg-accent" aria-label={t("task.unread")} />
          )}
        </div>
      </div>
    </>
  );
  const onContextMenu = (event: React.MouseEvent) => {
    openBotContextMenu(onMenu, bot.id, event);
  };
  const onSelect = (event: React.MouseEvent) => {
    if (renaming) return;
    const insideRenameInput = event.target instanceof HTMLInputElement;
    if (botListItemPointerIntent(event.type, insideRenameInput) === "select") {
      dispatch({ type: "select", id: bot.id });
    }
  };

  return (
    <div className="group relative" title={iconOnly ? bot.name : undefined}>
      <div
        role={renaming ? undefined : "button"}
        tabIndex={renaming ? undefined : 0}
        aria-label={
          !renaming && iconOnly
            ? deleting
              ? t("sidebar.bot.deletingAria", { name: bot.name })
              : `${bot.name}${bot.chiefOfStaff ? ` · ${t("mainDog.badge")}` : ""}${onLiveCall ? ` · ${t("call.live.badge")}` : ""}${waiting ? ` · ${waitingLine(visible)}` : working ? ` · ${t("chat.activity.working")}` : teammateWait ? ` · ${t("sidebar.preview.waitingOnTeammate")}` : queued ? ` · ${t("task.queued")}` : ""}${unread ? ` · ${t("task.unread")}` : ""}`
            : undefined
        }
        aria-busy={deleting || undefined}
        aria-current={selected && !renaming ? "page" : undefined}
        data-sidebar-bot-row={bot.id}
        data-sidebar-unread={unread ? "" : undefined}
        draggable={draggableToSection && !renaming && !iconOnly && !deleting}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(DOG_DRAG_TYPE, bot.id);
        }}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (renaming) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            dispatch({ type: "select", id: bot.id });
          }
        }}
        onContextMenu={onContextMenu}
        className={rowClass}
      >
        {body}
      </div>
      {!renaming && iconOnly && unread && (
        <span className="pointer-events-none absolute bottom-1.5 right-1.5 size-2 rounded-full border border-panel bg-accent" />
      )}
      {!renaming && !deleting && !iconOnly && <button type="button" aria-label={t("sidebar.bot.actions", { name: bot.name })} title={t("sidebar.bot.actions", { name: bot.name })} aria-haspopup="menu" onClick={(event) => { const rect = event.currentTarget.getBoundingClientRect(); onMenu({ botId: bot.id, x: rect.left, y: rect.bottom }); }}
        className="pointer-events-none absolute right-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded text-ink-secondary opacity-0 hover:bg-raised hover:text-ink group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 max-md:pointer-events-auto max-md:opacity-70 touch:pointer-events-auto touch:opacity-70"><MoreHorizontal size={15} /></button>}
      {deleting && iconOnly && (
        <span className="pointer-events-none absolute bottom-1 right-1 rounded-full bg-card p-1 text-ink-secondary">
          <Loader2 size={12} className="animate-spin" />
        </span>
      )}
    </div>
  );
});

export function SectionMenuItems({ onRename, onDelete }: {
  onRename: () => void;
  onDelete: () => void;
}) {
  const item = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] hover:bg-raised";
  return (
    <>
      <button type="button" role="menuitem" autoFocus className={item} onClick={onRename}><Pencil size={14} />{t("section.rename")}</button>
      <button type="button" role="menuitem" className={cn(item, "text-danger")} onClick={onDelete}><Trash2 size={14} />{t("common.delete")}</button>
    </>
  );
}

export function addedDogsLine(result: AddDogResult): string {
  const added = result.members === 1 ? t("addDog.addedOne") : t("addDog.addedMany", { count: result.members });
  return result.connections ? `${added} · ${t("sidebar.connectionsToFinish", { count: result.connections })}` : added;
}

export function Sidebar({ open, onClose, collapseToIcons = false }: {
  open: boolean;
  onClose: () => void;
  collapseToIcons?: boolean;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const sidebarRef = useRef<HTMLElement>(null);
  const [confirm, setConfirm] = useState<Bot | null>(null);
  const cancelConfirm = useCallback(() => setConfirm(null), []);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [sectionPicker, setSectionPicker] = useState<MenuState | null>(null);
  const [mainDogReplacing, setMainDogReplacing] = useState<Bot | null>(null);
  const [renameRequest, setRenameRequest] = useState<{ botId: string; at: number } | null>(null);
  const clearRenameRequest = useCallback(() => setRenameRequest(null), []);
  const [sectionMenu, setSectionMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  const sectionMotion = useHeldMenuMotion(sectionMenu);
  const sectionMenuReturn = useRef<HTMLElement | null>(null);
  const closeSectionMenu = () => {
    (sectionMenuReturn.current?.isConnected ? sectionMenuReturn.current : sidebarRef.current)?.focus();
    setSectionMenu(null);
  };
  const renamedSection = (oldName: string, newName: string) => {
    const replace = (ids: string[]) => [...new Set(ids.map(id => id === userSectionId(oldName) ? userSectionId(newName) : id))];
    setCollapsedSections(current => { const next = replace(current); saveCollapsedSections(next); return next; });
    requestAnimationFrame(() => {
      const header = [...(sidebarRef.current?.querySelectorAll<HTMLElement>("[data-section]") ?? [])]
        .find(element => element.dataset.section === newName);
      (header?.querySelector<HTMLElement>("button") ?? header ?? sidebarRef.current)?.focus();
    });
  };
  const [deletingSection, setDeletingSection] = useState<string | null>(null);
  const [sectionDeletePending, setSectionDeletePending] = useState(false);
  const sectionDeleteRunning = useRef(false);
  const [renamingSection, setRenamingSection] = useState<string | null>(null);
  const [dogDropSection, setDogDropSection] = useState<string | null>(null);
  const [roomMenu, setRoomMenu] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [roomSectionPicker, setRoomSectionPicker] = useState<{ groupId: string; x: number; y: number } | null>(null);
  const [deletingRoomId, setDeletingRoomId] = useState<string | null>(null);
  const deletingRoom = deletingRoomId ? state.groups.find((g) => g.id === deletingRoomId) : undefined;
  const [plusOpen, setPlusOpen] = useState(false);
  const plusMotion = useMenuMotion(plusOpen);
  const [newRoom, setNewRoom] = useState(false);
  const [addDogSource, setAddDogSource] = useState<AddDogSource | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const storedDensity = useSidebarDensity();
  const density = collapseToIcons ? "icons" : storedDensity;
  const defaultWidth = 320;
  const sidePanelOpen = state.computerOpen;
  const maxSidebarWidth = sidePanelOpen ? defaultWidth : Math.min(480, window.innerWidth - 320);
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(() => loadSidebarWidth());
  const widthRef = useRef(sidebarWidth);
  const [resizing, setResizing] = useState(false);
  const resizeTo = (width: number) => {
    const next = clampSidebarWidth(width, sidePanelOpen ? defaultWidth + 320 : window.innerWidth);
    if (next === Math.round(sidebarRef.current?.getBoundingClientRect().width ?? defaultWidth)) return null;
    widthRef.current = next;
    sidebarRef.current?.style.setProperty("--sidebar-width", `${next}px`);
    return next;
  };
  const finishResize = () => {
    setResizing(false);
    if (widthRef.current !== null) {
      setSidebarWidth(widthRef.current);
      saveSidebarWidth(widthRef.current);
    }
  };
  const [collapsedSections, setCollapsedSections] = useState<string[]>(() => loadCollapsedSections());
  const [pinOrder, setPinOrder] = useState<string[]>(() => loadPinOrder());
  const [draggingSectionId, setDraggingSectionId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; place: SectionDropPlace } | null>(null);
  const [reorderAnnouncement, setReorderAnnouncement] = useState("");
  const sectionDragRef = useRef<{
    from: string | null;
    over: { id: string; place: SectionDropPlace } | null;
  }>({ from: null, over: null });

  const toggleCollapsed = () => {
    setSidebarDensity(density === "icons" ? "comfortable" : "icons");
  };

  useEffect(() => {
    if (!open || confirm || deletingRoom) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open, onClose, confirm, deletingRoom]);

  const plusMenuRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(plusOpen, plusMenuRef, () => setPlusOpen(false));
  useEffect(() => {
    if (plusOpen) plusMenuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
  }, [plusOpen]);

  useEffect(() => {
    return window.laterdog?.onPackageInstall?.((url) => setAddDogSource({ url }));
  }, []);

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(null), 5000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  const setHidden = async (bot: Bot, hidden: boolean) => {
    setFeedback(null);
    try {
      const response = await api(`/api/bots/${bot.id}`, {
        method: "PATCH",
        body: JSON.stringify({ hidden }),
      });
      dispatch({ type: "botPatched", bot: response.bot });
    } catch (cause) {
      setFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) });
    }
  };

  const renameBot = (bot: Bot) => {
    if ((bot.pinned && !bot.hidden) || density === "icons") {
      dispatch({ type: "select", id: bot.id });
      dispatch({ type: "toggleSettings", open: true, section: "identity" });
      return;
    }
    if (bot.hidden) setHiddenOpen(true);
    setRenameRequest({ botId: bot.id, at: Date.now() });
  };

  const macInset = capabilities.windowChrome === "mac-inset";
  const browser = capabilities.host.label === "Browser";
  const draggableChrome = macInset || capabilities.windowChrome === "win-caption";
  const windowDragStyle = draggableChrome
    ? ({ WebkitAppRegion: "drag" } as React.CSSProperties)
    : undefined;
  const windowNoDragStyle = draggableChrome
    ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties)
    : undefined;

  const { pinnedBots: pinnedUnordered, sectionedBots, unsectionedBots, hiddenBots } = partitionSidebarBots(state.bots);
  const pinnedBots = orderPinnedBots(pinnedUnordered, pinOrder);
  const { sectionedRooms, unsectionedRooms } = partitionSidebarGroups(state.groups);
  const sectionNames = sidebarSectionNames(state.sections ?? [], [...sectionedBots, ...sectionedRooms]);
  const sectionIds = [
    ...sectionNames.map(userSectionId),
    ...(sectionNames.length > 0 || unsectionedBots.length > 0 || unsectionedRooms.length > 0 ? [UNASSIGNED_SECTION_ID] : []),
  ];
  const layoutInteractive = sidebarLayoutInteractive(density);
  const sectionCollapsed = (id: string) => sidebarSectionCollapsed(id, collapsedSections, density);
  const sectionRooms = (id: string) => {
    const name = userSectionName(id);
    return name === null ? unsectionedRooms : sectionedRooms.filter((group) => group.section === name);
  };
  const sectionBots = (id: string) => {
    const name = userSectionName(id);
    return name === null ? unsectionedBots : sectionedBots.filter((bot) => bot.section === name);
  };
  const visibleOrder = [
    ...pinnedBots.map((bot) => bot.id),
    ...sectionIds.flatMap((id) => sectionCollapsed(id) ? [] : [...sectionRooms(id).map((group) => group.id), ...sectionBots(id).map((bot) => bot.id)]),
  ];
  const visibleOrderKey = visibleOrder.join("\n");
  useEffect(() => {
    publishSidebarOrder(visibleOrderKey ? visibleOrderKey.split("\n") : []);
  }, [visibleOrderKey]);

  const toggleSection = (id: string) => {
    if (!layoutInteractive) return;
    const next = toggleCollapsedSection(collapsedSections, id);
    setCollapsedSections(next);
    saveCollapsedSections(next);
  };

  const commitSectionOrder = (names: string[], moved: string) => {
    if (!layoutInteractive || names.every((name, index) => name === sectionNames[index])) return;
    dispatch({ type: "orderSections", sections: names });
    setReorderAnnouncement(
      t("sidebar.section.moved", { name: moved, position: names.indexOf(moved) + 1, count: names.length }),
    );
  };

  const moveSidebarSection = (name: string, direction: -1 | 1) => {
    commitSectionOrder(moveSection(sectionNames, name, direction), name);
  };

  const resetSectionDrag = () => {
    sectionDragRef.current = { from: null, over: null };
    setDraggingSectionId(null);
    setDropTarget(null);
  };

  const updateSectionDropTarget = (event: React.DragEvent<HTMLDivElement>, id: string) => {
    if (!layoutInteractive || !sectionDragRef.current.from || userSectionName(id) === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const rect = event.currentTarget.getBoundingClientRect();
    const place: SectionDropPlace = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
    const next = { id, place };
    sectionDragRef.current.over = next;
    setDropTarget(next);
  };

  const dropSection = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const from = userSectionName(
      event.dataTransfer.getData("application/x-laterdog-sidebar-section") || sectionDragRef.current.from || "",
    );
    const over = sectionDragRef.current.over;
    const target = over ? userSectionName(over.id) : null;
    if (from !== null && over && target !== null) commitSectionOrder(placeSection(sectionNames, from, target, over.place), from);
    resetSectionDrag();
  };

  const dropPin = (draggedId: string, targetId: string) => {
    const ids = pinnedBots.map((bot) => bot.id);
    if (!ids.includes(draggedId) || draggedId === targetId) return;
    const next = placeSection(ids, draggedId, targetId, ids.indexOf(draggedId) < ids.indexOf(targetId) ? "after" : "before");
    setPinOrder(next);
    savePinOrder(next);
  };

  const botRow = (bot: Bot) => botRowProps(state, dispatch, bot, { density, onMenu: setMenu, renameRequest, onRenameHandled: clearRenameRequest });
  const iconRail = density === "icons";
  const searchButton = (
    <button
      type="button"
      onClick={() => dispatch({ type: "toggleSearch", open: true })}
      aria-label={t("sidebar.search")}
      title={t("sidebar.search")}
      className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
    >
      <Search size={16} strokeWidth={2} />
    </button>
  );

  return (
    <aside
      ref={sidebarRef}
      tabIndex={-1}
      onDrop={(event) => {
        const at = droppedDogFile(event.dataTransfer.files);
        if (at < 0) return;
        event.preventDefault();
        event.stopPropagation();
        setAddDogSource({ file: event.dataTransfer.files[at]! });
      }}
      aria-label={t("sidebar.aria")}
      data-native-view-overlay
      data-sidebar
      style={{ "--sidebar-width": `${widthRef.current ?? defaultWidth}px` } as CSSProperties}
      className={cn(
        "relative flex h-full shrink-0 flex-col border-r border-hairline/40 bg-panel",
        resizing ? "transition-none" : "transition-[width] duration-200",
        iconRail ? "w-[80px]" : "w-[320px] md:w-[var(--sidebar-width)]",
        sidePanelOpen ? "md:max-w-[320px]" : "md:max-w-[calc(100vw-320px)]",
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40",
        "max-md:transition-transform max-md:duration-200",
        open ? "max-md:translate-x-0" : "max-md:-translate-x-full",
      )}
    >
      <GlassScrollFrame className="flex-1">
      <GlassBar edge="top">
      <div
        data-sidebar-top-row
        className={cn(
          "flex items-center",
          iconRail ? "flex-col gap-1 px-2 pt-3.5 pb-1" : "relative pl-4 pr-2",
          !iconRail && !macInset && "h-12",
        )}
        style={!iconRail && macInset ? { ...windowDragStyle, height: MAC_TRAFFIC_LIGHT_CENTER_Y * 2 } : windowDragStyle}
      >
        {macInset ? (
          <div aria-hidden="true" data-traffic-light-space className={iconRail ? "h-5 w-full" : "w-[72px] shrink-0"} />
        ) : browser ? (
          <div className={cn("flex shrink-0 items-center gap-2", !iconRail && "mr-3")}>
            <span className="size-3 rounded-full bg-[#ff5f57]" />
            <span className="size-3 rounded-full bg-[#febc2e]" />
            <span className="size-3 rounded-full bg-[#28c840]" />
          </div>
        ) : null}
        {!iconRail && (
          <div data-sidebar-top-slot className="@container/sidebar-top flex min-w-0 flex-1 items-center">
            <div data-sidebar-top-spacer className="min-w-0 flex-1" />
          </div>
        )}
        <div
          data-sidebar-top-buttons
          className={cn("relative flex shrink-0 items-center", iconRail ? "flex-col gap-1" : "ml-0.5 gap-0.5")}
          style={windowNoDragStyle}
        >
          {!collapseToIcons && iconRail && <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={t("sidebar.density.expand")}
            className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={t("sidebar.density.expand")}
          >
            <PanelLeftOpen size={17} />
          </button>}
          {searchButton}
          <div ref={plusMenuRef} className="contents">
          <button
            onClick={() => setPlusOpen((o) => !o)}
            aria-label={t("sidebar.new")}
            aria-haspopup="menu"
            aria-expanded={plusOpen}
            className="flex size-8 items-center justify-center rounded-md text-ink-secondary hover:bg-raised hover:text-ink"
            title={t("sidebar.new")}
          >
            <Plus size={17} strokeWidth={2} />
          </button>
          {plusMotion.shown && (
            <>
              <div role="menu" aria-label={t("sidebar.new")} onKeyDown={navigateMenu} className={cn(
                "absolute top-full z-40 mt-1 w-52 overflow-hidden rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60",
                iconRail ? "left-0" : "right-0",
                plusMotion.className,
              )} {...plusMotion.exitProps}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    dispatch({ type: "toggleNewBot", open: true });
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <BotIcon size={16} className="text-ink-secondary" />
                  <span className="flex-1">{t("sidebar.newBot")}</span>
                  <ShortcutHint id="new-bot" />
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setPlusOpen(false);
                    setNewRoom(true);
                  }}
                  className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink hover:bg-raised/70"
                >
                  <Users size={16} className="text-ink-secondary" />
                  <span className="flex-1">{t("sidebar.newChannel.title")}</span>
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </div>

      <OrganizationIdentity compact={iconRail} />
      <PaneErrorLine
        panes={["sidebar"]}
        look="icon"
        quietLine={iconRail}
        className={iconRail ? "justify-center px-2 pb-2" : "pb-2 pl-4 pr-2"}
      />

      {pinnedBots.length > 0 && (
        <div
          data-sidebar-pins=""
          className="max-h-[min(40vh,280px)] shrink-0 overflow-y-auto border-b border-hairline/40 px-2 pb-2"
        >
          <PinnedBotRoster bots={pinnedBots} density={density} row={botRow} onPinDrop={dropPin} />
        </div>
      )}

      </GlassBar>

      {!iconRail && <div
        role="separator"
        aria-label={t("sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemin={240}
        aria-valuemax={maxSidebarWidth}
        aria-valuenow={Math.min(sidebarWidth ?? defaultWidth, maxSidebarWidth)}
        tabIndex={0}
        data-sidebar-resize
        className="absolute inset-y-0 -right-1 z-20 hidden w-2 cursor-col-resize touch-none hover:bg-accent/20 focus-visible:bg-accent/30 md:block"
        style={windowNoDragStyle}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const next = resizeTo(event.clientX - (sidebarRef.current?.getBoundingClientRect().left ?? 0));
          if (next !== null) event.currentTarget.setAttribute("aria-valuenow", String(next));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) finishResize();
        }}
        onPointerCancel={finishResize}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const limit = sidePanelOpen ? defaultWidth : Math.min(480, window.innerWidth - 320);
          const next = resizeTo(Math.min(widthRef.current ?? defaultWidth, limit) + (event.key === "ArrowRight" ? 16 : -16));
          if (next === null) return;
          setSidebarWidth(next);
          saveSidebarWidth(next);
        }}
      />}

      <GlassScroller className="px-2" data-sidebar-scroller="">
        <div className="flex flex-col gap-0.5">
          {sectionIds.map((id, index) => {
            const sectionName = userSectionName(id);
            const dropTargetSection = layoutInteractive ? sectionForDogDrop(id) : null;
            const sectionGroupItems = sectionRooms(id);
            const sectionBotItems = sectionBots(id);
            const collapsed = sectionCollapsed(id);
            const showHeader = !iconRail && sectionNames.length > 0;
            const queued = collapsed ? sectionBotItems.flatMap((bot) =>
              dogRowFacts(bot, state.pendingQueued).queued ? [bot.name] : []) : [];
            const attention = collapsed
              ? sidebarSectionAttention(
                  sectionBotItems.map((bot) => ({ ...currentTaskBot(bot), unread: botShowsUnread(bot) })),
                  sectionGroupItems,
                )
              : undefined;
            return (
              <div
                key={id}
                data-sidebar-section-id={id}
                onDragOver={(event) => {
                  const types = event.dataTransfer.types;
                  if (dropTargetSection !== null && (types.includes(DOG_DRAG_TYPE) || types.includes(GROUP_DRAG_TYPE))) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setDogDropSection(id);
                    return;
                  }
                  updateSectionDropTarget(event, id);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDogDropSection((current) => current === id ? null : current);
                }}
                onDrop={(event) => {
                  const dogId = event.dataTransfer.getData(DOG_DRAG_TYPE);
                  const groupId = event.dataTransfer.getData(GROUP_DRAG_TYPE);
                  if (dogId || groupId) {
                    event.preventDefault();
                    setDogDropSection(null);
                    const dog = dogId ? state.bots.find((bot) => bot.id === dogId) : undefined;
                    const room = groupId ? state.groups.find((group) => group.id === groupId) : undefined;
                    if (dog && dogDropChangesSection(dog.section, dropTargetSection)) {
                      dispatch({ type: "updateBot", botId: dog.id, patch: { section: dropTargetSection } });
                    }
                    if (room && dogDropChangesSection(room.section, dropTargetSection)) {
                      dispatch({ type: "patchGroup", groupId: room.id, patch: { section: dropTargetSection } });
                    }
                    return;
                  }
                  dropSection(event);
                }}
                className={cn(
                  "flex flex-col gap-0.5 rounded-lg",
                  showHeader && index > 0 && "pt-3",
                  dogDropSection === id && "bg-raised/40",
                )}
              >
                {dropTarget?.id === id && dropTarget.place === "before" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
                {showHeader && (
                  <SidebarSectionHeader
                    name={sectionLabel(id)}
                    count={sectionBotItems.length + sectionGroupItems.length}
                    onContextMenu={layoutInteractive && sectionName ? (event) => {
                      event.preventDefault();
                      sectionMenuReturn.current = event.currentTarget.querySelector<HTMLElement>("button") ?? event.currentTarget;
                      setSectionMenu({ name: sectionName, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 230)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)) });
                    } : undefined}
                    collapsed={collapsed}
                    attention={attention}
                    onToggle={layoutInteractive ? () => toggleSection(id) : undefined}
                    reorderable={layoutInteractive && sectionName !== null && sectionNames.length > 1}
                    dragging={draggingSectionId === id}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-laterdog-sidebar-section", id);
                      event.dataTransfer.setData("text/plain", id);
                      sectionDragRef.current = { from: id, over: null };
                      setDraggingSectionId(id);
                    }}
                    onDragEnd={resetSectionDrag}
                    onMove={sectionName === null ? undefined : (direction) => moveSidebarSection(sectionName, direction)}
                    onDelete={sectionName ? () => setDeletingSection(sectionName) : undefined}
                  />
                )}
                {collapsed && queued.length > 0 && <button type="button" onClick={() => toggleSection(id)}
                  title={`${t("task.queued")} · ${queued.join(", ")}`} aria-label={`${t("sidebar.section.expand", { name: sectionLabel(id) })} · ${t("task.queued")} · ${queued.join(", ")}`}
                  className="mx-3 mb-1 self-start rounded bg-raised/50 px-2 py-0.5 text-[10px] text-ink-secondary hover:text-ink">{t("task.queued")} · {queued.length}</button>}
                <Collapsible open={!collapsed} className="flex flex-col gap-0.5">
                  <>
                    {sectionGroupItems.map((group) => (
                      <GroupListItem
                        key={group.id}
                        group={group}
                        density={density}
                        onMenu={setRoomMenu}
                        draggableToSection={layoutInteractive && sectionNames.length > 0}
                      />
                    ))}
                    {sectionBotItems.map((bot) => <BotListItem key={bot.id} {...botRow(bot)} draggableToSection={layoutInteractive && sectionNames.length > 0} />)}
                    {showHeader && layoutInteractive && sectionBotItems.length === 0 && sectionGroupItems.length === 0 && (
                      <p data-section-empty className="mx-3 my-1 rounded-md border border-dashed border-hairline/50 px-2 py-2 text-center text-[12px] text-ink-tertiary">
                        {t("sidebar.section.dropHere")}
                      </p>
                    )}
                  </>
                </Collapsible>
                {dropTarget?.id === id && dropTarget.place === "after" && draggingSectionId !== id && (
                  <div className="mx-2 h-0.5 rounded-full bg-accent" />
                )}
              </div>
            );
          })}
          {hiddenBots.length > 0 && !iconRail && (
            <div data-sidebar-section-id={HIDDEN_SECTION_ID} className="mt-3 flex flex-col gap-0.5">
              <button
                type="button"
                data-sidebar-hidden-dogs
                aria-expanded={hiddenOpen}
                onClick={() => setHiddenOpen((value) => !value)}
                className="mx-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] font-semibold text-ink-secondary hover:bg-raised/50"
              >
                <span className="truncate">{t("sidebar.hidden.title")}</span>
                <span data-section-count className="shrink-0 text-[11px] font-normal text-ink-tertiary">{hiddenBots.length}</span>
                {hiddenOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              </button>
              <Collapsible open={hiddenOpen} className="flex flex-col gap-0.5 opacity-70">
                <>{hiddenBots.map((bot) => <BotListItem key={bot.id} {...botRow(bot)} />)}</>
              </Collapsible>
            </div>
          )}
        </div>
      </GlassScroller>
      <MoreUnreadsPills sidebarRef={sidebarRef} watchKey={`${visibleOrderKey}|${state.bots.filter(botShowsUnread).length}|${state.groups.filter((group) => group.unread).length}`} />
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {reorderAnnouncement}
      </p>

      <GlassBar edge="bottom">
      <LiveCallPill
        currentBotId={state.selectedId}
        onOpen={(botId, threadId) => openNotificationTarget(dispatch, { botId, threadId }, state)}
        iconOnly={iconRail}
      />

      <div className={cn("pb-3 pt-2", iconRail ? "px-2" : "px-3")}>
        {iconRail ? (
          <div className="flex flex-col items-center gap-1">
            <SidebarFooterNav density={density} />
            <UpdatePill compact />
            <SidebarProfileMenu compact />
          </div>
        ) : (
          <div data-sidebar-footer className="flex items-center gap-2">
            <SidebarProfileMenu />
            <ConnectAppsPill />
            <UpdatePill compact />
          </div>
        )}
      </div>
      </GlassBar>
      </GlassScrollFrame>

      <BotContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onHide={(bot) => void setHidden(bot, true)}
          onShow={(bot) => void setHidden(bot, false)}
          onRename={renameBot}
          onDelete={(bot) => setConfirm(bot)}
          onReplaceMainDog={setMainDogReplacing}
          onMoveToSection={(botId) => {
            if (!menu) return;
            setSectionPicker({ botId, x: menu.x, y: menu.y });
          }}
        />
      <ConfirmDialog
        open={confirm !== null}
        {...botDeleteCopy(confirm?.name ?? "")}
        icon={<Trash2 size={18} />}
        onCancel={cancelConfirm}
        returnFocusRef={sidebarRef}
        onConfirm={() => {
          if (!confirm) return;
          const bot = confirm;
          setConfirm(null);
          dispatch({ type: "deleteBot", botId: bot.id });
        }}
      />
      {mainDogReplacing && (
        <MainDogPicker
          bots={state.bots}
          currentId={mainDogReplacing.id}
          onCancel={() => setMainDogReplacing(null)}
          onConfirm={(botId) => {
            setMainDogReplacing(null);
            dispatch({ type: "updateBot", botId, patch: { chiefOfStaff: true } });
          }}
        />
      )}
      {renamingSection !== null && <SectionRenameDialog section={renamingSection} onRenamed={renamedSection} onClose={() => setRenamingSection(null)} />}
      {sectionMotion.shown && sectionMotion.value && createPortal(<div className={cn("fixed inset-0 z-40", sectionMotion.closing && "pointer-events-none")} onMouseDown={closeSectionMenu}>
        <div role="menu" aria-label={sectionMotion.value.name} style={{ left: sectionMotion.value.x, top: sectionMotion.value.y }}
          className={cn("absolute w-[220px] rounded-xl border border-hairline/50 bg-menu p-1.5 text-ink shadow-xl", sectionMotion.className)} {...sectionMotion.exitProps}
          onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
            if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); event.stopPropagation(); closeSectionMenu(); return; }
            navigateMenu(event);
          }}>
          <SectionMenuItems
            onRename={() => { closeSectionMenu(); setRenamingSection(sectionMotion.value!.name); }}
            onDelete={() => { closeSectionMenu(); setDeletingSection(sectionMotion.value!.name); }}
          />
        </div>
      </div>, document.body)}
      <ConfirmDialog open={deletingSection !== null} title={t("section.deleteTitle", { name: deletingSection ?? "" })}
        body={t("section.deleteBody")} confirmLabel={t("common.delete")} returnFocusRef={sidebarRef}
        pending={sectionDeletePending}
        onCancel={() => { if (!sectionDeleteRunning.current) setDeletingSection(null); }} onConfirm={() => {
          const name = deletingSection;
          if (!name || sectionDeleteRunning.current) return;
          sectionDeleteRunning.current = true;
          setSectionDeletePending(true);
          void api(`/api/sidebar-sections?section=${encodeURIComponent(name)}`, { method: "DELETE" })
            .then(({ sections }) => { dispatch({ type: "sectionDeleted", section: name, sections }); setDeletingSection(null); })
            .catch(cause => setFeedback({ error: true, text: cause instanceof Error ? cause.message : String(cause) }))
            .finally(() => { sectionDeleteRunning.current = false; setSectionDeletePending(false); });
        }} />
      <SectionPicker
          current={sectionPicker ? state.bots.find((b) => b.id === sectionPicker.botId)?.section : undefined}
          anchor={sectionPicker}
          onClose={() => setSectionPicker(null)}
          onAssign={(section) => {
            if (!sectionPicker) return;
            dispatch({ type: "updateBot", botId: sectionPicker.botId, patch: { section } });
          }}
        />
      <RoomContextMenu
          menu={roomMenu}
          onClose={() => setRoomMenu(null)}
          onMoveToSection={(groupId) => {
            if (!roomMenu) return;
            setRoomSectionPicker({ groupId, x: roomMenu.x, y: roomMenu.y });
          }}
          onDelete={(groupId) => {
            sidebarRef.current?.focus();
            setDeletingRoomId(groupId);
          }}
        />
      <ConfirmDialog
        open={deletingRoom !== undefined}
        {...roomDeleteCopy(deletingRoom ?? { name: "" })}
        icon={<Trash2 size={18} />}
        returnFocusRef={sidebarRef}
        onCancel={() => setDeletingRoomId(null)}
        onConfirm={() => {
          const groupId = deletingRoom?.id;
          setDeletingRoomId(null);
          if (groupId) dispatch({ type: "deleteGroup", groupId });
        }}
      />
      <SectionPicker
          current={roomSectionPicker ? state.groups.find((g) => g.id === roomSectionPicker.groupId)?.section : undefined}
          anchor={roomSectionPicker}
          onClose={() => setRoomSectionPicker(null)}
          onAssign={(section) => {
            if (!roomSectionPicker) return;
            dispatch({ type: "patchGroup", groupId: roomSectionPicker.groupId, patch: { section } });
          }}
        />
      {newRoom && <NewRoomPanel onClose={() => setNewRoom(false)} />}
      {addDogSource !== null && (
        <AddDogSheet
          source={addDogSource}
          onClose={() => setAddDogSource(null)}
          onAdded={(result: AddDogResult) => {
            setAddDogSource(null);
            setFeedback({ error: false, text: addedDogsLine(result) });
          }}
        />
      )}
      {feedback &&
        createPortal(
          <div
            role="status"
            className={cn(
              "fixed bottom-4 left-4 z-[60] max-w-[300px] rounded-xl border px-3.5 py-2.5 text-[13px] shadow-xl",
              feedback.error
                ? "border-danger/30 bg-card text-danger"
                : "border-hairline/50 bg-card text-ink",
            )}
          >
            {feedback.text}
          </div>,
          document.body,
        )}
    </aside>
  );
}
