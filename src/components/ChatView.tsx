import { ModelPicker } from "./ModelPicker";
import { Component, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode } from "react";
import { useCopyFeedback } from "@/lib/copy-text";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Code,
  Copy,
  Crown,
  Download,
  Gauge,
  Hand,
  MessageSquareReply,
  Monitor,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  Volume2,
  Webhook,
  X,
} from "lucide-react";
import { WorkingDots } from "@/components/WorkingIndicator";
import { MessageActions, messageActionClass } from "@/components/MessageActions";
import { useSpeech } from "@/lib/tts/useSpeech";
import { localSystemVoiceActive } from "@/lib/local-voice";
import { computerStartLine } from "@/lib/computer-start";
import { useCaptionChrome, useDesktopCapabilities } from "@/components/DesktopCapabilities";
import { contextChip, contextDetail, contextShare, costCaption, formatUsd, hasFiniteCost, lastTurnDetail, usageChip, usageDetail } from "@/lib/usage";
import {
  currentTaskBot,
  useStore,
  formatTime,
  openNotificationTarget,
  openThread,
  visibleMessages,
  type Action,
  type Bot,
  type ConfigStatus,
  type InstanceInfo,
  type Message,
  type AppState,
} from "@/state/store";
import { EngineSetup } from "./EngineSetup";
import { CHATGPT_USAGE_URL } from "./ChatGptPlanStatus";
import { openExternalLink } from "@/lib/app-links";
import { ClaudeUpdatePrompt } from "./ClaudeUpdatePrompt";
import { LimitRow } from "./LimitRow";
import { MacCuaRecoveryActions } from "./MacCuaRecoveryActions";
import { macCuaPermissionMessage, missingMacCuaPermissions } from "@/lib/mac-cua-permissions";
import { failedTurnCause, signedOutEngine } from "@/lib/failed-turn";
import { openPlaceAction, placeRowViewFor, usePlaceSeat, worksOnSimpleLabel } from "@/lib/place-view";
import type { PlaceRow } from "../../shared/place-view";
import { isProviderSafetyBlock, PROVIDER_SAFETY_GUIDANCE, PROVIDER_SAFETY_HELP_URL } from "../../shared/provider-safety";
import { isOpenTakeover } from "../../shared/takeover";
import { BotAvatar } from "./Avatar";
import { TreatButton } from "./TreatButton";
import { TurnPresence } from "./TurnPresence";
import { showToolCallsEnabled } from "@/lib/feature-flags";
import { transcriptRowShown } from "@/lib/room-activity";
import { dogTint, normalizeState, restingStateForBot, turnState } from "@/lib/mascot";
import { peerLine, type PeerLine } from "@/lib/peer-message";
import { useWorkingDots } from "@/lib/working-dots";
import { MOTION } from "@/lib/motion";
import { useArrivals } from "@/lib/arrivals";
import { liveActivityLabel } from "@/lib/live-activity";
import { ChatMarkdown } from "./ChatMarkdown";
import { VoiceNoteBubble, type VoiceNoteAttachment } from "./VoiceNoteBubble";
import { RawMarkdownView, RawToggleAction } from "./RawMarkdownToggle";
import { ThreadChip } from "./ThreadChip";
import { CloudTaskCard, CloudTaskUpdateRow } from "./CloudTaskCard";
import { cloudWakeupOf } from "@/lib/cloud-tasks";
import { ToolActivity } from "./ToolActivity";
import { ThreadRefText } from "./ThreadRefs";
import { OptionCard, shouldHideOnboardingCard } from "./OptionCard";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { Composer } from "./Composer";
import { ChatFindBar } from "./ChatFindBar";
import { ReplyQuote } from "./ReplyQuote";
import { ConnectorCard } from "./ConnectorCard";
import { SecretRequestCard } from "./SecretRequestCard";
import { SecureFormCard } from "./SecureFormCard";
import { TakeoverCard } from "./TakeoverCard";
import { hasRoutineExecutionTask, RoutineRunCard } from "./RoutineRunCard";
import { AttachmentGallery, collectMessageFiles, splitMessageAttachments } from "./AttachmentGallery";
import { ScreenFrame } from "./ScreenFrame";
import { CompactionChip, DigestChip } from "./DigestChip";
import { BotActivityPicker } from "./TaskPicker";
import { SidebarPopoverMenu, type SidebarMenuItem } from "./SidebarPopoverMenu";
import { ShortcutHint } from "./ShortcutHint";
import {
  copyTranscriptToClipboard,
  downloadMarkdownTranscript,
  formatTranscriptMarkdown,
  slugifyTranscriptFilename,
} from "@/lib/export-transcript";
import { CitationSelectionToolbar, SentCitations } from "./CitationUI";

import { canSpeak, StopSpeakingButton } from "./SpeakButton";
import { speaker } from "@/lib/tts";
import { CallOverlay } from "./CallView";
import { LiveCallBar } from "./LiveCallBar";
import { LiveCallChip } from "./LiveCallPill";
import { effectivePlace, toolPlace, type EffectivePlace } from "@/lib/place";
import { cn } from "@/lib/cn";
import { activeLocale, t } from "@/lib/i18n";
import { groupTranscript, isStatusActivity, planTranscript, type TranscriptPlan } from "@/lib/activity-runs";
import { isUnread, useUnreadBoundary } from "@/lib/unread-boundary";
import { UnreadDivider } from "./UnreadDivider";
import { StatusActivityRow } from "@/components/StatusActivityRow";
import { ActivityRun } from "./ActivityRun";
import { TurnNarrationRun } from "./TurnNarrationRun";
import { webhookMessageView } from "@/lib/webhook-message";
import { splitTranscriptAttachments } from "@/lib/composer-attachments";
import { useComposerDockPad } from "@/lib/composer-dock";
import { GlassBar, GlassScrollFrame } from "./GlassScrollFrame";
import { useTranscriptViewport } from "@/hooks/use-transcript-viewport";
import { useNewBelow } from "@/lib/new-below";
import { appendDraftAttachments, useReplyDraft } from "@/lib/drafts";
import { dayLabel, localDay, transcriptLookups, type TranscriptLookups } from "@/lib/transcript-derivations";
import { citationPreviewText, splitTranscriptCitations, type CitationAttachment } from "@/lib/citations";
import { highlightCitationSource } from "@/lib/citations-dom";
import { useCanWriteIn } from "@/lib/cloud-guest";
import { latestReply, type TranscriptSnapshot } from "@/lib/transcript-announcer";
import { openQuestion } from "@/lib/open-question";
import { pendingApprovals } from "./PendingApproval";
import { TranscriptAnnouncer } from "./TranscriptAnnouncer";

const USER_COLLAPSE_CHARS = 600;
const newBelowLabel = (count: number) => count === 1 ? t("chat.newBelowOne") : t("chat.newBelowMany", { count });
const USER_COLLAPSE_LINES = 8;

interface ChatRows {
  botId: string;
  threadId: string;
  botName: string;
  voiceId?: string;
  tts: ConfigStatus["tts"];
  localVoice: boolean;
  busy: boolean;
  bots: readonly Bot[];
  mentionPeers: readonly Bot[];
  focus: AppState["focusMessage"];
  showToolCalls: boolean;
  locale: string;
  dispatch: Dispatch<Action>;
  onBranch: (messageId: string) => boolean;
}

const ChatRowsContext = createContext<ChatRows | null>(null);

function useChatRows(): ChatRows {
  const rows = useContext(ChatRowsContext);
  if (!rows) throw new Error("a chat row outside ChatView");
  return rows;
}

const drawnBot = (bot: Bot) =>
  [bot.id, bot.name, bot.hidden, bot.color, bot.mascotBody, bot.mascotExpression, bot.avatarUrl, bot.avatarCrop, bot.avatarZoom, bot.avatarFocusX, bot.avatarFocusY].join("\u0001");

function useDrawnBots(bots: readonly Bot[]): readonly Bot[] {
  const signature = bots.map(drawnBot).join("\u0002");
  const cache = useRef({ signature, bots });
  if (cache.current.signature !== signature) cache.current = { signature, bots };
  return cache.current.bots;
}

function DaySeparator({ at, today }: { at: number; today: number }) {
  return (
    <div className="py-3 text-center text-[13px] text-ink-secondary">
      {dayLabel(at, today)} {formatTime(at)}
    </div>
  );
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const { state, copy } = useCopyFeedback(text);
  const label = t(state === "copied" ? "chat.copyMessageDone" : state === "failed" ? "chat.copyMessageFailed" : "chat.copyMessage");
  return (
    <button
      onClick={copy}
      aria-label={label}
      title={label}
      className={cn(
        "rounded-md p-1.5 text-ink-secondary opacity-0 transition-opacity hover:bg-raised hover:text-ink focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 touch:opacity-100",
        state !== "idle" && "opacity-100",
        className,
      )}
    >
      {state === "copied" ? <Check size={14} className="text-success" /> : state === "failed" ? <X size={14} className="text-danger" /> : <Copy size={14} />}
    </button>
  );
}

export function ErrorRow({
  message,
  headline: plainHeadline,
  onRetry,
  action,
  setupInstance,
  claudeUpdateInstance,
}: {
  message: string;
  headline?: string;
  onRetry?: () => void;
  action?: { label: string; onClick: () => void } | null;
  setupInstance?: InstanceInfo;
  claudeUpdateInstance?: InstanceInfo;
}) {
  const { capabilities, ready } = useDesktopCapabilities();
  const failedPermissions = missingMacCuaPermissions(message);
  const currentPermissions = missingMacCuaPermissions(capabilities.localComputer.message);
  const macCuaReason = ready && capabilities.host.platform === "darwin" &&
    capabilities.localComputer.available === false && capabilities.localComputer.reasonCode !== "remote-server" &&
    message.startsWith("CUA Driver is not ready for this computer — ") &&
    failedPermissions.length > 0 && failedPermissions.join(",") === currentPermissions.join(",")
    ? macCuaPermissionMessage(currentPermissions)
    : null;
  const headline = macCuaReason ?? plainHeadline ?? message;
  return (
    <div className="flex justify-start">
      <div data-turn-error className="w-fit max-w-[min(42rem,78%)] rounded-[18px] bg-card px-3 py-[7px] text-[14px] leading-[21px] text-ink">
        <div className="flex items-start gap-2">
          <AlertTriangle size={14} className="mt-[3.5px] shrink-0 text-ink-secondary" />
          <span className="min-w-0 break-words">{headline}</span>
        </div>
        {headline !== message && <details className="mt-2 text-[12px] text-ink-secondary"><summary className="cursor-pointer">{macCuaReason ? t("computer.mac.permission.driverDetail") : t("chat.error.details")}</summary><p className="mt-1 break-words">{message}</p></details>}
        {macCuaReason &&
          <MacCuaRecoveryActions reason={message} />}
        {message.includes("subscription_sharing_usage_limit_exceeded") ? (
          <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex rounded-lg bg-ink px-3 py-1.5 text-[12.5px] font-medium text-app" onClick={(event) => {
            if (window.laterdog?.openExternal) { event.preventDefault(); void openExternalLink(CHATGPT_USAGE_URL); }
          }}>{t("engineSetup.chatgpt.manageUsage")}</a>
        ) : claudeUpdateInstance ? (
          <ClaudeUpdatePrompt instance={claudeUpdateInstance} onRetry={onRetry} />
        ) : isProviderSafetyBlock(message) ? (
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
            {PROVIDER_SAFETY_GUIDANCE}{" "}
            <a href={PROVIDER_SAFETY_HELP_URL} target="_blank" rel="noreferrer" className="underline transition-opacity hover:opacity-80">About provider safety checks</a>
          </p>
        ) : setupInstance &&
        !(setupInstance.snapshot.state === "available" && setupInstance.snapshot.authenticated !== false) ? (
          <EngineSetup instance={setupInstance} className="mt-2 text-ink-secondary" />
        ) : action !== undefined ? (
          action && (
            <button
              type="button"
              onClick={action.onClick}
              className="mt-1.5 mb-0.5 flex items-center gap-1.5 rounded-full bg-control px-3 py-1 text-[13px] text-ink hover:bg-control-hover"
            >
              {action.label}
            </button>
          )
        ) : (
          onRetry && (
            <button
              onClick={onRetry}
              className="mt-1.5 mb-0.5 flex items-center gap-1.5 rounded-full bg-control px-3 py-1 text-[13px] text-ink hover:bg-control-hover"
            >
              <RefreshCw size={12} /> {t("chat.retry")}
            </button>
          )
        )}
      </div>
    </div>
  );
}

function PlaceFailedRow({ place, botId, threadId, onRetry }: {
  place: PlaceRow;
  botId: string;
  threadId?: string;
  onRetry?: () => void;
}) {
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const seat = usePlaceSeat(state.config, capabilities.host.platform);
  const bot = state.bots.find((candidate) => candidate.id === botId);
  const view = placeRowViewFor(place, seat, worksOnSimpleLabel(bot?.computer, capabilities.host.platform));
  const id = view.action?.id;
  const onClick = !id ? undefined
    : id === "try-again" ? onRetry
    : () => { openPlaceAction(id, { botId, threadId }, dispatch); };
  return <ErrorRow message={view.line} action={view.action && onClick ? { label: view.action.label, onClick } : null} />;
}

export function claudeUpdateTarget(engine: InstanceInfo | undefined): InstanceInfo | undefined {
  return engine?.driverKind === "claudeAgent" && !engine.readOnly ? engine : undefined;
}

export function FailedTurnRow({ tool, engine, onRetry, botId, threadId }: {
  tool: NonNullable<Message["tool"]>;
  engine: InstanceInfo | undefined;
  onRetry?: () => void;
  botId?: string;
  threadId?: string;
}) {
  if (tool.place && botId) return <PlaceFailedRow place={tool.place} botId={botId} threadId={threadId} onRetry={onRetry} />;
  if (tool.quota) return <LimitRow tool={tool} onRetry={onRetry} botId={botId} threadId={threadId} />;
  const signedOut = signedOutEngine(tool, engine);
  return (
    <ErrorRow
      message={failedTurnCause(tool.name) ?? tool.name}
      headline={signedOut && t("chat.error.signedOut", { name: signedOut.displayName })}
      onRetry={onRetry}
      setupInstance={tool.setup ? engine : undefined}
      claudeUpdateInstance={tool.claudeUpdate ? claudeUpdateTarget(engine) : undefined}
    />
  );
}

class MessageBoundary extends Component<{ children: ReactNode; fallbackText: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="chat-text w-fit max-w-[min(42rem,78%)] rounded-[18px] bg-card px-3 py-[7px] text-[14px] leading-[21px] whitespace-pre-wrap text-ink">
          {this.props.fallbackText}
        </div>
      );
    }
    return this.props.children;
  }
}

function BubbleEditor({
  initial,
  onCancel,
  onSubmit,
}: {
  initial: string;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const submit = () => {
    if (draft.trim()) onSubmit(draft.trim());
  };
  return (
    <div className="w-full max-w-[min(42rem,78%)] rounded-[18px] border border-hairline/40 bg-bubble-user px-3 py-2">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-full px-3 py-1 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {t("common.cancel")}
        </button>
        <button
          onClick={submit}
          disabled={!draft.trim()}
          className="rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white disabled:opacity-40 transition-[filter] enabled:hover:brightness-110"
        >
          {t("chat.send")}
        </button>
      </div>
    </div>
  );
}

const Bubble = memo(function Bubble({
  message,
  emerging = false,
  eagerAttachments = false,
  editing,
  pinned,
  versions,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  replyTarget,
  onReply,
}: {
  message: Message;
  emerging?: boolean;
  eagerAttachments?: boolean;
  editing: boolean;
  pinned: boolean;
  versions?: readonly Message[];
  onStartEdit: (messageId: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (messageId: string, text: string) => void;
  onRegenerate?: () => void;
  replyTarget?: Message;
  onReply: (message: Message) => void;
}) {
  const { botId, threadId, botName, voiceId, tts, localVoice, busy, mentionPeers, focus, dispatch, onBranch, bots } = useChatRows();
  const remoteClient = window.laterdog?.remoteClient?.active === true;
  const peer = peerLine(message);
  const user = message.role === "user" && !peer;
  const [expanded, setExpanded] = useState(false);
  const focusedSearch = focus?.messageId === message.id && Boolean(focus.matchText);
  const [viewRaw, setViewRaw] = useState(false);
  const speech = useSpeech();
  const speaking = speech.messageId === message.id && speech.status !== "idle";
  const text = peer ? peer.body : (message.text ?? "");
  const attached = useMemo(() => splitMessageAttachments(message.attachments), [message.attachments]);
  const generatedPaths = attached.images;
  const linkedFiles = useMemo(
    () => user ? [] : [...attached.files, ...collectMessageFiles(text, [...attached.images, ...attached.files.map((file) => file.path)])],
    [user, text, attached],
  );
  const voiceNotes = useMemo(
    () => message.attachments?.filter((attachment): attachment is VoiceNoteAttachment => attachment.kind === "audio") ?? [],
    [message.attachments],
  );
  const webhookView = user ? webhookMessageView(text) : null;
  const cited = user && !webhookView ? splitTranscriptCitations(text) : null;
  const attachments = user && !webhookView ? splitTranscriptAttachments(cited?.display ?? text) : null;
  const visibleText = webhookView?.task ?? attachments?.display ?? text;
  const hasAttachments = Boolean(cited?.citations.length || (attachments && (attachments.images.length || attachments.files.length)));
  const sentImages = attachments?.images ?? [];
  const sentFiles = attachments?.files ?? [];
  const sentAttachments = sentImages.length + sentFiles.length > 0;
  const sentAbove = sentAttachments && Boolean(visibleText.trim());
  const attachmentsOnly = !webhookView && !replyTarget && !visibleText.trim() &&
    (user ? hasAttachments : generatedPaths.length + linkedFiles.length > 0);
  const collapsible =
    user && !webhookView && !expanded && (visibleText.length > USER_COLLAPSE_CHARS || visibleText.split("\n").length > USER_COLLAPSE_LINES);
  useEffect(() => {
    if (focusedSearch && collapsible) setExpanded(true);
  }, [focusedSearch, collapsible, focus?.nonce]);

  if (user && editing && !webhookView && !hasAttachments) {
    return (
      <div className="flex w-full justify-end">
        <BubbleEditor initial={text} onCancel={onCancelEdit} onSubmit={(edited) => onSubmitEdit(message.id, edited)} />
      </div>
    );
  }

  const forks = user && versions ? versions : [message];
  const versionIndex = forks.findIndex((v) => v.id === message.id);
  const switchTo = (v: Message | undefined) => {
    if (v && !busy && !v.id.startsWith("optimistic-")) dispatch({ type: "switchBranch", botId, threadId, messageId: v.id });
  };
  const togglePin = () =>
    dispatch({ type: "updateTask", botId, threadId, patch: { pinnedMessageId: pinned ? "" : message.id } });
  const pinItem: SidebarMenuItem[] = remoteClient ? [] : [{
    key: "pin",
    label: t(pinned ? "chat.unpin" : "chat.action.pin"),
    icon: pinned ? <PinOff size={16} /> : <Pin size={16} />,
    onSelect: togglePin,
  }];
  const botMore: SidebarMenuItem[] = [
    ...(message.kind === "text" && text && !peer && !speaking && canSpeak(tts, voiceId, localVoice) ? [{
      key: "speak",
      label: t("chat.action.readAloud"),
      icon: <Volume2 size={16} />,
      onSelect: () => void speaker.speak(text, { botId, messageId: message.id, voiceId }),
    }] : []),
    ...(text && !viewRaw ? [{ key: "source", label: t("chat.action.viewSource"), icon: <Code size={16} />, onSelect: () => setViewRaw(true) }] : []),
    ...(!busy && onRegenerate ? [{ key: "retry", label: t("chat.retry"), icon: <RefreshCw size={16} />, onSelect: onRegenerate }] : []),
    ...pinItem,
  ];

  return (
    <div className={cn("group flex w-full flex-col", user ? "items-end" : "items-start")}>
      {peer && <PeerLabel peer={peer} />}
      {sentAbove && (
        <AttachmentGallery sent images={sentImages} files={sentFiles} message={{ threadId, messageId: message.id }} eager={eagerAttachments} className="mb-1.5 max-w-[min(42rem,78%)]" />
      )}
      <div className={cn("flex w-full items-center gap-1.5", user ? "justify-end" : "justify-start")}>
        {user && (
          <MessageActions side="user" more={pinItem}>
            {message.kind === "text" && !webhookView && !hasAttachments && !busy && !message.id.startsWith("optimistic-") && (
              <button
                onClick={() => onStartEdit(message.id)}
                aria-label={t("chat.editMessage")}
                title={t("chat.editMessage")}
                className={messageActionClass}
              >
                <Pencil size={14} />
              </button>
            )}
            {Boolean(visibleText.trim()) && <CopyButton text={visibleText} className="opacity-100" />}
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
        )}
        <div
          data-chat-bubble
          className={cn(
            "w-fit max-w-[min(42rem,78%)] rounded-[18px] text-[14px] leading-[21px]",
            emerging && "turn-answer",
            user && webhookView
              ? "overflow-hidden border border-accent/25 bg-card text-ink shadow-[0_10px_30px_rgba(0,0,0,0.18)]"
              : attachmentsOnly
                ? "text-ink"
                : user
                  ? "bg-bubble-user px-3 py-[7px] whitespace-pre-wrap text-ink"
                  : "bg-card px-3 py-[7px] text-ink",
          )}
          title={new Date(message.at).toLocaleString()}
          data-dog-tint={user && !webhookView && !attachmentsOnly ? dogTint(bots.find((candidate) => candidate.id === botId)?.color) : undefined}
        >
          {replyTarget && (
            <div className="mb-2">
              <ReplyQuote
                message={replyTarget}
                fallbackName={botName}
                compact
                onJump={() =>
                  dispatch({ type: "focusMessage", threadId, messageId: replyTarget.id })
                }
              />
            </div>
          )}
          {user && webhookView ? (
            <div className="min-w-[300px] max-w-[520px]">
              <div className="flex items-center gap-2 border-b border-accent/15 bg-accent/[0.055] px-4 py-2.5 text-[11.5px] font-medium text-accent">
                <Webhook size={13} />
                <span>{t("chat.webhookTask")}</span>
              </div>
              <div className="chat-text px-4 py-3 whitespace-pre-wrap">{webhookView.task}</div>
              {webhookView.payload && (
                <details className="border-t border-hairline/30 bg-inset/25 px-4 py-2.5 text-[11.5px] text-ink-secondary">
                  <summary className="cursor-pointer select-none hover:text-ink">{t("chat.viewPayload")}</summary>
                  <pre className="mt-2 max-h-48 overflow-auto rounded-lg border border-hairline/25 bg-black/25 p-3 font-mono text-[10.5px] leading-relaxed whitespace-pre-wrap text-ink-secondary">{webhookView.payload}</pre>
                </details>
              )}
            </div>
          ) : user ? (
            <>
              {sentAttachments && !sentAbove && (
                <AttachmentGallery sent images={sentImages} files={sentFiles} message={{ threadId, messageId: message.id }} eager={eagerAttachments} />
              )}
              {visibleText && (
                <div
                  className={cn("chat-text", collapsible && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}
                  data-citation-source={message.id}
                  data-citation-owner-type="bot"
                  data-citation-owner={botId}
                  data-citation-thread={threadId}
                >
                  <ThreadRefText text={visibleText} peers={mentionPeers} />
                </div>
              )}
              {cited && <SentCitations
                citations={cited.citations}
                onNavigate={async (citation: CitationAttachment) => {
                  if (citation.source.ownerType !== "bot" || !onBranch(citation.source.messageId)) return false;
                  dispatch({ type: "focusMessage", threadId, messageId: citation.source.messageId });
                  return highlightCitationSource(citation);
                }}
              />}
              {message.steered && (
                <div className="mt-1 text-[11px] text-ink-tertiary" title={t("chat.sentMidTurnHint")}>
                  {t("chat.sentMidTurn")}
                </div>
              )}
              {message.via === "call" && (
                <span className="mt-1 text-[11px] text-ink-tertiary" title={t("chat.viaCall")}>
                  {t("chat.viaCall")}
                </span>
              )}
              {collapsible && (
                <button onClick={() => setExpanded(true)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showFull")}
                </button>
              )}
              {expanded && (
                <button onClick={() => setExpanded(false)} className="mt-1 text-[12.5px] text-ink-secondary hover:text-ink">
                  {t("chat.showLess")}
                </button>
              )}
            </>
          ) : (
            <MessageBoundary key={viewRaw ? "raw" : "rendered"} fallbackText={text || t("chat.generatedImage")}>
              {voiceNotes.length > 0 && (
                <div className={cn("flex flex-col", (text || generatedPaths.length > 0 || linkedFiles.length > 0) && "mb-2")}>
                  {voiceNotes.map((note) => (
                    <VoiceNoteBubble key={note.path} attachment={note} />
                  ))}
                </div>
              )}
              <AttachmentGallery images={generatedPaths} files={linkedFiles} message={{ threadId, messageId: message.id }} className={text ? undefined : "mb-0"} eager={eagerAttachments} />
              {viewRaw && text ? (
                <div data-citation-source={message.id} data-citation-owner-type="bot" data-citation-owner={botId} data-citation-thread={threadId}><RawMarkdownView text={text} /></div>
              ) : text ? (
                <div data-citation-source={message.id} data-citation-owner-type="bot" data-citation-owner={botId} data-citation-thread={threadId}><ChatMarkdown text={text} mentionPeers={mentionPeers} message={{ threadId, messageId: message.id }} /></div>
              ) : null}
            </MessageBoundary>
          )}
        </div>
        {!user && (
          <MessageActions side="bot" forceOpen={viewRaw || speaking} more={botMore}>
            {speaking && <StopSpeakingButton preparing={speech.status === "preparing"} />}
            {viewRaw && text && <RawToggleAction active onToggle={() => setViewRaw(false)} className="opacity-100" />}
            {text && <CopyButton text={text} className="opacity-100" />}
            {!peer && <TreatButton botId={botId} name={botName} onTreat={() => dispatch({ type: "giveTreat", botId })} />}
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
        )}
        <span
          className={cn(
            "self-end pb-1 text-[11px] tabular-nums text-ink-tertiary opacity-0 transition-opacity group-hover:opacity-100",
            user ? "order-first mr-2" : "ml-2",
          )}
        >
          {formatTime(message.at)}
        </span>
      </div>
      {forks.length > 1 && (
        <div className="mt-1 flex items-center gap-0.5 pr-1 text-[12px] text-ink-secondary">
          <button
            onClick={() => switchTo(forks[versionIndex - 1])}
            disabled={versionIndex <= 0 || busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.previousVersion")}
          >
            <ChevronLeft size={14} />
          </button>
          <span className="tabular-nums">
            {versionIndex + 1}/{forks.length}
          </span>
          <button
            onClick={() => switchTo(forks[versionIndex + 1])}
            disabled={versionIndex >= forks.length - 1 || busy}
            className="rounded p-0.5 hover:bg-raised hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent"
            title={t("chat.nextVersion")}
          >
            <ChevronRight size={14} />
          </button>
        </div>
      )}
    </div>
  );
});

function PeerLabel({ peer }: { peer: PeerLine }) {
  const { bots } = useChatRows();
  const author =
    bots.find((b) => b.id === peer.botId) ?? bots.find((b) => b.name === peer.name);
  const how =
    peer.delivery === "delegate_bot"
      ? t("chat.peer.delegated")
      : peer.delivery === "start_thread"
        ? t("chat.peer.openedThread")
        : t("chat.peer.asked");
  return (
    <div className="mb-1 flex items-center gap-1.5 pl-0.5" data-testid="peer-label">
      <BotAvatar
        bot={author ?? { name: peer.name, color: "blue" }}
        state={normalizeState(author?.mascotExpression) ?? "happy"}
        size={16}
        motion="none"
        motionKey={0}
        animated={false}
      />
      <span className="text-[11px] font-medium text-ink-secondary">{peer.name}</span>
      <span className="text-[11px] text-ink-tertiary">· {how}</span>
    </div>
  );
}

const ActivityChip = memo(function ActivityChip({ message, place = "auto" }: { message: Message; place?: EffectivePlace }) {
  const { bots, dispatch } = useChatRows();
  const tool = message.tool;
  if (!tool) return null;
  if (message.cloudTask) return <CloudTaskCard message={message} />;
  if (message.threadRef) return <ThreadChip message={message} />;
  const comm = message.comm;
  if (comm) {
    const withBot = bots.find((b) => b.id === comm.withBotId);
    return (
      <div className="flex justify-start">
        <button
          onClick={() => dispatch({ type: "select", id: comm.groupId })}
          title={t("chat.openConversationWith", { name: comm.withName })}
          className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <BotAvatar bot={withBot ?? { name: comm.withName, color: comm.withColor }} state="happy" size={16} animated={false} />
          <span className="max-w-[480px] truncate">{tool.name}</span>
          <ChevronRight size={13} />
        </button>
      </div>
    );
  }
  return <ToolActivity tool={tool} place={toolPlace(tool.name, place)} />;
});

function RoutineRunRow({ message, botId }: { message: Message; botId: string }) {
  const { state, dispatch } = useStore();
  const executionThreadId = message.routineRun?.executionThreadId;
  const canOpen = executionThreadId && state.bots.some((candidate) =>
    candidate.threadId === executionThreadId || hasRoutineExecutionTask(candidate.tasks, executionThreadId)
  );
  return (
    <RoutineRunCard
      message={message}
      onOpen={canOpen && executionThreadId
        ? () => openNotificationTarget(dispatch, { botId, threadId: executionThreadId }, state)
        : undefined}
    />
  );
}

function EmptyChat({ bot }: { bot: Bot }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
      <BotAvatar bot={bot} state="idle" size={64} motion="none" motionKey={0} />
      <div className="text-[17px] font-semibold text-ink">{bot.name}</div>
      <div className="max-w-[360px] text-[14px] text-ink-secondary">
        {bot.description || t("chat.emptyPrompt")}
      </div>
    </div>
  );
}

const MessagesList = memo(function MessagesList({
  messages,
  transcript,
  plan,
  lookups,
  place,
  pinnedMessageId,
  today,
  editingId,
  lastBotTextId,
  emergingId,
  canRetryLast,
  engine,
  onStartEdit,
  onCancelEdit,
  onSubmitEdit,
  onRegenerate,
  onReply,
}: {
  messages: Message[];
  transcript: Message[];
  plan: TranscriptPlan;
  lookups: TranscriptLookups;
  place: EffectivePlace;
  pinnedMessageId?: string;
  today: number;
  editingId: string | null;
  lastBotTextId: string | undefined;
  emergingId?: string | null;
  canRetryLast: boolean;
  engine: InstanceInfo | undefined;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSubmitEdit: (id: string, text: string) => void;
  onRegenerate: () => void;
  onReply: (message: Message) => void;
}) {
  const { botId, threadId, botName, focus, showToolCalls, locale } = useChatRows();
  const arriving = useArrivals(`${botId}/${threadId}`, messages);
  const emerged = useRef(new Set<string>());
  if (emergingId) emerged.current.add(emergingId);
  const items = useMemo(() => groupTranscript(messages, plan), [messages, plan, locale]);
  const unreadSince = useUnreadBoundary(`${botId}/${threadId}`, messages);
  let unreadPlaced = false;
  const unreadDivider = (rows: readonly Message[]) => {
    if (unreadPlaced || !rows.some((row) => isUnread(row, unreadSince))) return null;
    unreadPlaced = true;
    return <UnreadDivider />;
  };
  const newestMessageId = messages.at(-1)?.id;
  let newestUserMessageId: string | undefined;
  for (let i = messages.length - 1; i >= 0 && !newestUserMessageId; i--) {
    if (messages[i]!.role === "user") newestUserMessageId = messages[i]!.id;
  }
  const focusedId = focus && !focus.consumed ? focus.messageId : null;
  return (
    <>
      {items.map((item, i) => {
        const previous = items[i - 1];
        const prev = previous && (previous.kind === "message" ? previous.message : previous.messages.at(-1));
        const first = item.kind === "message" ? item.message : item.messages[0];
        const newDay = !prev || localDay(prev.at) !== localDay(first.at);
        if (item.kind === "turn") {
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} today={today} />}
              {unreadDivider(item.messages)}
              <TurnNarrationRun
                label={item.label}
                forceOpen={item.messages.some((message) => message.id === focusedId)}
              >
                {item.messages.map((message) => (
                  <div key={message.id} className="contents" data-mid={message.id} data-arriving={arriving(message.id) ? "" : undefined}>
                    <Bubble
                      message={message}
                      editing={false}
                      pinned={message.id === pinnedMessageId}
                      onStartEdit={onStartEdit}
                      onCancelEdit={onCancelEdit}
                      onSubmitEdit={onSubmitEdit}
                      replyTarget={lookups.replyTarget(message)}
                      onReply={onReply}
                    />
                  </div>
                ))}
              </TurnNarrationRun>
            </div>
          );
        }
        if (item.kind === "run") {
          if (!showToolCalls) return null;
          return (
            <div key={item.id} className="contents">
              {newDay && <DaySeparator at={first.at} today={today} />}
              {unreadDivider(item.messages)}
              <ActivityRun messages={item.messages} forceOpen={item.messages.some((step) => step.id === focusedId)}>
                {item.messages.map((step) => (
                  <div key={step.id} className="contents" data-mid={step.id} data-arriving={arriving(step.id) ? "" : undefined}>
                    <ActivityChip message={step} place={place} />
                  </div>
                ))}
              </ActivityRun>
            </div>
          );
        }
        const m = item.message;
        const row = (() => {
          switch (m.kind) {
            case "secret":
              return m.secureForm ? (
                <SecureFormCard botId={botId} botName={botName} threadId={threadId} message={m} />
              ) : m.secret ? <SecretRequestCard botId={botId} threadId={threadId} message={m} /> : null;
            case "connector":
              return m.connector ? <ConnectorCard botId={botId} threadId={threadId} message={m} /> : null;
            case "options": {
              const card = m.card?.takeoverRequest ? (
                <TakeoverCard botId={botId} botName={botName} threadId={threadId} message={m} />
              ) : m.card?.requestId && m.card.questionRequest ? (
                <QuestionCard threadId={threadId} bot={{ name: botName }} message={m} />
              ) : m.card?.requestId && m.card.tool ? (
                <ApprovalCard bot={{ name: botName }} message={m} threadId={threadId} />
              ) : shouldHideOnboardingCard(m, transcript) ? null : (
                <OptionCard botId={botId} threadId={threadId} message={m} />
              );
              if (!card) return null;
              return (
                <MessageBoundary fallbackText={m.card?.subtitle || m.card?.title || ""}>
                  {card}
                </MessageBoundary>
              );
            }
            case "routine.run":
              return <RoutineRunRow message={m} botId={botId} />;
            case "activity": {
              if (isStatusActivity(m)) return <StatusActivityRow message={m} />;
              if (m.tool && failedTurnCause(m.tool.name) !== null) {
                return (
                  <FailedTurnRow
                    tool={m.tool}
                    engine={engine}
                    botId={botId}
                    threadId={threadId}
                    onRetry={m.id === lookups.retryableId && canRetryLast ? onRegenerate : undefined}
                  />
                );
              }
              if (!showToolCalls && !m.comm && !m.threadRef && !m.cloudTask) return null;
              return <ActivityChip message={m} place={place} />;
            }
            case "digest":
              return showToolCalls ? <DigestChip message={m} /> : null;
            case "compaction":
              return <CompactionChip message={m} />;
            case "screen":
              return showToolCalls ? <ScreenFrame threadId={threadId} message={m} /> : null;
            default:
              if (cloudWakeupOf(m)) return <CloudTaskUpdateRow message={m} />;
              return (
                <Bubble
                  message={m}
                  emerging={m.id === emergingId}
                  eagerAttachments={m.id === newestMessageId || m.id === newestUserMessageId}
                  editing={editingId === m.id}
                  pinned={m.id === pinnedMessageId}
                  versions={lookups.editVersions(m)}
                  onStartEdit={onStartEdit}
                  onCancelEdit={onCancelEdit}
                  onSubmitEdit={onSubmitEdit}
                  onRegenerate={m.id === lastBotTextId ? onRegenerate : undefined}
                  replyTarget={lookups.replyTarget(m)}
                  onReply={onReply}
                />
              );
          }
        })();
        if (!row) return null;
        const arrives = arriving(m.id) && !emerged.current.has(m.id);
        return (
          <div key={m.id} className="contents" data-mid={m.id} data-arriving={arrives ? "" : undefined}>
            {newDay && <DaySeparator at={m.at} today={today} />}
            {unreadDivider([m])}
            {row}
          </div>
        );
      })}
    </>
  );
});

function PinnedBanner({
  bot,
  pinnedId,
  messages,
  onJump,
  onUnpin,
}: {
  bot: Bot;
  pinnedId?: string;
  messages: Message[];
  onJump: (messageId: string) => void;
  onUnpin?: () => void;
}) {
  const pinned = messages.find((m) => m.id === pinnedId);
  if (!pinned || pinned.kind !== "text") return null;
  const pinnedPeer = peerLine(pinned);
  const sender =
    pinned.role === "user" ? (pinnedPeer?.name ?? t("chat.you")) : (pinned.from?.name ?? bot.name);
  const text = citationPreviewText(pinnedPeer?.body ?? pinned.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return (
    <div className="w-full px-5">
      <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/[0.07] px-3 py-1.5">
        <Pin size={12} className="shrink-0 text-accent" />
        <button
          onClick={() => onJump(pinned.id)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
          title={t("chat.pinnedJump")}
        >
          <span className="shrink-0 text-[11.5px] font-medium text-accent">{sender}</span>
          <span className="truncate text-[12.5px] text-ink-secondary">{text}</span>
        </button>
        {onUnpin && <button
          onClick={onUnpin}
          aria-label={t("chat.unpinMessage")}
          title={t("chat.unpin")}
          className="shrink-0 rounded p-0.5 text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <X size={13} />
        </button>}
      </div>
    </div>
  );
}

function HeaderStatusDot({ bot }: { bot: Bot }) {
  const waiting = bot.activity === "waiting-on-you";
  if (!waiting && !bot.busy) return null;
  const label = waiting ? t("sidebar.preview.waiting") : t("chat.activity.working");
  return (
    <span
      data-testid={waiting ? "waiting-dot" : "working-dot"}
      role="status"
      aria-label={label}
      title={label}
      className={cn("animate-dot-in absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-composer", waiting ? "bg-warning" : "bg-success")}
    />
  );
}

const CHATHEAD_PILL ="flex min-w-0 items-center gap-2 rounded-full border-[0.5px] border-ink/10 bg-composer py-1.5 pl-1.5 text-ink shadow-[0_4px_12px_-1px_rgba(0,0,0,0.08),0_1px_3px_rgba(0,0,0,0.06)]";

function chiefOfStaffBadge(bot: Bot) {
  if (!bot.chiefOfStaff) return null;
  return (
    <span title={t("chat.chiefOfStaff")} className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent/12 px-2 py-0.5 text-[11px] font-medium text-accent @max-4xl/chathead:px-1.5">
      <Crown size={11} aria-hidden="true" /> <span className="@max-4xl/chathead:sr-only">{t("chat.chiefOfStaff")}</span>
    </span>
  );
}

export function ChatView({ bot: profile }: { bot: Bot }) {
  const bot = useMemo(() => currentTaskBot(profile), [profile]);
  const { state, dispatch } = useStore();
  const remoteClient = window.laterdog?.remoteClient?.active === true;
  const { dragStyle: headerDragStyle, noDragStyle: headerNoDragStyle, controlsShiftStyle } = useCaptionChrome();
  const composerDockRef = useRef<HTMLDivElement>(null);
  const composerDock = useComposerDockPad(composerDockRef);
  const canWrite = useCanWriteIn(bot.threadId);

  const computerStarting = computerStartLine(state.computerStarts[bot.id], bot.name);
  const [findOpen, setFindOpen] = useState(false);
  const { replyTo, selectReply, clearReply, consumeReply, restoreReply } = useReplyDraft(
    bot.threadId,
    `bot:${bot.id}:${bot.threadId}`,
    bot.messages,
  );
  useEffect(() => setFindOpen(false), [bot.threadId]);
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

  const { messages: allMessages, activeLeafId } = bot;
  const messages = useMemo(() => visibleMessages({ messages: allMessages, activeLeafId }), [allMessages, activeLeafId]);
  const lookups = useMemo(() => transcriptLookups(allMessages, messages), [allMessages, messages]);
  const takeoverOpen = useMemo(
    () => messages.some((m) => m.kind === "options" && m.card?.takeoverRequest && isOpenTakeover(m.card.takeoverRequest.status)),
    [messages],
  );
  const showToolCalls = showToolCallsEnabled(state.config);
  const runningSince = bot.busy ? bot.turnStartedAt ?? null : null;
  const plan = useMemo(
    () => planTranscript(messages, { runningSince, quiet: !showToolCalls }),
    [messages, runningSince, showToolCalls],
  );
  const shownMessages = useMemo(
    () => plan.hiddenIds.size ? messages.filter((message) => !plan.hiddenIds.has(message.id)) : messages,
    [messages, plan],
  );
  const countsInWindow = useCallback(
    (message: Message) => !plan.hiddenIds.has(message.id) && transcriptRowShown(message, showToolCalls),
    [plan, showToolCalls],
  );
  const {
    scrollRef,
    transcriptRef,
    transcriptKey,
    following,
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
    ownerId: bot.id,
    threadId: bot.threadId,
    messages,
    pinOn: [bot.busy, composerDock.pad],
    counts: countsInWindow,
  });
  const shownRows = useMemo(() => messages.filter(countsInWindow), [messages, countsInWindow]);
  const newBelow = useNewBelow(following, shownRows);

  const lastBotTextId = useMemo(
    () => [...shownMessages].reverse().find((m) => m.role === "bot" && m.kind === "text")?.id,
    [shownMessages],
  );

  const bots = useDrawnBots(state.bots);
  const mentionPeers = useMemo(() => bots.filter((peer) => peer.id !== bot.id), [bots, bot.id]);
  const focus = state.focusMessage?.threadId === bot.threadId ? state.focusMessage : null;
  const tts = state.config?.tts;
  const localVoice = localSystemVoiceActive();
  const locale = activeLocale();
  const busy = Boolean(bot.busy);
  const branch = useRef(messages);
  branch.current = messages;
  const onBranch = useCallback((messageId: string) => branch.current.some((m) => m.id === messageId), []);
  const rows = useMemo<ChatRows>(
    () => ({ botId: bot.id, threadId: bot.threadId, botName: bot.name, voiceId: bot.voice, tts, localVoice, busy, bots, mentionPeers, focus, showToolCalls, locale, dispatch, onBranch }),
    [bot.id, bot.threadId, bot.name, bot.voice, tts, localVoice, busy, bots, mentionPeers, focus, showToolCalls, locale, dispatch, onBranch],
  );
  const place = effectivePlace(bot, bot.tasks?.find((task) => task.threadId === bot.threadId));

  const [editingId, setEditingId] = useState<string | null>(null);
  useEffect(() => setEditingId(null), [bot.id, bot.threadId]);
  const startEdit = useCallback((id: string) => setEditingId(id), []);
  const cancelEdit = useCallback(() => setEditingId(null), []);
  const submitEdit = useCallback(
    (messageId: string, text: string) => {
      setEditingId(null);
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId, text });
    },
    [bot.id, bot.threadId, dispatch],
  );
  const lastUserMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user" && m.kind === "text" && !peerLine(m)),
    [messages],
  );
  const lastUserMessageHasAttachments = useMemo(() => {
    if (!lastUserMessage?.text) return false;
    const cited = splitTranscriptCitations(lastUserMessage.text);
    const attached = splitTranscriptAttachments(cited.display);
    return cited.citations.length > 0 || attached.images.length > 0 || attached.files.length > 0;
  }, [lastUserMessage]);

  const lastMessage = shownMessages.at(-1);
  const activityLabel = liveActivityLabel(lastMessage);
  const working = useWorkingDots(bot.busy, lastMessage, bot.turnStartedAt);
  const waiting = Boolean(bot.busy && bot.activity !== "waiting-on-you" && working);
  const wasWaiting = useRef(false);
  const [popping, setPopping] = useState<string | null>(null);
  const poppingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
  }, []);
  useLayoutEffect(() => {
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    poppingTimer.current = null;
    wasWaiting.current = false;
    setPopping(null);
  }, [bot.id]);
  useEffect(() => {
    if (waiting) wasWaiting.current = true;
  }, [waiting]);
  useLayoutEffect(() => {
    if (lastMessage?.role !== "bot" || lastMessage.kind !== "text" || !wasWaiting.current) return;
    wasWaiting.current = false;
    const messageId = lastMessage.id;
    if (poppingTimer.current) clearTimeout(poppingTimer.current);
    setPopping(messageId);
    poppingTimer.current = setTimeout(() => {
      poppingTimer.current = null;
      setPopping((current) => current === messageId ? null : current);
    }, MOTION.enter + MOTION.base);
  }, [lastMessage?.id, lastMessage?.role, lastMessage?.kind]);
  const presenceVisible = waiting || popping !== null;
  const announcement = useMemo((): TranscriptSnapshot => {
    const approval = pendingApprovals(messages)[0];
    const question = openQuestion(messages);
    return {
      busy: Boolean(bot.busy),
      reply: latestReply(shownMessages, () => bot.name),
      approval: approval ? { id: approval.requestId, name: bot.name } : undefined,
      question: question ? { id: question.id, name: bot.name } : undefined,
    };
  }, [messages, shownMessages, bot.busy, bot.name]);
  const [busySince, setBusySince] = useState<number | null>(null);
  useEffect(() => {
    setBusySince(bot.busy ? bot.turnStartedAt ?? Date.now() : null);
  }, [bot.busy, bot.id, bot.threadId, bot.turnStartedAt]);

  const regenerate = useCallback(() => {
    if (lastUserMessage?.text && !bot.busy && !lastUserMessage.id.startsWith("optimistic-")) {
      dispatch({ type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: lastUserMessage.id, text: lastUserMessage.text });
    }
  }, [lastUserMessage, bot.busy, bot.id, bot.threadId, dispatch]);

  const routineExecution = state.routineRuns.find((run) => run.target === "bot" && run.botId === bot.id && run.threadId === bot.threadId);
  const resultsThreadId = routineExecution?.resultsThreadId ?? routineExecution?.sourceThreadId;
  const canOpenResults = resultsThreadId && [...state.bots, ...state.groups].some((owner) => owner.threadId === resultsThreadId || owner.tasks?.some((task) => task.threadId === resultsThreadId));

  return (
    <main className="relative flex h-full min-w-0 flex-1 flex-col bg-app">
      <CallOverlay bot={bot} />
      <GlassScrollFrame className="flex-1 [--glass-tint:var(--color-app)]">
      <GlassBar edge="top" className="z-[25]">
      <div
        style={headerDragStyle}
        className={cn(
          "@container/chathead px-5 py-3",
          "pl-11 md:pl-5",
        )}
      >
        <div data-chathead-row className="flex items-center justify-between @max-[30rem]/chathead:flex-wrap @max-[30rem]/chathead:gap-y-1 @min-[30rem]/chathead:grid @min-[30rem]/chathead:grid-cols-[minmax(0,1fr)_minmax(0,auto)_minmax(max-content,1fr)]">
        <div data-chathead-identity className="flex min-w-0 items-center gap-2 @max-[30rem]/chathead:basis-full @min-[30rem]/chathead:col-start-2 @min-[30rem]/chathead:justify-self-center" style={headerNoDragStyle}>
          <button
            type="button"
            data-chathead-pill
            onClick={() => dispatch({ type: "toggleSettings", open: true })}
            title={t("chat.openProfile")}
            aria-label={t("chat.openProfileAria", { name: bot.name })}
            className={cn(CHATHEAD_PILL, "pr-3.5 hover:bg-raised-hover")}
          >
            <span className="relative flex shrink-0">
              <BotAvatar bot={bot} state={restingStateForBot(bot)} size={24} animated={false} />
              <HeaderStatusDot bot={bot} />
            </span>
            <span className="min-w-0 truncate text-[14px] font-semibold text-ink">{bot.name}</span>
            {chiefOfStaffBadge(bot)}
          </button>
          {!bot.busy && bot.waitingForTeammates && <span className="truncate text-[12px] text-ink-secondary" role="status">{t("chat.teammatesWorking")}</span>}
        </div>
        <div
          data-chathead-controls
          className="flex shrink-0 items-center gap-2 @max-[30rem]/chathead:ml-auto @max-[30rem]/chathead:flex-wrap @max-[30rem]/chathead:justify-end @min-[30rem]/chathead:col-start-3 @min-[30rem]/chathead:justify-self-end"
          style={controlsShiftStyle}
        >
          {!remoteClient && <ModelPicker key={bot.threadId} bot={bot} threadId={bot.threadId} part="account" />}
          <LiveCallChip currentBotId={bot.id} onOpen={(botId, threadId) => openThread(dispatch, { botId, threadId }, state)} />
          <button
            data-tour="computer"
            onClick={() => dispatch({ type: "toggleComputer" })}
            className={cn(
              "rounded-md p-1.5 hover:bg-raised",
              state.computerOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
            )}
            title={t("chat.computer")}
          >
            <Monitor size={18} />
          </button>
          <ChatHeaderMenu key={`menu:${bot.threadId}`} bot={bot} messages={messages} findOpen={findOpen} onFind={() => setFindOpen((open) => !open)} />
        </div>
        </div>
      </div>

      <BotActivityPicker bot={bot} />
      {routineExecution && <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[11.5px] text-ink-secondary">
        <span className="min-w-0 flex-1 truncate">{t("routines.executionDetails", { name: routineExecution.routineName })}</span>
        {canOpenResults && resultsThreadId && <button type="button" onClick={() => openNotificationTarget(dispatch, { botId: bot.id, threadId: resultsThreadId }, state)} className="rounded px-2 py-1 text-accent hover:bg-raised">{t("routines.results.back")}</button>}
        <button type="button" onClick={() => dispatch({ type: "showRoutines", section: "logs", routineId: routineExecution.routineId, botId: bot.id })} className="rounded px-2 py-1 hover:bg-raised hover:text-ink">{t("routines.logs")}</button>
      </div>}
      {findOpen && <ChatFindBar threadId={bot.threadId} onClose={() => setFindOpen(false)} />}

      {state.error && (
        <div className="w-full px-5">
          <div className="mb-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {state.error}
          </div>
        </div>
      )}
      {state.notice && (
        <div className="w-full px-5">
          <div role="status" className="mb-2 rounded-lg border border-hairline/40 bg-panel px-3 py-2 text-[13px] text-ink-secondary">
            {state.notice.botName ? t("thread.goneShowing", { name: state.notice.botName }) : t("thread.gone")}
          </div>
        </div>
      )}

      <PinnedBanner
        bot={bot}
        pinnedId={bot.pinnedMessageId}
        messages={messages}
        onJump={(messageId) =>
          dispatch({ type: "focusMessage", threadId: bot.threadId, messageId })
        }
        onUnpin={remoteClient ? undefined : () =>
          dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { pinnedMessageId: "" } })
        }
      />


      </GlassBar>

      <div
        ref={scrollRef}
        className="glass-scroller h-full overflow-x-hidden overflow-y-auto overscroll-y-contain px-5 [overflow-anchor:none]"
        style={{ scrollPaddingBottom: composerDock.height }}
        {...scrollHandlers}
      >
        <div
          ref={transcriptRef}
          className="glass-scroller-content flex w-full flex-col gap-3"
          style={{ paddingBottom: composerDock.pad }}
          role="log"
          aria-live="off"
          aria-label={t("chat.conversationWith", { name: bot.name })}
        >
          {hiddenCount > 0 ? (
            <div className="flex justify-center pt-2">
              <button
                onClick={showEarlier}
                className="rounded-full border border-hairline/40 bg-panel px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-raised hover:text-ink"
              >
                {t("chat.showEarlier", { count: hiddenCount })}
              </button>
            </div>
          ) : bot.hasMore ? (
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
          {windowedMessages.length === 0 && !bot.busy && <EmptyChat bot={bot} />}
          <ChatRowsContext.Provider value={rows}>
            <MessagesList
              messages={windowedMessages}
              transcript={messages}
              plan={plan}
              lookups={lookups}
              place={place}
              pinnedMessageId={bot.pinnedMessageId}
              today={localDay(Date.now())}
              editingId={editingId}
              lastBotTextId={lastBotTextId}
              emergingId={popping}
              canRetryLast={!bot.busy && Boolean(lastUserMessage)}
              engine={state.instances.find((i) => i.instanceId === bot.modelSelection.instanceId)}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSubmitEdit={submitEdit}
              onRegenerate={regenerate}
              onReply={selectReply}
            />
          </ChatRowsContext.Provider>
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
          {computerStarting && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-full border border-hairline/40 bg-panel px-3 py-1.5 text-[13px] text-ink-secondary">
                <WorkingDots size={3.5} />
                {computerStarting}
              </div>
            </div>
          )}
          <TurnPresence
            avatar={
              <BotAvatar
                bot={bot}
                state={turnState(messages)}
                size={36}
                forward={false}
                lookAround={1}
                trackPointer={false}
              />
            }
            visible={presenceVisible}
            label={activityLabel}
            answering={popping !== null}
            since={busySince}
          />
        </div>
      </div>

      <TranscriptAnnouncer threadKey={transcriptKey} snapshot={announcement} />

      {!following && (
        <button
          onClick={jumpToLatest}
          aria-label={newBelow ? newBelowLabel(newBelow) : t("chat.jumpToLatestAria")}
          data-new-below={newBelow || undefined}
          className={cn(
            "animate-pop-in absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] shadow-lg transition-colors motion-reduce:transition-none",
            newBelow ? "bg-accent font-medium text-accent-ink hover:bg-accent/85" : "border border-hairline/40 bg-raised text-ink hover:bg-raised-hover",
          )}
          style={{ bottom: composerDock.height }}
        >
          <ArrowDown size={13} /> {newBelow ? newBelowLabel(newBelow) : t("chat.jumpToLatest")}
        </button>
      )}

      <div ref={composerDockRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-[2]">
      <LiveCallBar bot={bot} />
      {!takeoverOpen && <NeedsYouRow botId={bot.id} name={bot.name} />}
      {canWrite === false ? (
        <NewConversationInstead onNew={() => dispatch({ type: "newTask", botId: bot.id })} />
      ) : (
      <Composer
        key={bot.threadId}
        bot={profile}
        replyTo={replyTo}
        onClearReply={clearReply}
        onConsumeReply={consumeReply}
        onRestoreReply={restoreReply}
        onEditLast={lastUserMessage && !lastUserMessageHasAttachments && !bot.busy && !lastUserMessage.id.startsWith("optimistic-")
          ? () => setEditingId(lastUserMessage.id)
          : undefined}
      />
      )}
      {canWrite !== false && (
      <CitationSelectionToolbar
        key={`${bot.id}:${bot.threadId}`}
        viewportRef={scrollRef}
        onAdd={(citation) => appendDraftAttachments(`bot:${citation.source.ownerId}:${citation.source.threadId}`, [citation])}
      />
      )}
      </div>
      </GlassScrollFrame>

    </main>
  );
}

export function NewConversationInstead({ onNew }: { onNew: () => void }) {
  return (
    <div className="pointer-events-auto mx-5 mb-4 flex items-center justify-between gap-3 rounded-2xl border border-hairline/60 bg-raised px-4 py-3" data-testid="cloud-guest-composer">
      <p className="text-[13px] text-ink-secondary">{t("chat.cloudGuest.notYours")}</p>
      <button type="button" onClick={onNew} className="shrink-0 rounded-full bg-accent px-3 py-1 text-[13px] font-medium text-white transition-[filter] enabled:hover:brightness-110">
        {t("chat.cloudGuest.newConversation")}
      </button>
    </div>
  );
}

function usageSummary(bot: Bot, instances: AppState["instances"]): { short: string; detail: string; tone?: "danger" | "warning" } | null {
  const usage = bot.tasks?.find((t) => t.threadId === bot.threadId)?.usage;
  if (!usage || !usageChip(usage)) return null;
  const billing = instances.find((i) => i.instanceId === bot.modelSelection.instanceId)?.snapshot.billing;
  const share = contextShare(usage);
  const detail = [
    usage.turns === 1 ? t("chat.usage.turnsOne") : t("chat.usage.turnsMany", { count: usage.turns }),
    usageDetail(usage),
    lastTurnDetail(usage),
    contextDetail(usage),
    share?.tone === "danger" ? t("chat.usage.contextNudge") : null,
    hasFiniteCost(usage.costUsd) ? `${formatUsd(usage.costUsd)} ${costCaption(billing)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  const short = usageChip(usage);
  const ctx = contextChip(usage);
  return { short: ctx ? `${short} · ${ctx}` : short, detail, tone: share?.tone === "danger" ? "danger" : share?.tone === "warning" ? "warning" : undefined };
}

function ChatHeaderMenu({ bot, messages, findOpen, onFind }: {
  bot: Bot;
  messages: readonly Message[];
  findOpen: boolean;
  onFind: () => void;
}) {
  const { state, dispatch } = useStore();
  const usage = usageSummary(bot, state.instances);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);
  const hasMessages = messages.length > 0;
  const transcript = () => formatTranscriptMarkdown({ title: bot.name, messages, botName: bot.name, isGroup: false });
  const items: SidebarMenuItem[] = [
    {
      key: "find",
      label: t("chat.find"),
      icon: <Search size={16} />,
      active: findOpen,
      trailing: <ShortcutHint id="find-conversation" />,
      onSelect: onFind,
    },
    {
      key: "copy",
      heading: t("chat.export.heading"),
      separatorBefore: true,
      label: t("chat.export.copy"),
      icon: <Copy size={16} />,
      disabled: !hasMessages,
      keepOpen: true,
      trailing: copyStatus && <span role="status" className="text-[11px] text-ink-secondary">{t(copyStatus === "copied" ? "chat.export.copied" : "chat.export.copyFailed")}</span>,
      onSelect: () => { void copyTranscriptToClipboard(transcript()).then((ok) => setCopyStatus(ok ? "copied" : "failed")); },
    },
    {
      key: "download",
      label: t("chat.export.download"),
      icon: <Download size={16} />,
      disabled: !hasMessages,
      onSelect: () => downloadMarkdownTranscript(slugifyTranscriptFilename(bot.name), transcript()),
    },
    ...(usage ? [{
      key: "usage",
      label: t("chat.usage.menu"),
      icon: <Gauge size={16} />,
      separatorBefore: true,
      trailing: <span title={usage.detail} data-testid="usage-chip" className={cn("tabular-nums text-[12px]", usage.tone === "danger" ? "text-danger" : usage.tone === "warning" ? "text-warning" : "text-ink-secondary")}>{usage.short}</span>,
      onSelect: () => dispatch({ type: "toggleAppSettings", open: true, section: "usage" }),
    } satisfies SidebarMenuItem] : []),
  ];
  return (
    <SidebarPopoverMenu
      items={items}
      ariaLabel={t("chat.more")}
      openOnHover
      placement="below"
      renderTrigger={({ open }) => (
        <span
          data-testid="chat-more"
          className={cn(
            "flex rounded-md p-1.5 hover:bg-raised",
            open || findOpen || state.inspectorOpen || state.activityOpen ? "text-accent" : "text-ink-secondary hover:text-ink",
          )}
          title={t("chat.more")}
        >
          <MoreHorizontal size={18} />
        </span>
      )}
    />
  );
}

function NeedsYouRow({ botId, name }: { botId: string; name: string }) {
  const { state, dispatch } = useStore();
  const control = state.computerControl[botId];
  if (!control?.helpReason || control.held || state.computerOpen) return null;
  return (
    <div className="pointer-events-auto mx-auto mb-2 flex w-full max-w-[min(48rem,calc(100%-2.5rem))] items-center gap-2 rounded-xl bg-card px-3 py-2 text-[13px] text-ink ring-[0.5px] ring-ink/10" data-needs-you>
      <Hand size={14} aria-hidden="true" className="shrink-0 text-ink-secondary" />
      <span className="min-w-0 flex-1 truncate">
        <b className="font-medium">{t("computer.needsYou", { name })}</b> <span className="text-ink-secondary">{control.helpReason}</span>
      </span>
      <button type="button" onClick={() => dispatch({ type: "toggleComputer", open: true })}
        className="shrink-0 rounded-full bg-control px-3 py-1 text-[12.5px] font-medium hover:bg-control-hover">
        {t("computer.needsYouOpen")}
      </button>
    </div>
  );
}
