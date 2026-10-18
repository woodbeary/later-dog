import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AudioLines, Loader2, PhoneOff, X } from "lucide-react";

import { useStore, visibleMessages, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { useMenuMotion } from "./MenuMotion";
import { currentCall, deferCallCleanup, endCall, startCall, useOnCall } from "@/lib/call";
import { callRoute, callVoiceReady } from "@/lib/call-route";
import { NO, YES } from "../../shared/call-consent";
import { hangUpLiveCall, isLiveCallRunning, startLiveCall, useLiveMedia } from "@/lib/live-call-media";
import { t } from "@/lib/i18n";
import { speaker } from "@/lib/tts";
import { useSpeech } from "@/lib/tts/useSpeech";
import { usePushToTalk } from "@/lib/push-to-talk";
import { BotAvatar } from "./Avatar";
import { liveLineHeldElsewhere } from "./LiveCallBar";
import { isRoutineApproval, isSkillApproval, pendingApprovals, spokenApprovalPrompt } from "./PendingApproval";
import { track } from "@/lib/analytics";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { callSpeechMissing } from "@/lib/call-capability";
import { VoiceSetupDialog } from "./VoiceSetupDialog";

type Phase = "listening" | "sending" | "working" | "speaking";
const CALL_ENDPOINT_MS = 850;

export function CallButton({ bot }: { bot: Bot }) {
  const { state } = useStore();
  const { capabilities, ready: capabilitiesReady } = useDesktopCapabilities();
  const media = useLiveMedia();
  const liveRunning = isLiveCallRunning(media.phase);
  const onLiveCall = liveRunning && media.botId === bot.id;
  const liveElsewhere = liveRunning && media.botId !== bot.id;
  const onCall = useOnCall() === bot.id;
  const active = onCall || onLiveCall;
  const voiceReady = callVoiceReady(state.config?.tts, bot.voice);
  const route = callRoute({
    capabilitiesReady,
    speechMissing: capabilitiesReady ? callSpeechMissing(capabilities, Boolean(window.laterdog?.speechStart)) : null,
    voiceReady,
    liveConfigured: state.config?.live?.configured === true,
    name: bot.name,
  });
  const lineHeld = route.kind === "live" && !active && liveLineHeldElsewhere(media, state.liveCall);
  const blocked = liveElsewhere || lineHeld;
  const unavailable = !active && !blocked && (route.kind === "unavailable" || route.kind === "checking");
  const [helpOpen, setHelpOpen] = useState(false);
  const [voiceSetupOpen, setVoiceSetupOpen] = useState(false);
  const helpMotion = useMenuMotion(unavailable && helpOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const helpId = useId();
  const elsewhereName = liveElsewhere ? state.bots.find((candidate) => candidate.id === media.botId)?.name : undefined;
  const label = active
    ? t("call.hangUpOn", { name: bot.name })
    : blocked
      ? elsewhereName ? t("call.live.pill", { name: elsewhereName }) : t("call.live.badge")
      : unavailable
        ? t("call.unavailable.title")
        : t("call.start");
  const reason = route.kind === "unavailable" ? route.reason : t("call.unavailable.checking");

  useEffect(() => {
    if (!helpOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setHelpOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHelpOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [helpOpen]);

  const startTurns = () => {
    track("call_started", { driver: bot.modelSelection?.instanceId, mode: "turns" });
    startCall(bot.id);
  };

  const press = () => {
    if (onLiveCall) return void hangUpLiveCall();
    if (onCall) return endCall(bot.id);
    if (route.kind === "live") {
      track("call_started", { driver: bot.modelSelection?.instanceId, mode: "live" });
      return void startLiveCall({ botId: bot.id, threadId: bot.threadId });
    }
    if (route.kind === "turns") return startTurns();
    setHelpOpen((open) => !open);
  };

  return (
    <div ref={rootRef} className="relative flex items-center">
      <button
        ref={buttonRef}
        type="button"
        disabled={blocked || (onLiveCall && media.phase === "ending")}
        onClick={press}
        aria-expanded={unavailable ? helpOpen : undefined}
        aria-controls={unavailable ? helpId : undefined}
        aria-label={label}
        title={label}
        data-call-button=""
        data-call-route={route.kind}
        className={cn(
          "relative flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:opacity-60",
          active
            ? "bg-danger text-white hover:brightness-110"
            : unavailable
              ? "bg-control text-ink-tertiary hover:text-ink-secondary"
              : "bg-control text-ink hover:bg-raised",
        )}
      >
        {active ? <PhoneOff size={15} /> : <AudioLines size={16} aria-hidden="true" />}
      </button>

      {helpMotion.shown && (
        <div
          id={helpId}
          role="group"
          aria-label={t("call.unavailable.title")}
          data-call-unavailable=""
          className={cn("absolute bottom-full right-0 z-30 mb-1.5 w-[280px] origin-bottom-right rounded-menu border border-hairline bg-panel p-3 text-left shadow-popover", helpMotion.className)} {...helpMotion.exitProps}
        >
          <div className="text-[13px] font-medium text-ink">{t("call.unavailable.title")}</div>
          <div className="mt-1 text-[12px] leading-[1.45] text-ink-secondary">{reason}</div>
          {route.kind === "unavailable" && route.needsVoice && (
            <button
              type="button"
              aria-haspopup="dialog"
              data-voice-setup-open=""
              onClick={() => {
                setHelpOpen(false);
                setVoiceSetupOpen(true);
              }}
              className="mt-2.5 rounded-lg border border-hairline px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-raised"
            >
              {t("call.voiceSetup.open")}
            </button>
          )}
        </div>
      )}

      {voiceSetupOpen && (
        <VoiceSetupDialog
          bot={bot}
          callName={bot.name}
          ready={route.kind === "turns"}
          returnFocusRef={buttonRef}
          onClose={() => setVoiceSetupOpen(false)}
          onStartCall={() => {
            setVoiceSetupOpen(false);
            if (route.kind === "turns") startTurns();
          }}
        />
      )}
    </div>
  );
}

export function CallOverlay({ bot }: { bot: Bot }) {
  const active = useOnCall() === bot.id;
  const media = useLiveMedia();
  const onLiveCall = media.botId === bot.id && isLiveCallRunning(media.phase);
  if (!active || onLiveCall) return null;
  return (
    <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-6 bg-app/95 backdrop-blur-sm">
      <Call key="turns" bot={bot} />
    </div>
  );
}

function Call({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const speech = useSpeech();
  const initialPhase: Phase = bot.busy ? "working" : "listening";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [heard, setHeard] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const pushToTalk = usePushToTalk(bot.id, phase === "listening", () => {
    setNote("Push to talk couldn't start. Check Microphone and Speech Recognition access.");
  });

  const messages = visibleMessages(bot);
  const approval = pendingApprovals(messages)[0];
  const question = messages.find(
    (message) =>
      message.kind === "options" &&
      message.card?.requestId &&
      !message.card.tool &&
      !message.card.answered &&
      !message.card.dismissed,
  );

  const spokenIds = useRef<Set<string>>(new Set());
  const started = useRef(false);
  if (!started.current) {
    started.current = true;
    for (const m of messages) spokenIds.current.add(m.id);
  }

  const askedApproval = useRef<{
    requestId: string;
    routine: boolean;
    skill: boolean;
    submitted: boolean;
  } | null>(null);
  const askedQuestion = useRef<{ requestId: string; messageId: string } | null>(null);
  const phaseRef = useRef<Phase>(initialPhase);
  const alive = useRef(true);
  const sayGeneration = useRef(0);

  const move = useCallback((next: Phase) => {
    phaseRef.current = next;
    if (alive.current) setPhase(next);
  }, []);

  const hush = useCallback(() => {
    void window.laterdog?.speechStop();
  }, []);

  const listen = useCallback(() => {
    if (!alive.current || currentCall() !== bot.id) return;
    move("listening");
    setHeard("");
    setNote(null);
    void window.laterdog?.speechStart({ endpointMs: CALL_ENDPOINT_MS }).catch(() => {
      if (alive.current && currentCall() === bot.id) {
        setNote("The microphone couldn't start. Check Microphone and Speech Recognition access.");
      }
    });
  }, [bot.id, move]);

  const say = useCallback(
    async (text: string) => {
      if (!alive.current || currentCall() !== bot.id) return false;
      const mine = ++sayGeneration.current;
      move("speaking");
      hush();
      await speaker.speak(text, { botId: bot.id, voiceId: bot.voice });
      return alive.current && currentCall() === bot.id && sayGeneration.current === mine;
    },
    [bot.id, bot.voice, hush, move],
  );

  const sayThenListen = useCallback(
    async (text: string) => {
      const stillMine = await say(text);
      if (stillMine && phaseRef.current === "speaking") listen();
    },
    [listen, say],
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sayGeneration.current += 1;
      deferCallCleanup(bot.id, () => alive.current);
    };
  }, [bot.id]);

  useEffect(() => {
    const bridge = window.laterdog;
    if (!bridge) return;
    const offTranscript = bridge.onSpeechTranscript((line) => {
      if (!alive.current || currentCall() !== bot.id || phaseRef.current !== "listening") return;
      if (line.error) {
        setNote("Dictation stopped unexpectedly. Check Microphone and Speech Recognition access.");
        return;
      }
      if (typeof line.text !== "string") return;
      setHeard(line.text);
      if (line.partial !== false) return;
      const said = line.text.trim();
      if (!said) return listen();

      const open = askedApproval.current;
      if (open) {
        if (open.submitted) {
          move("working");
          hush();
          return;
        }
        if (YES.test(said) || NO.test(said)) {
          const allow = YES.test(said);
          if (allow && open.skill) {
            setHeard("");
            void sayThenListen("Open this chat to review the complete trick before enabling it. You can say no now to deny it.");
            return;
          }
          open.submitted = true;
          move("working");
          hush();
          setHeard("");
          dispatch({
            type: "decideRequest",
            threadId: bot.threadId,
            requestId: open.requestId,
            behavior: allow ? "allow" : "deny",
            message: allow ? undefined : "Declined on a call.",
            onError: (error: string) => {
              const pending = askedApproval.current;
              if (
                !alive.current ||
                currentCall() !== bot.id ||
                pending?.requestId !== open.requestId ||
                !pending.submitted
              ) return;
              pending.submitted = false;
              const detail = error.trim().slice(0, 240);
              const decision = open.routine ? "routine decision" : "approval";
              void sayThenListen(
                `I couldn't save that ${decision}${detail ? `: ${detail}` : "."} Please try again.`,
              );
            },
          });
          return;
        }
        void sayThenListen("Sorry — is that a yes or a no?");
        return;
      }

      const openQuestion = askedQuestion.current;
      if (openQuestion) {
        askedQuestion.current = null;
        dispatch({ type: "answerCard", botId: bot.id, threadId: bot.threadId, messageId: openQuestion.messageId, answer: said });
        move("working");
        return;
      }

      move("sending");
      dispatch({ type: "send", botId: bot.id, text: said, threadId: bot.threadId });
    });
    const offEnd = bridge.onSpeechEnd(({ code, reason }) => {
      if (!alive.current || currentCall() !== bot.id) return;
      if (code === 2) {
        setNote("Calls need macOS dictation, which isn't available here yet.");
        return;
      }
      if (code === 1) {
        setNote(
          reason === "helper-build-failed"
            ? "The dictation helper couldn't be built. Install Apple's Command Line Tools and try again."
            : reason === "dictation-disabled"
              ? "Turn on Dictation in System Settings → Keyboard, then try again."
              : reason === "speech-not-authorized"
                ? "Allow Speech Recognition in System Settings → Privacy & Security, then try again."
                : "Dictation couldn't start. Try again.",
        );
        return;
      }
      if (phaseRef.current === "listening") listen();
    });
    if (bot.busy && !approval && !question) move("working");
    else listen();
    return () => {
      offTranscript();
      offEnd();
      void window.laterdog?.speechStop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id, bot.threadId, dispatch, hush, listen, move, sayThenListen]);

  useEffect(() => {
    let resumeAfterRoutine = false;
    if (askedApproval.current && approval?.requestId !== askedApproval.current.requestId) {
      resumeAfterRoutine = askedApproval.current.routine && askedApproval.current.submitted;
      askedApproval.current = null;
    }
    if (askedQuestion.current && question?.card?.requestId !== askedQuestion.current.requestId) {
      askedQuestion.current = null;
    }
    if (!approval && !question && bot.busy && phaseRef.current === "listening") {
      move("working");
      hush();
    }
    if (resumeAfterRoutine && !approval && !question && !bot.busy) {
      listen();
      return;
    }
    if (askedApproval.current?.submitted) return;
    if (approval && askedApproval.current?.requestId !== approval.requestId && phase !== "speaking") {
      askedApproval.current = {
        requestId: approval.requestId,
        routine: isRoutineApproval(approval),
        skill: isSkillApproval(approval),
        submitted: false,
      };
      spokenIds.current.add(approval.message.id);
      const skillPrompt = approval.message.card?.skillRequest?.action === "update"
        ? `${bot.name} wants to update a learned trick. Open this chat to review the complete trick before replacing the current version. You can say no to deny it.`
        : `${bot.name} wants to enable a new learned trick. Open this chat to review the complete trick before enabling it. You can say no to deny it.`;
      void sayThenListen(isSkillApproval(approval) ? skillPrompt : spokenApprovalPrompt(approval, bot.name));
      return;
    }
    if (
      question?.card?.requestId &&
      askedQuestion.current?.requestId !== question.card.requestId &&
      phase !== "speaking"
    ) {
      askedQuestion.current = { requestId: question.card.requestId, messageId: question.id };
      spokenIds.current.add(question.id);
      const detail = question.card.subtitle.trim();
      const choices = question.card.options.length
        ? ` The options are ${question.card.options.join(", ")}.`
        : "";
      void sayThenListen(`${bot.name} asks: ${detail}${/[.!?]$/.test(detail) ? "" : "."}${choices}`);
      return;
    }
    const fresh = messages.filter((m) => !spokenIds.current.has(m.id));
    if (!fresh.length) return;
    const reply = [...fresh].reverse().find((m) => m.role === "bot" && m.kind === "text" && m.text?.trim());
    const chip = [...fresh].reverse().find((m) => m.kind === "activity" && m.tool?.spoken);
    for (const m of fresh) spokenIds.current.add(m.id);

    if (reply?.text) {
      void sayThenListen(reply.text);
    } else if (chip?.tool?.spoken && phase === "working") {
      void say(chip.tool.spoken).then((stillMine) => {
        if (stillMine && phaseRef.current === "speaking") move("working");
      });
    }
  }, [messages, approval, question, phase, bot.busy, bot.name, hush, listen, move, say, sayThenListen]);

  useEffect(() => {
    if (bot.busy) {
      if (phaseRef.current !== "speaking" && !askedApproval.current && !askedQuestion.current) {
        move("working");
        hush();
      }
    } else if (
      phaseRef.current === "working" &&
      !askedApproval.current &&
      !askedQuestion.current &&
      !speaker.isSpeaking()
    ) {
      listen();
    }
  }, [bot.busy, hush, listen, move]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        endCall(bot.id);
      } else if (e.code === "Space" && speaker.isSpeaking()) {
        e.preventDefault();
        sayGeneration.current += 1;
        speaker.stop();
        listen();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [bot.id, listen]);

  const mascotState =
    phase === "listening" ? "listening" : phase === "speaking" ? "sending" : phase === "sending" ? "thinking" : "working";
  const status =
    phase === "listening"
      ? pushToTalk
        ? "Push to talk"
        : "Listening"
      : phase === "sending"
        ? "One moment"
        : phase === "speaking"
          ? bot.name
          : "Working";

  return (
    <>
      <button
        onClick={() => endCall(bot.id)}
        aria-label="Hang up"
        className="absolute right-5 top-5 rounded-md p-2 text-ink-secondary hover:bg-raised hover:text-ink"
      >
        <X size={18} />
      </button>

      <BotAvatar bot={bot} state={mascotState} size={220} animated trackPointer />

      <div className="flex flex-col items-center gap-1.5 text-center">
        <div className="text-[20px] font-medium text-ink">{bot.name}</div>
        <div className="flex items-center gap-2 text-[13.5px] text-ink-secondary">
          {(phase === "working" || phase === "sending") && <Loader2 size={13} className="animate-spin" />}
          {status}
        </div>
      </div>

      <div className="min-h-[3.5rem] max-w-[560px] px-6 text-center text-[15px] leading-relaxed text-ink">
        {phase === "listening" ? (
          heard || (
            <span className="text-ink-secondary">
              {pushToTalk ? "Release Control + Option to send…" : "Say something…"}
            </span>
          )
        ) : (
          speech.caption
        )}
      </div>

      {note && (
        <div className="flex max-w-[460px] flex-col items-center gap-2 text-center text-[12.5px] text-warning">
          <span>{note}</span>
          <button
            onClick={listen}
            className="rounded-full border border-warning/40 px-3 py-1.5 text-[12px] hover:bg-warning/10"
          >
            Try microphone again
          </button>
        </div>
      )}
      {speech.error && <div className="max-w-[420px] text-center text-[12.5px] text-danger">{speech.error}</div>}

      <div className="flex items-center gap-3">
        {speaker.isSpeaking() && (
          <button
            onClick={() => {
              sayGeneration.current += 1;
              speaker.stop();
              listen();
            }}
            className="rounded-full border border-hairline/50 px-4 py-2 text-[13.5px] text-ink hover:bg-raised"
          >
            Interrupt
          </button>
        )}
        <button
          onClick={() => endCall(bot.id)}
          className="flex items-center gap-2 rounded-full bg-danger px-5 py-2.5 text-[14px] font-medium text-white hover:brightness-110"
        >
          <PhoneOff size={16} /> Hang up
        </button>
      </div>

      <div className="text-[11.5px] text-ink-tertiary">
        Hold Control + Option to talk · Space interrupts · Esc hangs up
      </div>
    </>
  );
}
