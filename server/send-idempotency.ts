import type { Message } from "./store.ts";
import type { SteerQueueReason } from "../shared/wire.ts";
import { z } from "zod";

const sendIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/).optional();

export function parseSendId(value: string | null | undefined): string | undefined {
  const parsed = sendIdSchema.safeParse(value);
  if (!parsed.success) {
    throw Object.assign(new Error("sendId must be a client-generated id"), { status: 400 });
  }
  return parsed.data;
}

export type AcceptedSendMatch =
  | { kind: "none" }
  | { kind: "match"; message: Message }
  | { kind: "conflict" };

export function acceptedSendMatch(
  messages: Message[],
  sendId: string,
  text: string,
  replyToId?: string,
  channelMode?: "chat" | "goal",
): AcceptedSendMatch {
  const message = messages.find((candidate) => candidate.sendId === sendId);
  if (!message) return { kind: "none" };
  if (
    message.role !== "user" ||
    message.kind !== "text" ||
    message.text !== text ||
    message.replyToId !== replyToId ||
    (message.channelMode ?? "chat") !== (channelMode ?? "chat")
  ) {
    return { kind: "conflict" };
  }
  return { kind: "match", message };
}

export interface QueuedSend {
  id: string;
  text: string;
  replyToId?: string;
  mode?: "chat" | "goal";
  reason?: SteerQueueReason;
}

export interface LandedSendSources {
  messages: () => Message[];
  queued: (sendId: string) => QueuedSend | null;
  cancelled: (sendId: string) => boolean;
}

export type LandedSend =
  | { kind: "new" }
  | { kind: "accepted"; message: Message }
  | { kind: "queued"; queued: QueuedSend };

const sendIdTaken = () => Object.assign(new Error("sendId already belongs to another message"), { status: 409 });

export function landedSend(
  sources: LandedSendSources,
  sendId: string | undefined,
  text: string,
  replyToId?: string,
  channelMode?: "chat" | "goal",
): LandedSend {
  if (!sendId) return { kind: "new" };
  if (sources.cancelled(sendId)) {
    throw Object.assign(new Error("this queued sendId was cancelled; send a new message to try again"), { status: 409 });
  }
  const accepted = acceptedSendMatch(sources.messages(), sendId, text, replyToId, channelMode);
  if (accepted.kind === "conflict") throw sendIdTaken();
  if (accepted.kind === "match") return { kind: "accepted", message: accepted.message };
  const queued = sources.queued(sendId);
  if (!queued) return { kind: "new" };
  if (
    queued.text !== text ||
    queued.replyToId !== replyToId ||
    (queued.mode ?? "chat") !== (channelMode ?? "chat")
  ) {
    throw sendIdTaken();
  }
  return { kind: "queued", queued };
}

export class SendSequencer {
  private readonly inFlight = new Map<string, { fingerprint: string; result: Promise<unknown> }>();

  async run<T>(
    key: string | undefined,
    fingerprint: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!key) return work();
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw Object.assign(new Error("sendId already belongs to another message"), { status: 409 });
      }
      return existing.result as Promise<T>;
    }
    const current = work();
    const entry = { fingerprint, result: current };
    this.inFlight.set(key, entry);
    const clear = () => {
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
    };
    void current.then(clear, clear);
    return current;
  }
}

export function sendFingerprint(text: string, replyToId?: string, channelMode?: "chat" | "goal"): string {
  return JSON.stringify([text, replyToId ?? null, channelMode ?? null]);
}
