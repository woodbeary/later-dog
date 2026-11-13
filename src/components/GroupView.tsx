import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import { ArrowDown, Plus, Search } from "lucide-react";
import type {
  Group,
  Message,
} from "@/state/store";
import { dogIn, sameItems, useStoreSelector } from "@/state/store-selectors";
import { BotAvatar } from "./Avatar";
import { WorkStatusLine } from "./WorkStatusLine";
import { PlaceIcon } from "./PlaceIcon";
import { effectivePlace, placeLabelKey } from "@/lib/place";
import { ExchangeViewHost } from "./ExchangeViewHost";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { useScrollAnchor } from "@/lib/scroll-anchor";
import { transcriptRowShown } from "@/lib/room-activity";
import { normalizeState } from "@/lib/mascot";
import { groupResponseHint, jevRoomRoutingOn } from "@/lib/group-routing";
import { CitationSelectionToolbar } from "./CitationUI";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { ExportTranscriptMenu } from "./ExportTranscriptMenu";
import { PaneErrorLine } from "./PaneErrorLine";
import { chatPane } from "@/state/pane-errors";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { useCaptionChrome } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { useComposerDockPad } from "@/lib/composer-dock";
import { GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { awaitedMemberId, showWorkingDots } from "@/lib/turn-tail";
import { liveActivity } from "@/lib/live-activity";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { appendDraftAttachments, useReplyDraft } from "@/lib/drafts";
import { latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { openQuestion } from "@/lib/open-question";
import { pendingApprovals } from "./PendingApproval";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";
import { RoomToolChip, Transcript, TranscriptRows, roomThreadKey } from "./RoomTranscript";
import { isUnread, useUnreadBoundary } from "@/lib/unread-boundary";

export { RoomToolChip, Transcript };

export function GroupView({ group }: { group: Group }) {
  const config = useStoreSelector((state) => state.config);
  const showToolCalls = showToolCallsEnabled(config);
  const countsInWindow = useCallback((message: Message) => transcriptRowShown(message, showToolCalls), [showToolCalls]);
  const { dragStyle: headerDragStyle, noDragStyle: headerNoDragStyle, controlsShiftStyle } = useCaptionChrome();
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const [membersOpen, setMembersOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    group.threadId,
    `group:${group.id}:${group.threadId}`,
    group.messages,
  );
  const membersTriggerRef = useRef<HTMLButtonElement>(null);
  const closeMembers = useCallback(() => setMembersOpen(false), []);
  useEffect(() => setFindOpen(false), [group.threadId]);
  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  const members = useStoreSelector((state) => group.memberIds.flatMap((id) => dogIn(state, id) ?? []), sameItems);
  const speaker = members.find((b) => b.id === group.busyBotId);

  const lastGroupMessage = group.messages.at(-1);
  const toolInFlight = lastGroupMessage?.kind === "activity" && lastGroupMessage.tool?.ok === undefined;
  const groupActivity = liveActivity(lastGroupMessage);
  const awaited = members.find(
    (b) => b.id === awaitedMemberId(group.working, group.busyBotId, lastGroupMessage),
  );
  const waiting =
    Boolean(speaker && showWorkingDots(true, group.messages.at(-1), speaker.id)) || awaited !== undefined;
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<{ id: string; botId?: string } | null>(null);
  const poppingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = null;
    wasWaiting.current = false;
    setPopping(null);
  }, [group.id, group.threadId]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastGroupMessage?.role !== "bot" || lastGroupMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    setPopping({
      id: lastGroupMessage.id,
      botId: lastGroupMessage.from?.botId,
    });
    const messageId = lastGroupMessage.id;
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = setTimeout(() => {
      poppingTimer.current = null;
      setPopping((current) => current?.id === messageId ? null : current);
    }, 520);
  }, [
    lastGroupMessage?.id,
    lastGroupMessage?.role,
    lastGroupMessage?.kind,
    lastGroupMessage?.from?.botId,
  ]);
  const presenceVisible = waiting || popping !== null;
  const announcement = useMemo((): TranscriptSnapshot => {
    const approval = pendingApprovals(group.messages)[0];
    const question = openQuestion(group.messages);
    return {
      busy: Boolean(group.working || group.busyBotId),
      reply: latestReply(group.messages, (m) => m.from?.name ?? group.name),
      approval: approval
        ? { id: approval.requestId, name: approval.message.from?.name ?? speaker?.name ?? group.name }
        : undefined,
      question: question
        ? { id: question.id, name: question.message.from?.name ?? speaker?.name ?? group.name }
        : undefined,
    };
  }, [group.messages, group.working, group.busyBotId, group.name, speaker?.name]);
  const presenceSpeaker =
    speaker ?? awaited ?? members.find((member) => member.id === popping?.botId) ?? members[0];

  const unreadSince = useUnreadBoundary(roomThreadKey(group), group.messages);
  const unreadRow = useCallback((message: Message) => isUnread(message, unreadSince), [unreadSince]);
  const {
    scrollRef,
    transcriptRef,
    transcriptKey,
    following,
    followingRef,
    windowedMessages,
    filledMessages,
    hiddenCount,
    laterCount,
    olderPending,
    showEarlier,
    showLater,
    loadOlder,
    jumpToLatest,
    scrollHandlers,
  } = useTranscriptViewport({
    ownerId: group.id,
    threadId: group.threadId,
    messages: group.messages,
    pinOn: [group.busyBotId, group.working, composerDock.pad],
    counts: countsInWindow,
    unread: unreadRow,
  });

  useScrollAnchor(scrollRef, transcriptRef, followingRef, true);
  useEffect(() => setMembersOpen(false), [group.id]);

  const memberDogs = members.map((b) => {
    const busy = group.busyBotId === b.id;
    const task = b.tasks?.find((candidate) => candidate.threadId === group.threadId);
    const effective = busy ? effectivePlace(b, task) : "off";
    const showPlace = busy && effective !== "off" && effective !== "auto";
    return (
      <span
        key={b.id}
        title={`${b.name}${busy ? " — working…" : ""}`}
        className="relative inline-flex rounded-full"
      >
        <BotAvatar bot={b} state={busy ? "thinking" : normalizeState(b.mascotExpression) ?? "happy"} size={24} animated={busy} />
        {busy && showPlace && (
          <span
            className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border border-app bg-accent text-accent-ink"
            role="img"
            aria-label={t("place.chipAria", { place: t(placeLabelKey(effective)) })}
          >
            <PlaceIcon place={effective} size={9} strokeWidth={2.5} aria-hidden="true" />
          </span>
        )}
      </span>
    );
  });

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <ExchangeViewHost botId={group.id} />
      {membersOpen && !group.dm && (
        <ManageMembersPanel group={group} onClose={closeMembers} triggerRef={membersTriggerRef} />
      )}
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      <GlassBar edge="top" className="z-[25]">
      <div
        style={headerDragStyle}
        className={cn(
          "@container/roomhead px-5 py-3",
          "pl-11 md:pl-5",
        )}
      >
        <div data-roomhead-row className="flex items-center justify-between @max-3xl/roomhead:flex-wrap @max-3xl/roomhead:gap-y-1">
        <div data-roomhead-identity className="flex min-w-0 items-center gap-2 @max-3xl/roomhead:basis-full" style={headerNoDragStyle}>
          <span className="truncate text-[15px] font-semibold text-ink">{group.name}</span>
          <WorkStatusLine bot={{ busy: Boolean(group.working), work: group.work }} />
        </div>
        <div
          data-roomhead-controls
          className="flex items-center gap-1.5 @max-3xl/roomhead:ml-auto @max-3xl/roomhead:flex-wrap @max-3xl/roomhead:justify-end"
          style={controlsShiftStyle}
        >
          <button
            type="button"
            onClick={() => setFindOpen((open) => !open)}
            aria-label={t("chat.find")}
            aria-pressed={findOpen}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              findOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.findShortcut")}
          >
            <Search size={18} />
          </button>
          <ExportTranscriptMenu
            title={group.name}
            messages={group.messages}
            isGroup
          />
          {group.dm ? (
            memberDogs
          ) : (
            <button
              ref={membersTriggerRef}
              type="button"
              onClick={() => setMembersOpen(true)}
              title={t("room.members.manage")}
              aria-label={
                members.length === 1
                  ? t("room.members.ariaOne")
                  : t("room.members.ariaMany", { count: members.length })
              }
              className="flex items-center gap-1.5 rounded-full py-0.5 pl-1 pr-1.5 hover:bg-raised/60"
            >
              {memberDogs}
              <span data-room-add-member className="flex size-6 items-center justify-center rounded-full border border-dashed border-hairline/70 text-ink-secondary">
                <Plus size={13} />
              </span>
            </button>
          )}
        </div>
        </div>
      </div>

      {findOpen && <ChatFindBar threadId={group.threadId} onClose={() => setFindOpen(false)} />}

      </GlassBar>

      <div
        ref={scrollRef}
        className="glass-scroller h-full overflow-x-hidden overflow-y-auto px-5 [overflow-anchor:none]"
        {...scrollHandlers}
      >
        <div
          ref={transcriptRef}
          className="glass-scroller-content flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          aria-live="off"
          aria-label={t("room.aria", { name: group.name })}
        >
          {group.messages.length === 0 && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
              <div className="flex -space-x-2">
                {members.slice(0, 3).map((b) => (
                  <BotAvatar
                    key={b.id}
                    bot={b}
                    state="happy"
                    size={44}
                    motion="none"
                    motionKey={0}
                    animated={false}
                  />
                ))}
              </div>
              <div className="text-[17px] font-semibold text-ink">{group.name}</div>
              <div className="max-w-[380px] text-[14px] text-ink-secondary">
                {groupResponseHint(group, members, { jevOn: jevRoomRoutingOn(config) })}
              </div>
            </div>
          )}
          {hiddenCount > 0 ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showEarlier", { count: hiddenCount })}
              </button>
            </div>
          ) : group.hasMore ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={loadOlder}
                disabled={olderPending}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink disabled:opacity-60"
              >
                {olderPending ? t("chat.loadingEarlier") : t("chat.loadEarlier")}
              </button>
            </div>
          ) : null}
          <TranscriptRows
            group={group}
            members={members}
            locale={activeLocale()}
            messages={windowedMessages}
            filledWindow={filledMessages}
            transcript={group.messages}
            emergingId={popping?.id}
            onReply={selectReply}
            unreadSince={unreadSince}
          />
          {laterCount > 0 && (
            <div className="flex justify-center">
              <button
                onClick={showLater}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showLater", { count: laterCount })}
              </button>
            </div>
          )}
          {(speaker || presenceVisible) && (
            <TurnPresence
              threadId={group.threadId}
              botId={presenceSpeaker?.id}
              color={presenceSpeaker?.color}
              bodyId={presenceSpeaker?.mascotBody}
              selection={presenceSpeaker?.modelSelection}
              avatar={
                <BotAvatar
                  bot={presenceSpeaker ?? { color: "yellow" }}
                  state={toolInFlight && !awaited ? "working" : "thinking"}
                  size={36}
                  forward={false}
                  lookAround={1}
                  trackPointer={false}
                />
              }
              visible={presenceVisible}
              label={groupActivity.spoken ?? undefined}
              kind={groupActivity.kind}
              answering={popping !== null}
              since={speaker ? group.turnStartedAt ?? null : null}
            />
          )}
        </div>
      </div>

      <TranscriptAnnouncer threadKey={transcriptKey} snapshot={announcement} />

      {!following && (
        <button
          onClick={jumpToLatest}
          aria-label={t("chat.jumpToLatestAria")}
          className="animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-hairline/40 bg-raised px-3 py-1.5 text-[12.5px] text-ink shadow-lg hover:bg-raised-hover"
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> {t("chat.jumpToLatest")}
        </button>
      )}

      <div ref={composerDockRef} className="absolute inset-x-0 bottom-0 z-[2]">
      <PaneErrorLine panes={[chatPane(group.threadId)]} look="tray" />
      <Composer
        key={group.threadId}
        group={group}
        members={members}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
      />
      <CitationSelectionToolbar
        key={`${group.id}:${group.threadId}`}
        viewportRef={scrollRef}
        onAdd={(citation) => appendDraftAttachments(`group:${citation.source.ownerId}:${citation.source.threadId}`, [citation])}
      />
      </div>
      </GlassScrollFrame>
    </main>
  );
}
