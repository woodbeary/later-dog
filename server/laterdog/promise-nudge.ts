import type { WireMessage } from "../../shared/wire.ts";

type Message = WireMessage;

export const PROMISE_NUDGE =
  "[later.dog: your turn ended right after you said what you would do next, so none of it has happened yet. " +
  "Do it now and keep going until the work is done. Finish with the result, or say in one line what is stopping you " +
  "or what you need from the person.]";

export const PROMISE_MAX_CHARS = 280;
export const PROMISE_MAX_CLAUSES = 3;
const NUDGED_KEPT = 2_000;

const VERBS = [
  "add", "analyse", "analyze", "apply", "boot", "build", "bump", "call", "capture", "change", "chase", "check", "clean",
  "clone", "collect", "commit", "compare", "compile", "configure", "connect", "continue", "convert", "create", "curl",
  "debug", "deploy", "dig", "dive", "double-check", "download", "draft", "edit", "examine", "explore", "fetch", "figure",
  "find", "finish", "fix", "gather", "generate", "get", "go", "grab", "handle", "head", "hunt", "implement", "inspect",
  "install", "investigate", "isolate", "kick", "launch", "lint", "load", "look", "make", "merge", "migrate", "monitor",
  "move", "open", "patch", "pick", "ping", "poll", "prepare", "pull", "push", "put", "query", "read", "rebuild",
  "recheck", "re-check", "refactor", "reload", "remove", "rename", "render", "reproduce", "rerun", "re-run", "restart",
  "retry", "review", "rewrite", "run", "scaffold", "scan", "search", "see", "send", "set", "sort", "spin", "start",
  "summarize", "sync", "tackle", "take", "test", "trace", "track", "try", "tweak", "typecheck", "update", "upgrade",
  "upload", "verify", "wait", "watch", "wire", "work", "wrap", "write",
];

const GERUNDS = [
  "adding", "analysing", "analyzing", "applying", "booting", "building", "bumping", "calling", "capturing", "changing",
  "chasing", "checking", "cleaning", "cloning", "collecting", "committing", "comparing", "compiling", "configuring",
  "connecting", "continuing", "converting", "creating", "curling", "debugging", "deploying", "digging", "diving",
  "double-checking", "downloading", "drafting", "editing", "examining", "exploring", "fetching", "figuring", "finding",
  "finishing", "fixing", "gathering", "generating", "getting", "going", "grabbing", "handling", "heading", "hunting",
  "implementing", "inspecting", "installing", "investigating", "isolating", "kicking", "launching", "linting", "loading",
  "looking", "making", "merging", "migrating", "monitoring", "moving", "opening", "patching", "picking", "pinging",
  "polling", "preparing", "pulling", "pushing", "putting", "querying", "reading", "rebuilding", "rechecking",
  "re-checking", "refactoring", "reloading", "removing", "renaming", "rendering", "reproducing", "rerunning",
  "re-running", "restarting", "retrying", "reviewing", "rewriting", "running", "scaffolding", "scanning", "searching",
  "sending", "setting", "sorting", "spinning", "starting", "summarizing", "syncing", "tackling", "taking", "testing",
  "tracing", "tracking", "trying", "tweaking", "typechecking", "updating", "upgrading", "uploading", "verifying",
  "waiting", "watching", "wiring", "working", "wrapping", "writing",
];

const ADVERB = String.raw`(?:(?:now|just|still|currently|also|first|then|next|quickly|right away|right now|already|going to)\s+)*`;
const LEAD_IN = String.raw`(?:(?:now|next|then|so|and|first|meanwhile|still)[,:]?\s+)*`;
const FUTURE = String.raw`(?:i'll|i will|i'm going to|i am going to|i'm gonna|i'm about to|i am about to|let me|let's|going to|about to|time to)`;
const STEP_IN = String.raw`(?:go ahead and\s+|start by\s+|get started (?:on|with)\s+|get to\s+)?`;

const FORWARD = [
  new RegExp(String.raw`^${LEAD_IN}${FUTURE}\s+${ADVERB}${STEP_IN}(?:${VERBS.join("|")})\b`),
  new RegExp(String.raw`^${LEAD_IN}(?:i'm|i am)\s+${ADVERB}(?:${GERUNDS.join("|")})\b`),
  new RegExp(String.raw`^${LEAD_IN}(?:${GERUNDS.join("|")})\b`),
  /^(?:next(?: up| step)?|up next)\s*[:,—–-]/,
  /^(?:(?:i'm|i am)\s+)?(?:on it|working on it|continuing|one moment|one sec(?:ond)?|hang on|stand by|bear with me|give me a (?:moment|minute|sec(?:ond)?|few minutes))\b/,
];

const ACK = /^(?:ok(?:ay)?|alright|all right|got it|sure(?: thing)?|right|great|good|perfect|understood|will do|sounds good|on it|thanks|thank you|cool|yes|yep|yeah|absolutely|of course|no problem|happy to help|makes sense|(?:good|great) (?:idea|call|catch|point|question))\b[^.!]{0,30}$/;

const DONE = /\b(?:done|finished|complete|completed|all set|fixed|merged|shipped|deployed|pass|passed|passes|passing|works|resolved|succeeded|ready|booked|sent|saved|scheduled|posted|published|here's|here is|here are|that's it|that's all|nothing (?:else|more|to do)|no (?:changes|issues|problems))\b/;
const BLOCKED = /\b(?:blocked|stuck|can't|cannot|can not|couldn't|could not|unable|won't|will not|not able|need (?:you|your)|needs (?:you|your)|wait(?:ing)? (?:for|on) (?:you|your)|let me know|your call|up to you|if you|when you|once you|after you|you'll need|you will need|you need|you can|you could|you should|you might|you may|please|approve|approval|permission|go-ahead|your go ahead|sign in|log in|password)\b/;
const DEFERRED = /\b(?:stop here|stop there|pause here|pause there|leave it|leave that|hold off|for now|later|tomorrow|tonight|next (?:week|month|time|session)|this (?:evening|afternoon|weekend)|in the morning|from now on|going forward|in (?:the )?future|remember|keep (?:that |this |it )?in mind|make a note|noted|be here|be around|if needed|when needed|whenever)\b/;
const LIST_LINE = /^\s*(?:[-*•]|\d+[.)])\s/m;

function plain(text: string): string {
  return text.replace(/[‘’ʼ]/g, "'").replace(/[*_`]+/g, "").replace(/[ \t]+/g, " ").trim().toLowerCase();
}

function clauses(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!…])\s+|\s+[—–]\s+|\s+-\s+/)
    .map((clause) => clause.replace(/^[\s,;:]+|[\s.!…,;:]+$/g, ""))
    .filter(Boolean);
}

function stripAck(clause: string): string {
  return clause.replace(/^(?:(?:ok(?:ay)?|alright|all right|got it|sure|right|great|good|perfect|understood|cool|yes|yep|yeah|absolutely|of course|on it)[,:!]\s*)+/, "");
}

function forward(clause: string): boolean {
  const bare = stripAck(clause);
  return FORWARD.some((pattern) => pattern.test(bare));
}

export function endsOnPromise(text: string | undefined | null): boolean {
  const raw = text?.trim() ?? "";
  if (!raw || raw.length > PROMISE_MAX_CHARS || raw.includes("?") || raw.includes("```") || LIST_LINE.test(raw)) return false;
  const flat = plain(raw);
  if (DONE.test(flat) || BLOCKED.test(flat) || DEFERRED.test(flat)) return false;
  const parts = clauses(flat);
  if (!parts.length || parts.length > PROMISE_MAX_CLAUSES) return false;
  if (!forward(parts.at(-1)!)) return false;
  return parts.slice(0, -1).every((part) => forward(part) || ACK.test(part));
}

const WAITS_ON_OTHERS = /(?:delegate|cloud_job|cloud_task|schedule|wake|remind|routine|coordinate_bots|request_credential|request_takeover|request_secure_form|propose_)/i;

function asksOrHandsOff(message: Message): boolean {
  if (message.comm || message.threadRef || message.cloudTask || message.connector || message.secret || message.secureForm) return true;
  const card = message.card;
  if (card) return !card.answered && !card.dismissed && !card.expired;
  if (message.kind !== "text" && message.kind !== "activity" && message.kind !== "screen" && message.kind !== "digest" && message.kind !== "compaction") return true;
  const tool = message.tool;
  if (!tool || tool.statusLine) return false;
  if (tool.ok === false && tool.name.startsWith("error:")) return true;
  return message.kind === "activity" && Boolean(tool.itemId) && WAITS_ON_OTHERS.test(tool.name);
}

export function promiseReply(path: readonly Message[], turnId: string, requestMessageId: string): Message | null {
  const at = path.findIndex((message) => message.id === requestMessageId);
  if (at === -1 || path[at]!.role !== "user") return null;
  const after = path.slice(at + 1);
  if (after.some((message) => message.role === "user" && !message.steered)) return null;
  const reply = after.findLast((message) => message.role === "bot" && message.kind === "text");
  if (!reply || reply.turnId !== turnId || reply.attachments?.length) return null;
  if (after.some(asksOrHandsOff)) return null;
  return endsOnPromise(reply.text) ? reply : null;
}

export interface PromiseNudgeHost {
  path(threadId: string): readonly Message[];
  request(threadId: string): string | undefined;
  ownerAutoDog(threadId: string): string | null;
  free(botId: string, threadId: string): boolean;
  start(botId: string, threadId: string, prompt: string, requestMessageId: string): Promise<unknown>;
  defer?: (run: () => void) => void;
  log?: (line: string) => void;
}

export function createPromiseNudges(host: PromiseNudgeHost) {
  const nudged = new Map<string, string>();
  const defer = host.defer ?? ((run: () => void) => { setImmediate(run); });
  const log = host.log ?? ((line: string) => console.info(line));

  const remember = (threadId: string, requestMessageId: string) => {
    nudged.delete(threadId);
    nudged.set(threadId, requestMessageId);
    if (nudged.size > NUDGED_KEPT) nudged.delete(nudged.keys().next().value!);
  };

  const decide = (threadId: string, turnId: string): { botId: string; requestMessageId: string } | null => {
    const requestMessageId = host.request(threadId);
    if (!requestMessageId || nudged.get(threadId) === requestMessageId) return null;
    const botId = host.ownerAutoDog(threadId);
    if (!botId) return null;
    return promiseReply(host.path(threadId), turnId, requestMessageId) ? { botId, requestMessageId } : null;
  };

  return {
    settled(threadId: string, turnId: string): void {
      let plan: ReturnType<typeof decide>;
      try {
        plan = decide(threadId, turnId);
      } catch (error) {
        log(`promise nudge: could not read ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (!plan) return;
      const { botId, requestMessageId } = plan;
      remember(threadId, requestMessageId);
      defer(() => {
        if (host.request(threadId) !== requestMessageId || !host.free(botId, threadId)) {
          log(`promise nudge: ${threadId} moved on before it could carry on`);
          return;
        }
        log(`promise nudge: ${threadId} ended on a promise; carrying on once`);
        void host.start(botId, threadId, PROMISE_NUDGE, requestMessageId).catch((error: unknown) => {
          log(`promise nudge: ${threadId} could not carry on: ${error instanceof Error ? error.message : String(error)}`);
        });
      });
    },

    nudgedFor(threadId: string): string | undefined {
      return nudged.get(threadId);
    },
  };
}

export type PromiseNudges = ReturnType<typeof createPromiseNudges>;
