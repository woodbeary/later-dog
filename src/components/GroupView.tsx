import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { activeLocale, t } from "@/lib/i18n";
import { ArrowDown, ChevronRight, MessageSquareReply, Plus, Search } from "lucide-react";
import {
  useStore,
  formatTime,
  type Bot,
  type Group,
  type Message,
} from "@/state/store";
import { BotAvatar } from "./Avatar";
import { PlaceIcon } from "./PlaceIcon";
import { ScreenFrame } from "./ScreenFrame";
import { effectivePlace, placeLabelKey } from "@/lib/place";
import { CloudTaskCard, CloudTaskUpdateRow } from "./CloudTaskCard";
import { cloudWakeupOf } from "@/lib/cloud-tasks";
import { ToolActivity } from "./ToolActivity";
import { MentionText } from "./MentionText";
import { plainThreadLinks } from "@/lib/thread-refs";
import { freshenDogName } from "@/lib/dog-refs";
import { singleExchange } from "@/lib/quiet-lines";
import { ExchangeLine, PlainNoteLine, QuietLine } from "./QuietLines";
import { ExchangeViewHost } from "./ExchangeViewHost";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { isUnread, useUnreadBoundary } from "@/lib/unread-boundary";
import { UnreadDivider } from "./UnreadDivider";
import { StatusDot } from "./StatusDot";
import { useScrollAnchor } from "@/lib/scroll-anchor";
import { CompactionChip, DigestChip } from "./DigestChip";
import { roomActivityVisible, transcriptRowShown } from "@/lib/room-activity";
import { StatusActivityRow } from "@/components/StatusActivityRow";
import { DOG_COLORS, normalizeState } from "@/lib/mascot";
import { groupResponseHint, jevRoomRoutingOn } from "@/lib/group-routing";
import { ChatMarkdown } from "./ChatMarkdown";
import { FailedTurnRow } from "./ChatView";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { CitationSelectionToolbar, SentCitations } from "./CitationUI";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { MessageActions, messageActionClass } from "./MessageActions";
import { ReactionPicker } from "./ReactionPicker";
import { ReactionPills } from "./ReactionPills";
import { myReactions } from "@/lib/reactions";
import { canReactTo, reactToMessage } from "@/lib/react-to-message";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SecureFormCard } from "./SecureFormCard";
import { TakeoverCard } from "./TakeoverCard";
import { RoutineRunCard } from "./RoutineRunCard";
import { ownerShowingElsewhere } from "@/lib/open-elsewhere";
import { AttachmentGallery, MessageAttachmentGallery } from "./AttachmentGallery";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { OptionCard } from "./OptionCard";

import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { ManageMembersPanel } from "./ManageMembersPanel";
import { groupActivityRuns, isStatusActivity } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { useCaptionChrome } from "./DesktopCapabilities";
import { cn } from "@/lib/cn";
import { OPTIMISTIC_PREFIX } from "@/lib/dog-status";
import { SendingTrack } from "./SendingTrack";
import { useComposerDockPad } from "@/lib/composer-dock";
import { GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { awaitedMemberId, showWorkingDots } from "@/lib/turn-tail";
import { liveActivity } from "@/lib/live-activity";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { appendDraftAttachments, useReplyDraft } from "@/lib/drafts";
import { splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { highlightCitationSource } from "@/lib/citations-dom";
import { latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { openQuestion } from "@/lib/open-question";
import { pendingApprovals } from "./PendingApproval";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";
import { QueuedBubbles } from "./QueuedBubbles";
import { dayLabel, localDay } from "@/lib/transcript-derivations";

export function RoomToolChip({ message, roomId }: { message: Message; roomId?: string }) {
  const { state, dispatch } = useStore();
  const tool = message.tool;
  if (!tool) return null;
  if (message.cloudTask) return <CloudTaskCard message={message} />;
  if (message.threadRef) return <PlainNoteLine message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    return <FailedTurnRow tool={tool} engine={botEngine(state.bots.find((b) => b.id === message.from?.botId), state.instances)} botId={message.from?.botId} />;
  }
  const solo = singleExchange(message);
  if (solo && !(solo.target.kind === "group" && solo.target.groupId === roomId)) return <ExchangeLine item={solo} />;
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    const withBot = state.bots.find((b) => b.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          type="button"
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={t("room.openBot", { name: comm.withName })}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />
          <span className="max-w-[480px] truncate">{freshenDogName(tool.name, withBot)}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  if (!comm) return <ToolActivity tool={tool} />;
  return (
    <div className="flex justify-start">
      <div
        className={cn(
          "flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px]",
          tool.ok === false ? "text-danger" : "text-ink-secondary",
        )}
      >
        {comm && <BotAvatar bot={state.bots.find(b => b.id === comm.withBotId) ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{freshenDogName(tool.name, state.bots.find((b) => b.id === comm.withBotId))}</span>
      </div>
    </div>
  );
}

function ClusterLabel({ bot, name, color, tinted = false }: { bot?: Bot; name: string; color: string; tinted?: boolean }) {
  const tint = tinted && Object.hasOwn(DOG_COLORS, color) ? DOG_COLORS[color as Bot["color"]] : undefined;
  return (
    <div className="mt-1 flex items-center gap-1.5 pl-0.5">
      <BotAvatar
        bot={bot ?? { name, color: color as Bot["color"] }}
        state={normalizeState(bot?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span
        className={cn("font-medium", tint ? "text-[12px]" : "text-[11px] text-ink-secondary")}
        style={tint ? { color: `color-mix(in oklab, ${tint} 72%, var(--color-ink))` } : undefined}
      >
        {name}
      </span>
    </div>
  );
}

function RoomMessageActions({ side, message, threadId, onReply }: {
  side: "user" | "bot";
  message: Message;
  threadId: string;
  onReply: (message: Message) => void;
}) {
  const { dispatch } = useStore();
  const [picking, setPicking] = useState(false);
  return (
    <MessageActions side={side} forceOpen={picking}>
      {canReactTo(message) && (
        <ReactionPicker
          reacted={myReactions(message.reactions)}
          onReact={(emoji) => void reactToMessage(dispatch, threadId, message, emoji)}
          onOpenChange={setPicking}
          align={side === "user" ? "end" : "start"}
        />
      )}
      <button
        type="button"
        onClick={() => onReply(message)}
        aria-label={t("chat.replyToMessage")}
        title={t("chat.reply")}
        className={messageActionClass}
      >
        <MessageSquareReply size={14} />
      </button>
    </MessageActions>
  );
}

export const Transcript = memo(function Transcript({
  group,
  members,
  messages,
  transcript,
  emergingId,
  onReply,
  readOnly = false,
}: {
  group: Group;
  members: Bot[];
  locale: string;
  messages: Message[];
  transcript: Message[];
  emergingId?: string | null;
  onReply: (message: Message) => void;
  readOnly?: boolean;
}) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  const items = useMemo(() => groupActivityRuns(messages.filter(message =>
    message.kind !== "activity" || roomActivityVisible(message, showToolCalls))), [messages, showToolCalls]);
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  const unreadSince = useUnreadBoundary(`room/${group.id}/${group.threadId}`, messages);
  let unreadPlaced = false;
  const unreadDivider = (rows: readonly Message[]) => {
    if (unreadPlaced || !rows.some((row) => isUnread(row, unreadSince))) return null;
    unreadPlaced = true;
    return <UnreadDivider />;
  };
  const focus = state.focusMessage;
  const focusedId = focus && !focus.consumed && focus.threadId === group.threadId ? focus.messageId : null;
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "message" ? previous.message : previous.messages.at(-1));
        const first = item.kind === "message" ? item.message : item.messages[0];
        const newDay = !prev || localDay(prev.at) !== localDay(first.at);
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          const cluster = !prev || prev.role !== first.role || prev.from?.botId !== first.from?.botId || newDay;
          return (
            <div key={item.id} className="contents">
              {newDay && (
                <div className="py-3 text-center text-[13px] text-ink-secondary">
                  {dayLabel(first.at)} {formatTime(first.at)}
                </div>
              )}
              {unreadDivider(item.messages)}
              {first.from && cluster && (
                <ClusterLabel bot={memberOf(first.from.botId)} name={memberOf(first.from.botId)?.name ?? first.from.name} color={memberOf(first.from.botId)?.color ?? first.from.color} tinted={readOnly} />
              )}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id}>
                    <RoomToolChip message={step} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        if (cloudWakeupOf(m)) return <div key={m.id} className="contents" data-mid={m.id}>{unreadDivider([m])}<CloudTaskUpdateRow message={m} /></div>;
        const user = m.role === "user";
        const cited = user && m.text ? splitTranscriptCitations(m.text) : null;
        const attachments = user && m.text ? splitTranscriptAttachments(cited?.display ?? m.text) : null;
        const sentImages = attachments?.images ?? [];
        const sentFiles = attachments?.files ?? [];
        const sentAttachments = sentImages.length + sentFiles.length > 0;
        const sentWords = Boolean((attachments?.display ?? m.text ?? "").trim());
        const sentAbove = sentAttachments && sentWords;
        const sentOnly = sentAttachments && !sentWords && !m.replyToId;
        const newCluster = !prev || prev.role !== m.role || prev.from?.botId !== m.from?.botId || Boolean(prev.comm) || newDay;
        const routineTarget = m.kind === "routine.run"
          ? ownerShowingElsewhere([...state.bots, ...state.groups], m.routineRun?.executionThreadId, group.id)
          : undefined;
        const row =
          m.kind === "secret" && m.secureForm && m.from?.botId ? (
            <SecureFormCard botId={m.from.botId} botName={memberOf(m.from.botId)?.name ?? m.from.name} threadId={group.threadId} message={m} />
          ) : m.kind === "secret" && m.secret && m.from?.botId ? (
            <SecretRequestCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "connector" && m.connector && m.from?.botId ? (
            <ConnectorCard botId={m.from.botId} threadId={group.threadId} message={m} />
          ) : m.kind === "options" && m.card?.takeoverRequest && m.from?.botId ? (
            <TakeoverCard botId={m.from.botId} botName={memberOf(m.from.botId)?.name ?? m.from.name} threadId={group.threadId} message={m} />
          ) : m.kind === "options" && m.card?.requestId && m.card.questionRequest ? (
            <div className="flex justify-start">
              <QuestionCard threadId={group.threadId} bot={memberOf(m.from?.botId)} message={m} />
            </div>
          ) : m.kind === "options" && m.card?.requestId && m.card.tool ? (
            <div className="flex justify-start">
              <ApprovalCard bot={memberOf(m.from?.botId)} message={m} threadId={group.threadId} />
            </div>
          ) : m.kind === "options" && m.card && m.from?.botId ? (
            <div className="flex justify-start">
              <OptionCard botId={m.from.botId} threadId={group.threadId} groupId={group.id} message={m} />
            </div>
          ) : m.kind === "goal.run" ? (
            m.text ? <QuietLine kind="note">{m.text}</QuietLine> : null
          ) : m.kind === "routine.run" ? (
            <div className="flex justify-start">
              <RoutineRunCard
                message={m}
                onOpen={routineTarget ? () => dispatch({ type: "select", id: routineTarget.id }) : undefined}
              />
            </div>
          ) : m.kind === "activity" && m.tool ? (
            roomActivityVisible(m, showToolCalls) ? (
              isStatusActivity(m) ? <StatusActivityRow message={m} /> : <RoomToolChip message={m} roomId={group.id} />
            ) : null
          ) : m.kind === "screen" ? (
            <ScreenFrame threadId={group.threadId} message={m} />
          ) : m.kind === "compaction" ? (
            <CompactionChip message={m} />
          ) : m.kind === "digest" ? (
            showToolCalls ? <DigestChip message={m} /> : null
          ) : m.kind === "text" && (m.text || m.attachments?.length) ? (
            <div data-from={user ? "user" : "agent"} className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
              {sentAbove && (
                <AttachmentGallery sent images={sentImages} files={sentFiles} message={{ threadId: group.threadId, messageId: m.id }} eager={m.id === newestMessageId || m.id === newestUserMessageId} className="mb-1.5 max-w-[min(42rem,78%)]" />
              )}
              <div className={cn("flex w-full items-end gap-1.5", user ? "justify-end" : "justify-start")}>
                {user && !readOnly && <RoomMessageActions side="user" message={m} threadId={group.threadId} onReply={onReply} />}
                <div
                  data-chat-bubble
                  className={cn(
                    "w-fit max-w-[min(42rem,78%)] rounded-bubble text-[14px] leading-[21px]",
                    !user && m.id === emergingId && "turn-answer",
                    (user ? sentOnly : !m.text?.trim() && !m.replyToId && m.attachments?.length)
                      ? "text-ink"
                      : user ? "chat-text whitespace-pre-wrap bg-bubble-user px-3 py-[7px] text-ink" : "bg-card px-3 py-[7px] text-ink",
                  )}
                  title={new Date(m.at).toLocaleString()}
                >
                  {m.replyToId && (() => {
                    const target = transcript.find((candidate) => candidate.id === m.replyToId);
                    return target ? (
                      <div className="mb-2">
                        <ReplyQuote
                          message={target}
                          fallbackName={t("room.fallbackBot")}
                          compact
                          onJump={() =>
                            dispatch({ type: "focusMessage", threadId: group.threadId, messageId: target.id })
                          }
                        />
                      </div>
                    ) : null;
                  })()}
                  {user ? (
                    <>
                      {sentAttachments && !sentAbove && (
                        <AttachmentGallery sent images={sentImages} files={sentFiles} message={{ threadId: group.threadId, messageId: m.id }} eager={m.id === newestMessageId || m.id === newestUserMessageId} />
                      )}
                      <div
                        data-citation-source={m.id}
                        data-citation-owner-type="group"
                        data-citation-owner={group.id}
                        data-citation-thread={group.threadId}
                      >
                        <MentionText text={plainThreadLinks(attachments?.display ?? m.text ?? "")} peers={members} everyone={!group.dm} faces />
                      </div>
                      {cited && <SentCitations
                        citations={cited.citations}
                        onNavigate={async (citation: CitationAttachment) => {
                          if (citation.source.ownerType !== "group" || !group.messages.some((candidate) => candidate.id === citation.source.messageId)) return false;
                          dispatch({ type: "focusMessage", threadId: group.threadId, messageId: citation.source.messageId });
                          return highlightCitationSource(citation);
                        }}
                      />}
                    </>
                  ) : (
                    <>
                      {(m.attachments ?? []).some((attachment) => attachment.kind === "audio") && (
                        <div className={cn("flex flex-col", (m.text || (m.attachments ?? []).some((attachment) => attachment.kind === "image")) && "mb-2")}>
                          {m.attachments!.filter((attachment): attachment is VoiceNoteAttachment => attachment.kind === "audio").map((note) => (
                            <VoiceNoteBubble key={note.path} attachment={note} />
                          ))}
                        </div>
                      )}
                      <MessageAttachmentGallery text={m.text ?? ""} attachments={m.attachments} message={{ threadId: group.threadId, messageId: m.id }} className={m.text ? undefined : "mb-0"} eager={m.id === newestMessageId || m.id === newestUserMessageId} />
                      {m.text ? <div data-citation-source={m.id} data-citation-owner-type="group" data-citation-owner={group.id} data-citation-thread={group.threadId}><ChatMarkdown text={m.text} mentionPeers={members} everyone={!group.dm} message={{ threadId: group.threadId, messageId: m.id }} /></div> : null}
                    </>
                  )}
                </div>
                {!user && !readOnly && <RoomMessageActions side="bot" message={m} threadId={group.threadId} onReply={onReply} />}
                <span className="self-end pb-1 text-[11px] tabular-nums text-ink-tertiary opacity-0 transition-opacity group-hover:opacity-100">
                  {formatTime(m.at)}
                </span>
              </div>
              <ReactionPills
                reactions={m.reactions}
                side={user ? "user" : "bot"}
                nameOf={(by) => memberOf(by)?.name ?? (by === m.from?.botId ? m.from.name : by)}
                onToggle={!readOnly && canReactTo(m) ? (emoji) => void reactToMessage(dispatch, group.threadId, m, emoji) : undefined}
              />
              {user && m.id.startsWith(OPTIMISTIC_PREFIX) && <SendingTrack at={m.at} />}
            </div>
          ) : null;
        if (!row) return null;
        return (
          <div key={m.id} className="contents" data-mid={m.id}>
            {newDay && (
              <div className="py-3 text-center text-[13px] text-ink-secondary">
                {dayLabel(m.at)} {formatTime(m.at)}
              </div>
            )}
            {unreadDivider([m])}
            {!user && m.from && newCluster && !(m.kind === "activity" && m.comm) && (
              <ClusterLabel bot={memberOf(m.from.botId)} name={memberOf(m.from.botId)?.name ?? m.from.name} color={memberOf(m.from.botId)?.color ?? m.from.color} tinted={readOnly} />
            )}
            {row}
          </div>
        );
      })}
    </>
  );
});

export function GroupView({ group }: { group: Group }) {
  const { state, dispatch } = useStore();
  const showToolCalls = showToolCallsEnabled(state.config);
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  const members = useMemo(
    () => group.memberIds.map((id) => state.bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)),
    [group.memberIds, state.bots],
  );
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

  const {
    scrollRef,
    transcriptRef,
    transcriptKey,
    following,
    followingRef,
    windowedMessages,
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
        className={cn(
          "relative inline-flex rounded-full",
          busy && "ring-2 ring-accent/50 ring-offset-1 ring-offset-app",
        )}
      >
        <BotAvatar bot={b} state={normalizeState(b.mascotExpression) ?? "happy"} size={24} animated={false} />
        {busy && (
          showPlace ? (
            <span
              className="absolute -right-1 -top-1 flex size-3.5 items-center justify-center rounded-full border border-app bg-accent text-white"
              role="img"
              aria-label={t("place.chipAria", { place: t(placeLabelKey(effective)) })}
            >
              <PlaceIcon place={effective} size={9} strokeWidth={2.5} aria-hidden="true" />
            </span>
          ) : (
            <StatusDot kind="working" ring="border-app" size="size-2.5" announce={false} />
          )
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
              <span className="flex size-[18px] items-center justify-center rounded-full border border-dashed border-hairline/70 text-ink-secondary">
                <Plus size={11} />
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
                {groupResponseHint(group, members, { jevOn: jevRoomRoutingOn(state.config) })}
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
          <Transcript
            group={group}
            members={members}
            locale={activeLocale()}
            messages={windowedMessages}
            transcript={group.messages}
            emergingId={popping?.id}
            onReply={selectReply}
          />
          <QueuedBubbles
            items={state.pendingQueued[group.threadId] ?? []}
            onCancel={(queueId) => dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId: group.threadId, queueId })}
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
              color={presenceSpeaker?.color}
              bodyId={presenceSpeaker?.mascotBody}
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
