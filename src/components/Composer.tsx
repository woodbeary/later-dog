import { track } from "@/lib/analytics";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { ModelPicker } from "./ModelPicker";
import { ArrowUp, BookOpen, Clock, Loader2, Mic, Square, Target, Users, X } from "lucide-react";
import { useStore, visibleMessages, currentTaskBot, type Bot, type Group, type Message } from "@/state/store";
import { waitingOnPerson } from "@/lib/waiting-on-person";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { activeLocale, t } from "@/lib/i18n";
import {
  draftRevision,
  appendDraftAttachments,
  changeDraftAttachmentPending,
  composerDraftPosition,
  draftAttachments,
  forgetFailedComposerSend,
  markDraftEdited,
  placeDraftPosition,
  recoverFailedComposerSend,
  rememberComposerDraftPosition,
  rememberFailedComposerSend,
  replaceDraftAttachment,
  restoredSendId,
  useComposerDraft,
  useComposerChannelMode,
  useDraftAttachmentPending,
  useFailedComposerSends,
  type ComposerSendSnapshot,
  type FailedComposerSend,
} from "@/lib/drafts";
import { BotAvatar } from "./Avatar";
import { MentionTextarea } from "./MentionTextarea";
import { ComposerAttachments, pathForFile } from "./ComposerAttachments";
import type { CitationAttachment } from "@/lib/citations";
import { editableMessage, restoreEditableMessage } from "@/lib/composer-message-edit";
import { LocalComputerAutoWarning } from "./LocalComputerAutoWarning";
import { FullAccessWarning } from "./FullAccessWarning";
import { CommandAllowlistDialog } from "./CommandAllowlistDialog";
import { approvalModeFor, type ApprovalMode } from "../../shared/approval-mode";
import { waitsForTurn, type SendDelivery } from "../../shared/send-delivery";
import { SendChoiceMenu } from "./SendChoiceMenu";
import {
  appendPastedText,
  handoffAttachmentImagePreview,
  clipboardHasImages,
  clipboardImageFiles,
  composeMessage,
  composerShouldRefocus,
  composerTakesFocusOnOpen,
  imageAttachmentFromFile,
  replyTargetTakesFocus,
  intakeFiles,
  isImageFile,
  isLongPaste,
  optimisticImageAttachment,
  pasteAttachment,
  releaseAttachmentImagePreview,
  type Attachment,
  type PasteAttachment,
} from "@/lib/composer-attachments";
import { admitPictures, joinNotices, PICTURES_PER_MESSAGE } from "@/lib/picture-limit";
import { useTextWrapped } from "@/lib/composer-expand";
import { normalizeState } from "@/lib/mascot";
import { goalCoordinatorForComposer, groupComposerHint, jevRoomRoutingOn, roomRespondersForComposer } from "@/lib/group-routing";
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from "./PendingApproval";
import { CallButton } from "./CallView";
import { AddAccountSheet } from "./AccountsPanel";
import { ComposerPlusMenu } from "./ComposerPlusMenu";
import { EffortButton } from "./EffortButton";
import { needsCli, needsSignIn } from "./EngineSetup";
import { signInFamily } from "@/lib/engine-rail";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { ReplyQuote } from "./ReplyQuote";
import {
  QueuedComposerMessages,
  composerCanSteerQueuedMessages,
  doubleEnterSteerWindowExpiresAt,
  doubleEnterSteersQueue,
} from "./ComposerQueuedMessages";
import { cloudDictationEnabled, skillAuthoringEnabled } from "@/lib/feature-flags";
import { sharperTranscript } from "@/lib/sharper-dictation";
import { useComposerSuggestion } from "@/lib/use-composer-suggestion";
import { TypingGhost, TypingGhostAnnouncement } from "./TypingGhost";
import { mentionChoicesForQuery } from "@/lib/mentions";
import {
  composerSlashTrigger,
  goalTextFromComposer,
  replaceComposerSlashTrigger,
  type ComposerSlashCommand,
} from "@/lib/composer-commands";

function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null;
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

type MentionChoice = { id: string; name: string; bot?: Bot };

interface ComposerDraftSnapshot extends ComposerSendSnapshot {
  reply: Message | null;
}

export function Composer({
  bot: profile,
  group,
  members,
  onEditLast,
  replyTo,
  onClearReply,
  onConsumeReply,
  onRestoreReply,
  locked: setupLocked = false,
}: {
  bot?: Bot;
  group?: Group;
  members?: Bot[];
  onEditLast?: () => void;
  replyTo?: Message | null;
  onClearReply?: () => void;
  onConsumeReply?: () => void;
  onRestoreReply?: (message: Message, threadId: string) => void;
  locked?: boolean;
}) {
  const bot = profile ? currentTaskBot(profile) : undefined;
  const locked = setupLocked || Boolean(bot?.awaitingThreadSnapshot);
  const { state, dispatch } = useStore();
  const { capabilities } = useDesktopCapabilities();
  const busy = group ? Boolean(group.working || group.busyBotId) : Boolean(bot?.busy);
  const asking = !group && waitingOnPerson(bot);
  const steerInstanceId = group
    ? members?.find((member) => member.id === group.busyBotId)?.modelSelection.instanceId
    : bot?.modelSelection.instanceId;
  const steerCapabilities = state.instances.find((i) => i.instanceId === steerInstanceId)?.capabilities;
  const canSteer = steerCapabilities?.queueing === true;
  const threadId = group?.threadId ?? bot?.threadId ?? "";
  const approvals = pendingApprovals(group ? group.messages : bot ? visibleMessages(bot) : []);
  const approval = approvals[0];
  const approvalBot = group
    ? members?.find((member) => member.id === approval?.message.from?.botId) ??
      members?.find((member) => member.id === group.busyBotId)
    : bot;
  const busyName = group
    ? (members?.find((b) => b.id === group.busyBotId)?.name ??
      (group.working ? t("composer.busy.team") : t("composer.busy.aBot")))
    : (bot?.name ?? t("composer.busy.theBot"));
  const draftId = group
    ? `group:${group.id}:${group.threadId}`
    : `bot:${bot?.id ?? ""}:${bot?.threadId ?? ""}`;
  const [text, setText, attachments, setAttachments] = useComposerDraft(
    draftId,
    !group && bot ? `bot:${bot.id}` : undefined,
  );
  const attachmentPending = useDraftAttachmentPending(draftId);
  const failedSends = useFailedComposerSends(draftId);
  const [channelMode, setChannelMode] = useComposerChannelMode(draftId);
  const editText = useCallback(
    (next: string) => {
      markDraftEdited(draftId);
      setText(next);
    },
    [draftId, setText],
  );
  const editAttachments = useCallback(
    (next: SetStateAction<Attachment[]>) => {
      markDraftEdited(draftId);
      setAttachments(next);
    },
    [draftId, setAttachments],
  );
  const restoreDraft = useCallback(
    (sent: ComposerDraftSnapshot) => {
      if (recoverFailedComposerSend(sent) === "restored") {
        if (sent.reply) onRestoreReply?.(sent.reply, sent.threadId);
      }
    },
    [onRestoreReply],
  );
  const addAttachments = useCallback(
    (next: Attachment[]) => appendDraftAttachments(draftId, next),
    [draftId],
  );
  const removeAttachment = useCallback(
    (id: string) => {
      const removed = attachments.find((attachment) => attachment.id === id);
      if (removed?.kind === "image") releaseAttachmentImagePreview(removed);
      editAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
    },
    [attachments, editAttachments],
  );
  const displayPasteInChatBox = useCallback(
    function displayPasteInChatBox(attachment: PasteAttachment) {
      const nextText = appendPastedText(text, attachment.text);
      editText(nextText);
      editAttachments((prev) => prev.filter((a) => a.id !== attachment.id));
      setCaret(nextText.length);
      setDismissedAt(null);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(nextText.length, nextText.length);
      });
    },
    [text, editText, editAttachments],
  );
  const [recording, setRecording] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  const [retryingNote, setRetryingNote] = useState<string | null>(null);
  const retryFile = useRef<string | null>(null);
  const listening = recording || retryingNote !== null;
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [sharpening, setSharpening] = useState(0);
  const sharpenOnStop = useRef(false);
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [dismissedSlashAt, setDismissedSlashAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const textWrapped = useTextWrapped(inputRef, text);
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  const caretRef = useRef(0);
  caretRef.current = caret;
  const refocusInput = useCallback(() => {
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerShouldRefocus(document.activeElement, input)) return;
      const at = Math.min(caretRef.current, input.value.length);
      input.focus();
      input.setSelectionRange(at, at);
    });
  }, []);
  const rememberPosition = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    rememberComposerDraftPosition(draftIdRef.current, {
      start: input.selectionStart,
      end: input.selectionEnd,
      scrollTop: input.scrollTop,
    });
  }, []);
  useLayoutEffect(() => {
    const input = inputRef.current;
    const position = composerDraftPosition(draftIdRef.current);
    if (input && position) placeDraftPosition(input, position);
  }, []);
  useEffect(() => {
    if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerTakesFocusOnOpen(document.activeElement, input)) return;
      input.focus();
      const position = composerDraftPosition(draftIdRef.current);
      if (position) placeDraftPosition(input, position);
      else input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  const replyToId = replyTo?.id ?? null;
  const focusedReplyRef = useRef(replyToId);
  useEffect(() => {
    const previous = focusedReplyRef.current;
    focusedReplyRef.current = replyToId;
    if (!replyTargetTakesFocus(previous, replyToId)) return;
    if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input || input.disabled || !composerTakesFocusOnOpen(document.activeElement, input)) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [replyToId]);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const baseText = useRef("");
  const textNow = useRef(text);
  textNow.current = text;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const sharpenLater = useRef<() => ((recording: string | undefined) => Promise<boolean>) | null>(() => null);
  sharpenLater.current = () => {
    if (!cloudDictationEnabled(state.config) || !window.laterdog?.speechAudio) return null;
    const id = draftId;
    const heard = text;
    const revision = draftRevision(id);
    const base = baseText.current;
    const write = editText;
    return async (recording) => {
      if (!recording) return false;
      setSharpening((count) => count + 1);
      const said = await sharperTranscript(recording, window.laterdog, navigator.language);
      if (!mounted.current) return false;
      setSharpening((count) => count - 1);
      if (!said || draftIdRef.current !== id || textNow.current !== heard || draftRevision(id) !== revision) return false;
      write(base ? `${base} ${said}` : said);
      return true;
    };
  };

  const botSupportsImages = (candidate?: Bot) =>
    Boolean(
      candidate &&
        state.instances.find((i) => i.instanceId === candidate.modelSelection.instanceId)?.capabilities?.images,
    );
  const imageTargetsSupport = (message: string, mode: "chat" | "goal") => {
    if (!group) return botSupportsImages(bot);
    if (mode === "goal") {
      return botSupportsImages(goalCoordinatorForComposer(message, members ?? [], group) ?? undefined);
    }
    const responders = roomRespondersForComposer(message, members ?? [], group);
    return responders.length > 0 && responders.every(botSupportsImages);
  };
  const typedGoalText = group && !group.dm ? goalTextFromComposer(text) : null;
  const effectiveText = typedGoalText ?? text;
  const effectiveChannelMode = typedGoalText !== null ? "goal" : channelMode;
  const engineSupportsImages = imageTargetsSupport(effectiveText, effectiveChannelMode);

  const slash = composerSlashTrigger(text, caret);
  const locale = activeLocale();
  const commandCandidates = useMemo(() => {
    if (!slash || slash.start === dismissedSlashAt) return [];
    const supportsAgents = (candidate?: Bot) =>
      Boolean(
        candidate &&
          state.instances.find(
            (instance) => instance.instanceId === candidate.modelSelection.instanceId,
          )?.capabilities?.agentsMcp,
      );
    const available: ComposerSlashCommand[] = [];
    if (group && !group.dm) available.push({
      id: "goal",
      label: "/goal",
      description: t("composer.command.goalDesc"),
    });
    if (
      skillAuthoringEnabled(state.config) &&
      (group ? (members ?? []).some(supportsAgents) : supportsAgents(bot))
    ) {
      available.push({
        id: "learn",
        label: "/learn",
        description: t("composer.command.learnDesc"),
      });
    }
    if (!group && supportsAgents(bot)) available.push({
      id: "setup",
      label: "/setup",
      description: t("composer.command.setupDesc"),
    });
    const query = slash.query.toLowerCase();
    return available.filter(
      (command) =>
        !query ||
        command.id.startsWith(query) ||
        command.description.toLowerCase().includes(query),
    );
  }, [slash, dismissedSlashAt, group, members, bot, state.config, state.instances, locale]);
  const commandPickerOpen = commandCandidates.length > 0;

  const mention = mentionQueryAt(text, caret);
  const candidates = useMemo(() => {
    if (!mention || mention.start === dismissedAt) return [];
    const pool: MentionChoice[] = group
      ? [
          ...(!group.dm ? [{ id: "__everyone__", name: "everyone" }] : []),
          ...(members ?? []).map((member) => ({ id: member.id, name: member.name, bot: member })),
        ]
      : state.bots
          .filter((member) => member.id !== bot?.id && !member.hidden)
          .map((member) => ({ id: member.id, name: member.name, bot: member }));
    return mentionChoicesForQuery(pool, mention.query);
  }, [mention, dismissedAt, state.bots, bot?.id, group, members]);
  const mentionPickerOpen = candidates.length > 0;
  const suggestion = useComposerSuggestion({
    config: state.config,
    text,
    caret,
    field: inputRef.current,
    lines: group ? group.messages : bot ? visibleMessages(bot) : [],
    dog: group ? group.name : (bot?.name ?? ""),
    dogNames: (group ? members ?? [] : state.bots.filter((member) => member.id !== bot?.id && !member.hidden)).map((member) => member.name),
    commands: [...(group && !group.dm ? ["/goal"] : []), "/learn", "/setup"],
    recording,
    listening,
    locked,
    approval: Boolean(approval),
    picker: commandPickerOpen || mentionPickerOpen,
    edit: editText,
    moveCaret: (at) => {
      setCaret(at);
      requestAnimationFrame(() => inputRef.current?.setSelectionRange(at, at));
    },
  });
  const commandMotion = useMenuMotion(commandPickerOpen);
  const mentionMotion = useMenuMotion(mentionPickerOpen);

  useEffect(
    () => setHighlight(0),
    [mention?.start, mention?.query, slash?.start, slash?.query],
  );

  useEffect(() => {
    if (!mentionPickerOpen) return;
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-mention-index="${highlight}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight, mentionPickerOpen]);

  const pickMention = (peer: MentionChoice) => {
    if (!mention) return;
    const after = text.slice(caret);
    const next = `${text.slice(0, mention.start)}@${peer.name} ${after}`;
    editText(next);
    const newCaret = mention.start + peer.name.length + 2;
    setCaret(newCaret);
    setDismissedAt(mention.start);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(newCaret, newCaret);
    });
  };

  const pickCommand = (command: ComposerSlashCommand) => {
    if (!slash) return;
    const replacement = command.id === "learn" ? "/learn " : command.id === "setup" ? "/setup " : "";
    const next = replaceComposerSlashTrigger(text, slash, replacement);
    editText(next.text);
    setCaret(next.caret);
    setDismissedSlashAt(slash.start);
    setChannelMode(command.id === "goal" ? "goal" : "chat");
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const pendingCount = (state.pendingQueued[threadId] ?? []).length;
  const queuedMessages = state.pendingQueued[threadId] ?? [];
  const canSteerQueued = composerCanSteerQueuedMessages(
    busy,
    locked,
    pendingCount,
    Boolean(approval),
  );
  const [steering, setSteering] = useState(false);
  const interruptTurn = () => {
    if (group) dispatch({ type: "interruptGroup", groupId: group.id, threadId });
    else if (bot) dispatch({ type: "interrupt", botId: bot.id, threadId });
  };
  const queueHeadId = queuedMessages[0]?.queueId;
  const steerLive =
    canSteer &&
    (steerCapabilities?.steerImages === true ||
      !(group ? queuedMessages.slice(0, 1) : queuedMessages).some((item) => item.text.includes("<attached-image")));
  const steerQueued = () => {
    if (!queueHeadId) return;
    setSteering(true);
    const settle = () => setSteering(false);
    if (group) {
      dispatch({ type: "steerGroupQueued", groupId: group.id, threadId, queueId: queueHeadId, onError: settle, onSettled: settle });
    } else if (bot) {
      dispatch({ type: "steerQueued", botId: bot.id, threadId, queueId: queueHeadId, onError: settle, onSettled: settle });
    }
  };
  useEffect(() => setSteering(false), [threadId, queueHeadId]);
  const editQueued = (queueId: string) => {
    const queued = queuedMessages.find((item) => item.queueId === queueId);
    if (!queued) return;
    const targetDraftId = draftId;
    const onCancelled = () => {
      const editable = editableMessage(queued.text);
      restoreEditableMessage(targetDraftId, editable);
      if (targetDraftId !== draftIdRef.current) return;
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(editable.text.length, editable.text.length);
      });
    };
    if (group) dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId, queueId, onCancelled });
    else if (bot) dispatch({ type: "cancelQueued", botId: bot.id, threadId, queueId, onCancelled });
  };
  const steerAgainUntilRef = useRef(0);
  const prevPendingCountRef = useRef(pendingCount);
  useEffect(() => {
    const expiresAt = doubleEnterSteerWindowExpiresAt(
      prevPendingCountRef.current,
      pendingCount,
      busy,
      canSteer,
    );
    if (expiresAt !== null) steerAgainUntilRef.current = expiresAt;
    prevPendingCountRef.current = pendingCount;
  }, [pendingCount, busy, canSteer]);
  useEffect(() => {
    if (!busy || pendingCount === 0) {
      setSteering(false);
      return;
    }
    if (!steering) return;
    const timeout = window.setTimeout(() => setSteering(false), 20_000);
    return () => window.clearTimeout(timeout);
  }, [busy, pendingCount, steering]);
  const fileInput = useRef<HTMLInputElement>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const sendAfterSignIn = useRef<() => void>(() => {});
  const [approvalWarning, setApprovalWarning] = useState<{
    mode: "auto" | "full";
    botId: string;
    threadId: string;
  } | null>(null);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [commandAllowlistTarget, setCommandAllowlistTarget] = useState<{ botId: string; botName: string; threadId: string } | null>(null);
  const modeBot = group ? undefined : bot;
  const approvalEngine = modeBot
    ? state.instances.find((instance) => instance.instanceId === modeBot.modelSelection.instanceId)
    : undefined;
  const trustedThreadAccess = Boolean(window.laterdog?.approvals && capabilities.host.packaged);
  const uploadImage = useCallback(async (file: File): Promise<Attachment | null> => {
    const optimistic = optimisticImageAttachment(file);
    if (!optimistic) return null;
    appendDraftAttachments(draftId, [optimistic]);
    try {
      const completed = await imageAttachmentFromFile(file, optimistic);
      if (!completed) {
        replaceDraftAttachment(draftId, optimistic.id, null);
        releaseAttachmentImagePreview(optimistic);
        return null;
      }
      handoffAttachmentImagePreview(completed.path, completed.previewUrl);
      if (!replaceDraftAttachment(draftId, optimistic.id, completed)) {
        releaseAttachmentImagePreview(completed);
      }
      return null;
    } catch (error) {
      replaceDraftAttachment(draftId, optimistic.id, null);
      releaseAttachmentImagePreview(optimistic);
      throw error;
    }
  }, [draftId]);
  const admitFiles = useCallback((files: File[]) => {
    const { admitted, refused } = admitPictures(
      files,
      (file) => engineSupportsImages && isImageFile(file),
      draftAttachments(draftId),
    );
    return { files: admitted, notice: refused ? t("composer.picturesLimit", { max: PICTURES_PER_MESSAGE }) : null };
  }, [draftId, engineSupportsImages]);
  const pickFiles = async (picked: FileList | null) => {
    if (!picked?.length) return;
    const admitted = admitFiles(Array.from(picked));
    changeDraftAttachmentPending(draftId, true);
    try {
      const { attachments: added, notice } = await intakeFiles(admitted.files, {
        allowImages: engineSupportsImages,
        getPath: pathForFile,
        uploadImage,
      });
      if (added.length) addAttachments(added);
      const shown = joinNotices(admitted.notice, notice);
      if (shown) setAttachmentNotice(shown);
    } finally {
      changeDraftAttachmentPending(draftId, false);
    }
    refocusInput();
  };
  const setApprovalMode = (mode: ApprovalMode) => {
    if (!modeBot || modeBot.busy || mode === approvalModeFor(modeBot)) return;
    if ((mode === "full" || mode === "custom") && !trustedThreadAccess) return;
    if (mode === "full") {
      setApprovalWarning({ mode, botId: modeBot.id, threadId: modeBot.threadId });
      return;
    }
    if (mode === "auto" && modeBot.computer === "local") {
      setApprovalWarning({ mode: "auto", botId: modeBot.id, threadId: modeBot.threadId });
      return;
    }
    dispatch({ type: "updateTask", botId: modeBot.id, threadId: modeBot.threadId, patch: { approvalMode: mode } });
  };

  const hasContent = Boolean(effectiveText.trim()) || attachments.length > 0;
  const expanded = textWrapped || attachments.length > 0 || Boolean(attachmentNotice) || Boolean(replyTo);
  const retryFailedSend = (failed: FailedComposerSend) => {
    const failedMode = failed.channelMode ?? "chat";
    if (failed.requestText.includes("<attached-image ") && !imageTargetsSupport(failed.requestText, failedMode)) {
      dispatch({ type: "error", message: t("composer.error.noImages") });
      return;
    }
    forgetFailedComposerSend(draftId, failed.id);
    const retry = {
      sendId: failed.sendId,
      text: failed.requestText,
      replyToId: failed.replyToId,
      threadId: failed.threadId,
      recovery: { draftId, text: failed.text, ...(failed.channelMode ? { channelMode: failed.channelMode } : {}) },
      onError: () => {
        rememberFailedComposerSend(draftId, {
          sendId: failed.sendId,
          text: failed.text,
          requestText: failed.requestText,
          replyToId: failed.replyToId,
          threadId: failed.threadId,
          channelMode: failed.channelMode,
        });
      },
    };
    if (group) {
      dispatch({ type: "sendGroup", groupId: group.id, mode: failedMode, ...retry });
    } else if (bot) {
      dispatch({ type: "send", botId: bot.id, ...retry });
    }
  };
  const send = (delivery?: SendDelivery, signedInNow = false) => {
    if (locked || attachmentPending) return;
    if (
      attachments.some((attachment) => attachment.kind === "image") &&
      !imageTargetsSupport(effectiveText, effectiveChannelMode)
    ) {
      dispatch({ type: "error", message: t("composer.error.noImages") });
      return;
    }
    const body = composeMessage(effectiveText, attachments);
    if (!body) return;
    const account = !group && bot ? state.instances.find((instance) => instance.instanceId === bot.modelSelection.instanceId) : undefined;
    if (!signedInNow && account?.snapshot && signInFamily(account) && (needsSignIn(account) || needsCli(account))) {
      sendAfterSignIn.current = () => send(delivery, true);
      setSigningIn(account.instanceId);
      return;
    }
    const sentDraft: ComposerDraftSnapshot = {
      draftId,
      revision: draftRevision(draftId),
      sendId: restoredSendId(draftId) ?? crypto.randomUUID(),
      text,
      requestText: body,
      attachments: [...attachments],
      reply: replyTo ?? null,
      replyToId: replyTo?.id,
      threadId,
      channelMode: group ? effectiveChannelMode : undefined,
    };
    if (group) {
      dispatch({
        type: "sendGroup",
        groupId: group.id,
        text: body,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        mode: effectiveChannelMode,
        recovery: { draftId, text, channelMode: effectiveChannelMode },
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { room: true, mode: effectiveChannelMode, queued: busy });
    } else if (bot) {
      dispatch({
        type: "send",
        botId: bot.id,
        text: body,
        sendId: sentDraft.sendId,
        replyToId: replyTo?.id,
        threadId,
        deliver: delivery,
        recovery: { draftId, text },
        onError: () => restoreDraft(sentDraft),
      });
      track("message_sent", { driver: bot.modelSelection?.instanceId, queued: busy && (delivery ? waitsForTurn(delivery) : !canSteer), delivery });
    }
    suggestion.sent(text);
    setRecording(false);
    setRetryingNote(null);
    setText("");
    setAttachments([]);
    setAttachmentNotice(null);
    onConsumeReply?.();
    if (group) setChannelMode("chat");
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = clipboardImageFiles(e.clipboardData);
    if (imageFiles.length > 0 || clipboardHasImages(e.clipboardData)) {
      e.preventDefault();
      if (!engineSupportsImages) {
        dispatch({
          type: "error",
          message: t("composer.error.noImages"),
        });
        return;
      }
      if (!imageFiles.length) {
        dispatch({ type: "error", message: t("composer.error.clipboardImage") });
        return;
      }
      if (imageFiles.length > 0) {
        const admitted = admitFiles(imageFiles);
        if (admitted.notice) setAttachmentNotice(admitted.notice);
        if (!admitted.files.length) return;
        changeDraftAttachmentPending(draftId, true);
        void (async () => {
          try {
            const results = await Promise.allSettled(admitted.files.map(uploadImage));
            for (const result of results) {
              if (result.status === "rejected") {
                dispatch({
                  type: "error",
                  message: result.reason instanceof Error ? result.reason.message : "image upload failed",
                });
              }
            }
          } finally {
            changeDraftAttachmentPending(draftId, false);
          }
        })();
        return;
      }
    }
    const pasted = e.clipboardData.getData("text/plain");
    if (!isLongPaste(pasted)) return;
    e.preventDefault();
    const start = e.currentTarget.selectionStart;
    const end = e.currentTarget.selectionEnd;
    if (start !== end) {
      editText(`${text.slice(0, start)}${text.slice(end)}`);
      setCaret(start);
    }
    editAttachments((prev) => [...prev, pasteAttachment(pasted)]);
  };

  useEffect(() => {
    if (!listening) return;
    const bridge = window.laterdog;
    if (!bridge) {
      setRecording(false);
      setRetryingNote(null);
      return;
    }
    const file = retryFile.current;
    sharpenOnStop.current = false;
    setSpeechError(null);
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (typeof line.text === "string") {
        const base = baseText.current;
        editText(base ? `${base} ${line.text}` : line.text);
      }
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason, recording: saved }) => {
      setRecording(false);
      setRetryingNote(null);
      retryFile.current = null;
      const keep = () => {
        setVoiceNote(code === 1 && saved ? saved : null);
        if (code === 2) {
          setSpeechError(t("composer.dictation.macOnly"));
        } else if (code === 1) {
          setSpeechError(t(
            reason === "dictation-disabled"
              ? "composer.dictation.disabled"
              : reason === "speech-not-authorized"
                ? "composer.dictation.permission"
                : "composer.dictation.failed",
          ));
        }
      };
      const sharpen = !file && saved ? sharpenLater.current() : null;
      if (!sharpen) return keep();
      setVoiceNote(null);
      void sharpen(saved).then((replaced) => {
        if (!replaced && code === 1 && mounted.current) keep();
      });
    });
    void bridge.speechStart(file ? { file } : undefined);
    return () => {
      offTranscript();
      offEnd();
      const stopped = Promise.resolve(bridge.speechStop());
      const sharpen = sharpenOnStop.current ? sharpenLater.current() : null;
      sharpenOnStop.current = false;
      if (sharpen) void stopped.then((result) => sharpen(result?.recording));
    };
  }, [listening, editText]);

  const retryVoiceNote = () => {
    if (!voiceNote || listening) return;
    retryFile.current = voiceNote;
    setVoiceNote(null);
    setRetryingNote(voiceNote);
  };

  const stopDictation = () => {
    sharpenOnStop.current = true;
    setRecording(false);
  };

  const toggleMic = () => {
    if (!capabilities.dictation.available || !window.laterdog) {
      setSpeechError(t("composer.dictation.unavailable"));
      return;
    }
    if (recording) return stopDictation();
    baseText.current = text.trim();
    setRecording(true);
  };

  return (
    <div className="pointer-events-none relative px-5 pb-3">
      {(speechError || retryingNote) && (
        <div data-voice-note className="pointer-events-auto mb-2 flex w-full items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 flex-1">
            {retryingNote ? t("composer.dictation.retrying") : voiceNote ? `${speechError} ${t("composer.dictation.saved")}` : speechError}
          </span>
          {voiceNote && !retryingNote && (
            <button type="button" onClick={retryVoiceNote} className="shrink-0 rounded px-2 py-1 font-medium hover:bg-warning/10">
              {t("chat.retry")}
            </button>
          )}
        </div>
      )}
      <div className="pointer-events-auto relative w-full">
        {failedSends.map((failed) => (
          <div
            key={failed.id}
            className="mb-2 flex items-center gap-2 rounded-lg border border-hairline/40 bg-raised px-3 py-2 text-[12.5px] text-ink-secondary"
          >
            <span className="min-w-0 flex-1 truncate">
              {t("composer.failed.notSent", {
                text: failed.text.trim() || t("composer.failed.attachment"),
              })}
            </span>
            <button
              type="button"
              onClick={() => retryFailedSend(failed)}
              className="shrink-0 rounded px-2 py-1 font-medium text-ink hover:bg-inset"
            >
              {t("chat.retry")}
            </button>
            <button
              type="button"
              onClick={() => forgetFailedComposerSend(draftId, failed.id)}
              aria-label={t("composer.failed.dismissAria")}
              title={t("composer.failed.dismiss")}
              className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-inset hover:text-ink"
            >
              <X size={13} strokeWidth={2.5} />
            </button>
          </div>
        ))}
        {commandMotion.shown && (
          <div
            role="listbox"
            aria-label={t("composer.commands.aria")}
            className={cn("absolute bottom-full left-2 z-20 mb-2 w-80 overflow-hidden rounded-menu origin-bottom-left border border-hairline/40 bg-raised shadow-popover", commandMotion.className)} {...commandMotion.exitProps}
          >
            <div className="border-b border-hairline/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-secondary">
              {t("composer.commands.title")}
            </div>
            {commandCandidates.map((command, index) => (
              <button
                key={command.id}
                type="button"
                role="option"
                aria-selected={index === highlight}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pickCommand(command)}
                onMouseEnter={() => setHighlight(index)}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left",
                  index === highlight ? "bg-raised-hover" : "",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  {command.id === "goal" ? (
                    <Target size={15} aria-hidden="true" />
                  ) : (
                    <BookOpen size={15} aria-hidden="true" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-accent">{command.label}</span>
                  <span className="block truncate text-xs text-ink-secondary">
                    {command.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        {mentionMotion.shown && (
          <div
            ref={mentionListRef}
            role="listbox"
            aria-label={t("composer.mention.aria")}
            className={cn("absolute bottom-full left-2 z-20 mb-2 max-h-72 w-72 overflow-x-hidden overflow-y-auto overscroll-contain rounded-menu origin-bottom-left border border-hairline/40 bg-raised shadow-popover", mentionMotion.className)} {...mentionMotion.exitProps}
          >
            {candidates.map((peer, i) => (
              <button
                key={peer.id}
                data-mention-index={i}
                role="option"
                aria-selected={i === highlight}
                onClick={() => pickMention(peer)}
                onMouseEnter={() => setHighlight(i)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2 text-left",
                  i === highlight ? "bg-raised-hover" : "",
                )}
              >
                {peer.bot ? (
                  <BotAvatar
                    bot={peer.bot}
                    state={normalizeState(peer.bot.mascotExpression) ?? "happy"}
                    size={24}
                  />
                ) : (
                  <span className="flex size-6 items-center justify-center rounded-full bg-raised text-ink-secondary">
                    <Users size={14} aria-hidden="true" />
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{peer.name}</span>
                <span className="shrink-0 text-xs text-ink-secondary">
                  {peer.bot ? t("composer.mention.agent") : t("composer.mention.channel")}
                </span>
              </button>
            ))}
          </div>
        )}
        {approval && (
          <div className="mb-2 overflow-hidden rounded-card bg-card shadow-composer ring-[0.5px] ring-ink/15">
            <PendingApprovalPanel
              pending={approval}
              count={approvals.length}
              index={0}
              locale={activeLocale()}
              botName={approvalBot?.name}
              onCancelTurn={approval.message.card?.routineRequest || approval.message.card?.skillRequest || approval.message.card?.profileRequest ? undefined : interruptTurn}
            />
            <PendingApprovalActions
              pending={approval}
              threadId={threadId}
              bot={approvalBot}
            />
          </div>
        )}
        <QueuedComposerMessages
          items={queuedMessages}
          onSteer={canSteerQueued ? steerQueued : undefined}
          steerInterrupts={!steerLive}
          steerMode={group ? "next" : "all"}
          steering={steering}
          onCancel={(queueId) => {
            if (group) dispatch({ type: "cancelGroupQueued", groupId: group.id, threadId, queueId });
            else if (bot) dispatch({ type: "cancelQueued", botId: bot.id, threadId, queueId });
          }}
          onEdit={locked ? undefined : editQueued}
        />
        <div className="relative">
          <div
            aria-hidden
            data-composer-backdrop
            className="pointer-events-none absolute -left-5 -right-5 -bottom-3 top-1/2 bg-app"
          />
        <div
          data-tour="composer"
          data-expanded={expanded || undefined}
          className={cn(
            "@container/composer relative z-[1] bg-composer px-2 py-1.5 ring-[0.5px] ring-ink/30 shadow-composer transition-[border-radius] duration-(--duration-slow) ease-(--ease-enter)",
            expanded ? "rounded-composer-expanded" : "rounded-composer",
          )}
        >
        {replyTo && (
          <div className="px-1 pb-1.5 pt-0.5">
            <ReplyQuote
              message={replyTo}
              fallbackName={bot?.name}
              onClear={onClearReply}
            />
          </div>
        )}
        <ComposerAttachments
          items={attachments}
          onAdd={addAttachments}
          onRemove={removeAttachment}
          onChangeCitation={(citation: CitationAttachment) => editAttachments((current) => current.map((attachment) => attachment.id === citation.id ? citation : attachment))}
          onDisplayInChatBox={displayPasteInChatBox}
          allowImages={engineSupportsImages}
          notice={attachmentNotice}
          onNotice={setAttachmentNotice}
          onPendingChange={(pending) => changeDraftAttachmentPending(draftId, pending)}
          uploadImage={uploadImage}
          admitFiles={admitFiles}
        />
        <div data-composer-row className={cn("flex items-end gap-1 @max-[30rem]/composer:flex-wrap", expanded && "flex-wrap")}>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              void pickFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {!locked && (
            <div data-composer-tools className="flex items-center gap-1">
              <ComposerPlusMenu
                onAttach={() => fileInput.current?.click()}
                onConnectors={() => dispatch({ type: "togglePlugins", open: true })}
                permissions={modeBot && approvalEngine ? {
                  approvalMode: modeBot.approvalMode,
                  autoApprove: modeBot.autoApprove,
                  driverKind: approvalEngine.driverKind,
                  trustedModesAvailable: trustedThreadAccess,
                  disabled: Boolean(modeBot.busy),
                  onSelect: setApprovalMode,
                } : null}
              />
              {group && !group.dm && (
                <button
                  type="button"
                  aria-pressed={effectiveChannelMode === "goal"}
                  aria-label={t("composer.goal.aria")}
                  title={t("composer.goal.title")}
                  onClick={() => {
                    markDraftEdited(draftId);
                    if (typedGoalText !== null) {
                      const nextCaret = Math.max(0, caret - (text.length - typedGoalText.length));
                      editText(typedGoalText);
                      setCaret(nextCaret);
                      setChannelMode("chat");
                      requestAnimationFrame(() => {
                        inputRef.current?.focus();
                        inputRef.current?.setSelectionRange(nextCaret, nextCaret);
                      });
                      return;
                    }
                    setChannelMode((current) => current === "goal" ? "chat" : "goal");
                  }}
                  className={cn(
                    "flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors",
                    effectiveChannelMode === "goal"
                      ? "border-accent/35 bg-accent/10 text-accent"
                      : "border-hairline/20 bg-transparent text-ink-secondary hover:bg-raised hover:text-ink",
                  )}
                >
                  <Target size={14} aria-hidden="true" />
                  {effectiveChannelMode === "goal" ? "/goal" : t("composer.goal.chip")}
                </button>
              )}
            </div>
          )}
          <MentionTextarea
          wrapperClassName={cn("@max-[30rem]/composer:order-first @max-[30rem]/composer:basis-full", expanded && "order-first basis-full")}
          inputRef={inputRef}
          peers={group ? members ?? [] : state.bots.filter((member) => member.id !== bot?.id)}
          everyone={Boolean(group && !group.dm)}
          dir="auto"
          rows={1}
          value={text}
          onChange={(e) => {
            editText(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setDismissedAt(null);
            setDismissedSlashAt(null);
            rememberPosition();
          }}
          onPaste={handlePaste}
          onSelect={rememberPosition}
          onScroll={rememberPosition}
          onKeyUp={(e) => {
            setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0);
            rememberPosition();
          }}
          onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          onCompositionStart={suggestion.onCompositionStart}
          onCompositionEnd={suggestion.onCompositionEnd}
          ghost={<TypingGhost text={suggestion.ghost} source={suggestion.source} />}
          onKeyDown={(e) => {
            if (suggestion.onKeyDown(e)) return;
            if (commandPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((current) =>
                  (current + delta + commandCandidates.length) % commandCandidates.length,
                );
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickCommand(commandCandidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedSlashAt(slash?.start ?? null);
                return;
              }
            }
            if (mentionPickerOpen) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                setHighlight((h) => (h + delta + candidates.length) % candidates.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pickMention(candidates[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            if (e.key === "ArrowUp" && !hasContent && onEditLast) {
              e.preventDefault();
              onEditLast();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (doubleEnterSteersQueue(steerAgainUntilRef.current, Date.now(), pendingCount, hasContent)) {
                steerAgainUntilRef.current = 0;
                steerQueued();
                return;
              }
              send();
            }
            if (e.key === "Escape" && recording) stopDictation();
          }}
          disabled={Boolean(approval) || locked}
          aria-busy={bot?.awaitingThreadSnapshot || undefined}
          placeholder={
            setupLocked
              ? t("composer.placeholder.locked")
              : approval
              ? t("composer.placeholder.approval")
              : attachmentPending
              ? t("composer.placeholder.attaching")
              : recording
              ? t("composer.placeholder.listening")
              : busy && canSteer && !asking
                ? pendingCount > 0
                  ? t("composer.placeholder.steerQueued", { name: busyName })
                  : t("composer.placeholder.steer", { name: busyName })
              : busy && !asking
                ? group
                  ? t("composer.placeholder.queueGroup", { name: busyName })
                  : t("composer.placeholder.queue", { name: busyName })
                : group
                  ? channelMode === "goal"
                    ? t("composer.placeholder.goal", { name: group.name })
                    : t("composer.placeholder.group", {
                        name: group.name,
                        hint: groupComposerHint(group, members ?? [], { jevOn: jevRoomRoutingOn(state.config) }),
                      })
                  : t("composer.placeholder.bot", { name: bot?.name ?? "" })
          }
          aria-label={t("composer.placeholder.bot", { name: group ? group.name : (bot?.name ?? "") })}
            className="block max-h-[9rem] min-h-5 w-full resize-none overflow-y-auto bg-transparent px-1 py-1 text-[14px] leading-5 placeholder:text-ink-secondary focus:outline-none"
          />
          <TypingGhostAnnouncement text={suggestion.ghost} />
          <div data-composer-actions className="ml-auto flex items-center gap-1">
          {!locked && bot && !group && <ModelPicker key={bot.threadId} bot={bot} threadId={bot.threadId} above part="model" />}
          {!locked && bot && !group && <EffortButton bot={bot} threadId={bot.threadId} />}
          {(busy || bot?.waitingForTeammates) && !locked && !asking && (
          <button
            onClick={interruptTurn}
            aria-label={t("chat.stopTurn")}
            className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-secondary hover:bg-raised hover:text-ink"
            title={t("chat.stop")}
          >
            <Square size={14} className="fill-current" />
          </button>
        )}
        {!locked && capabilities.dictation.available && (recording || (!busy && !retryingNote)) && (
          <button
            type="button"
            data-composer-mic
            aria-pressed={recording}
            aria-busy={(sharpening > 0 && !recording) || undefined}
            onClick={toggleMic}
            aria-label={recording ? t("composer.dictation.stop") : t("composer.dictation.start")}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full",
              recording
                ? "animate-pulse bg-danger/20 text-danger"
                : "text-ink-secondary hover:bg-raised hover:text-ink",
            )}
            title={recording ? t("composer.dictation.stopHint") : sharpening > 0 ? t("composer.dictation.transcribing") : t("composer.dictation.hint")}
          >
            {sharpening > 0 && !recording ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
          </button>
        )}
        {bot && !group && <CallButton bot={bot} placement="composer" />}
        {!locked && (hasContent || !busy) && (
          <button
            type="button"
            data-composer-send
            onClick={() => send()}
            disabled={attachmentPending || !hasContent}
            aria-label={
              busy && canSteer
                  ? t("composer.send.steer")
                  : busy
                    ? t("composer.send.queue")
                    : t("composer.send.message")
            }
            title={
              busy && canSteer
                  ? t("composer.send.steer")
                  : busy
                    ? t("composer.send.queueHint")
                    : t("chat.send")
            }
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-full text-white transition-colors",
              !hasContent
                ? "cursor-default bg-raised text-ink-tertiary"
                : busy && !canSteer
                  ? "bg-raised text-ink-secondary hover:bg-raised-hover"
                  : "bg-accent hover:brightness-110",
            )}
          >
            {busy && !canSteer ? <Clock size={15} /> : <ArrowUp size={17} />}
          </button>
          )}
          {busy && bot && !group && hasContent && !locked && (
            <SendChoiceMenu
              name={busyName}
              canSteer={canSteer}
              disabled={attachmentPending}
              onChoose={(delivery) => {
                inputRef.current?.focus();
                send(delivery);
              }}
            />
          )}
          </div>
        </div>
        </div>
        </div>
      </div>
      <div className="pointer-events-auto">
      {signingIn && (
        <AddAccountSheet
          sheet={{ step: "signIn", instanceId: signingIn }}
          instances={state.instances}
          onStep={() => {}}
          onClose={() => setSigningIn(null)}
          onSignedIn={() => {
            setSigningIn(null);
            window.setTimeout(() => sendAfterSignIn.current(), 0);
          }}
        />
      )}
      {commandAllowlistTarget && <CommandAllowlistDialog
        key={`${commandAllowlistTarget.botId}:${commandAllowlistTarget.threadId}`}
        {...commandAllowlistTarget}
        onClose={() => setCommandAllowlistTarget(null)}
      />}
      <FullAccessWarning
        open={approvalWarning?.mode === "full"}
        scope="thread"
        onCancel={() => setApprovalWarning(null)}
        onConfirm={() => {
          const target = approvalWarning;
          setApprovalWarning(null);
          if (target?.mode !== "full" || !trustedThreadAccess) return;
          dispatch({ type: "updateTask", botId: target.botId, threadId: target.threadId,
            patch: { approvalMode: "full", confirmFullAccess: true } });
        }}
      />
      <LocalComputerAutoWarning
        open={approvalWarning?.mode === "auto"}
        onCancel={() => setApprovalWarning(null)}
        onConfirm={() => {
          if (approvalWarning?.mode === "auto") {
            dispatch({
              type: "updateTask",
              botId: approvalWarning.botId,
              threadId: approvalWarning.threadId,
              patch: { approvalMode: "auto", acknowledgeLocalAuto: true },
            });
          }
          setApprovalWarning(null);
        }}
      />
      </div>
    </div>
  );
}
