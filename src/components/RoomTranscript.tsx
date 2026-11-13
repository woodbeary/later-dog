import { Fragment, memo, useMemo, useState } from "react";
import { t } from "@/lib/i18n";
import { ChevronRight, MessageSquareReply } from "lucide-react";
import {
  formatTime,
  type Bot,
  type Group,
  type Message,
} from "@/state/store";
import { useDogsApartFromMessages, useRoomsApartFromMessages, useStoreDispatch, useStoreSelector } from "@/state/store-selectors";
import { BotAvatar } from "./Avatar";
import { ScreenFrame } from "./ScreenFrame";
import { CloudTaskCard, CloudTaskUpdateRow } from "./CloudTaskCard";
import { cloudWakeupOf } from "@/lib/cloud-tasks";
import { ToolActivity } from "./ToolActivity";
import { MentionText } from "./MentionText";
import { plainThreadLinks } from "@/lib/thread-refs";
import { freshenDogName } from "@/lib/dog-refs";
import { singleExchange } from "@/lib/quiet-lines";
import { ExchangeLine, PlainNoteLine, QuietLine } from "./QuietLines";
import { NativeWork, NativeWorkFallbacks, NativeHistoryNotice } from "./NativeWork";
import { nativeReceiptAnchors, useNativeRuns } from "@/lib/native-runs-state";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { isUnread, useUnreadBoundary } from "@/lib/unread-boundary";
import { UnreadDivider } from "./UnreadDivider";
import { CompactionChip, DigestChip } from "./DigestChip";
import { roomActivityVisible } from "@/lib/room-activity";
import { StatusActivityRow } from "@/components/StatusActivityRow";
import { DOG_COLORS, normalizeState } from "@/lib/mascot";
import { ChatMarkdown } from "./ChatMarkdown";
import { FailedTurnRow } from "./FailedTurnRow";
import { botEngine, failedTurnCause } from "@/lib/failed-turn";
import { SentCitations } from "./CitationUI";
import { ReplyQuote } from "./ReplyQuote";
import { MessageActions, messageActionClass } from "./MessageActions";
import { ReactionPicker } from "./ReactionPicker";
import { hasTapback, ReactionPills } from "./ReactionPills";
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
import { groupActivityRuns, isStatusActivity } from "@/lib/activity-runs";
import { ActivityRun } from "./ActivityRun";
import { cn } from "@/lib/cn";
import { OPTIMISTIC_PREFIX } from "@/lib/dog-status";
import { SendingTrack } from "./SendingTrack";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { highlightCitationSource } from "@/lib/citations-dom";
import { dayLabel, localDay } from "@/lib/transcript-derivations";

export function RoomToolChip({ message, roomId }: { message: Message; roomId?: string }) {
  const dispatch = useStoreDispatch();
  const dogs = useDogsApartFromMessages();
  const instances = useStoreSelector((state) => state.instances);
  const tool = message.tool;
  if (!tool) return null;
  if (message.cloudTask) return <CloudTaskCard message={message} />;
  if (message.threadRef) return <PlainNoteLine message={message} />;
  if (failedTurnCause(tool.name) !== null) {
    return <FailedTurnRow tool={tool} engine={botEngine(dogs.find((b) => b.id === message.from?.botId), instances)} botId={message.from?.botId} />;
  }
  const solo = singleExchange(message);
  if (solo && !(solo.target.kind === "group" && solo.target.groupId === roomId)) return <ExchangeLine item={solo} />;
  const comm = message.comm;
  if (comm && comm.groupId !== roomId) {
    const withBot = dogs.find((b) => b.id === comm.withBotId);
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
        {comm && <BotAvatar bot={dogs.find(b => b.id === comm.withBotId) ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />}
        <span className={cn("max-w-[480px] truncate", !comm && "font-mono")}>{freshenDogName(tool.name, dogs.find((b) => b.id === comm.withBotId))}</span>
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
  const dispatch = useStoreDispatch();
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

interface TranscriptProps {
  group: Group;
  members: Bot[];
  locale: string;
  messages: Message[];
  filledWindow?: Message[];
  transcript: Message[];
  emergingId?: string | null;
  onReply: (message: Message) => void;
  readOnly?: boolean;
}

export const roomThreadKey = (group: Group) => `room/${group.id}/${group.threadId}`;

export const Transcript = memo(function Transcript(props: TranscriptProps) {
  const unreadSince = useUnreadBoundary(roomThreadKey(props.group), props.messages);
  return <TranscriptRows {...props} unreadSince={unreadSince} />;
});

export const TranscriptRows = memo(function TranscriptRows({
  group,
  members,
  messages,
  filledWindow = messages,
  transcript,
  emergingId,
  onReply,
  readOnly = false,
  unreadSince,
}: TranscriptProps & { unreadSince: number | null }) {
  const dispatch = useStoreDispatch();
  const dogs = useDogsApartFromMessages();
  const rooms = useRoomsApartFromMessages();
  const showToolCalls = useStoreSelector((state) => showToolCallsEnabled(state.config));
  const focus = useStoreSelector((state) => (state.focusMessage?.threadId === group.threadId ? state.focusMessage : null));
  const nativeRuns = useNativeRuns(group.threadId, filledWindow[0]?.at);
  const receipts = useMemo(() => nativeReceiptAnchors(nativeRuns, messages), [nativeRuns, messages]);
  const memberOf = (id?: string) => members.find((b) => b.id === id);
  const items = useMemo(() => groupActivityRuns(messages.filter(message =>
    message.kind !== "activity" || roomActivityVisible(message, showToolCalls))), [messages, showToolCalls]);
  const newestMessageId = messages.at(-1)?.id;
  const newestUserMessageId = [...messages].reverse().find((message) => message.role === "user")?.id;
  let unreadPlaced = false;
  const unreadDivider = (rows: readonly Message[]) => {
    if (unreadPlaced || !rows.some((row) => isUnread(row, unreadSince))) return null;
    unreadPlaced = true;
    return <UnreadDivider />;
  };
  const focusedId = focus && !focus.consumed ? focus.messageId : null;
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
          ? ownerShowingElsewhere([...dogs, ...rooms], m.routineRun?.executionThreadId, group.id)
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
            showToolCalls && !nativeRuns.some((run) => run.turnId === m.turnId) ? <DigestChip message={m} /> : null
          ) : m.kind === "text" && (m.text || m.attachments?.length) ? (
            <div data-from={user ? "user" : "agent"} className={cn("group flex w-full flex-col", user ? "items-end" : "items-start", hasTapback(m.reactions) && "pt-3")}>
              {sentAbove && (
                <AttachmentGallery sent images={sentImages} files={sentFiles} message={{ threadId: group.threadId, messageId: m.id }} eager={m.id === newestMessageId || m.id === newestUserMessageId} className="mb-1.5 max-w-[min(42rem,78%)]" />
              )}
              <div className={cn("flex w-full items-end gap-1.5", user ? "justify-end" : "justify-start")}>
                {user && !readOnly && <RoomMessageActions side="user" message={m} threadId={group.threadId} onReply={onReply} />}
                <div
                  data-chat-bubble
                  className={cn(
                    "relative w-fit max-w-[min(42rem,78%)] rounded-bubble text-[14px] leading-[21px]",
                    !user && m.id === emergingId && "turn-answer",
                    (user ? sentOnly : !m.text?.trim() && !m.replyToId && m.attachments?.length)
                      ? "text-ink"
                      : user ? "chat-text whitespace-pre-wrap bg-bubble-user px-3 py-[7px] text-ink" : "bg-card px-3 py-[7px] text-ink",
                  )}
                  title={new Date(m.at).toLocaleString()}
                >
                  <ReactionPills
                    reactions={m.reactions}
                    side={user ? "user" : "bot"}
                    nameOf={(by) => memberOf(by)?.name ?? (by === m.from?.botId ? m.from.name : by)}
                    onToggle={!readOnly && canReactTo(m) ? (emoji) => void reactToMessage(dispatch, group.threadId, m, emoji) : undefined}
                  />
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
              {user && m.id.startsWith(OPTIMISTIC_PREFIX) && <SendingTrack at={m.at} held={m.held} />}
            </div>
          ) : null;
        if (!row) return null;
        return (
          <Fragment key={m.id}>
            <div className="contents" data-mid={m.id}>
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
            {receipts.get(m.id)?.map(run => <NativeWork key={run.id} run={run} color={memberOf(run.botId ?? m.from?.botId)?.color} bodyId={memberOf(run.botId ?? m.from?.botId)?.mascotBody} />)}
          </Fragment>
        );
      })}
      <NativeWorkFallbacks runs={nativeRuns} messages={filledWindow} ownerForRun={run => memberOf(run.botId)} />
      <NativeHistoryNotice threadId={group.threadId} />
    </>
  );
});
