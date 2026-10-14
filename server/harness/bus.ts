import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { EVENTS_DIR } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { capThreadLog, currentThreadLogCap } from "../thread-log-rotation.ts";
import { newId, type ProviderInstance, type RuntimeEvent, type RuntimeEventListener } from "../contracts.ts";
import { SavingNoticeOnce } from "../laterdog/saving-notice.ts";

const INCOMPLETE_LOG_MESSAGE =
  "Canonical event history is incomplete: later.dog could not write one or more events to disk. Live updates will continue.";

const DELTA_MERGE_MS = 50;

type TextDelta = Extract<RuntimeEvent, { type: "content.delta" }>;

function sameStream(a: TextDelta, b: TextDelta): boolean {
  return a.provider === b.provider && a.providerInstanceId === b.providerInstanceId && a.turnId === b.turnId &&
    a.itemId === b.itemId && a.streamKind === b.streamKind && a.synthetic === b.synthetic;
}

export class EventBus {
  private listeners = new Set<RuntimeEventListener>();
  private unsubscribes = new Map<string, () => void>();
  private pendingLogWarnings = new Map<string, RuntimeEvent>();
  private pendingText = new Map<string, { event: TextDelta; timer: ReturnType<typeof setTimeout> }>();
  private readonly savingNotices = new SavingNoticeOnce();
  private readonly appendLog: typeof appendFileSync;

  constructor(appendLog: typeof appendFileSync = appendFileSync) {
    this.appendLog = appendLog;
  }

  attach(instances: ProviderInstance[]) {
    for (const instance of instances) {
      this.detach(instance.instanceId);
      const unsub = instance.adapter.onEvent((event) => {
        if (event.provider !== instance.driverKind) {
          console.error(`bus: dropped cross-driver event from ${instance.instanceId}`);
          return;
        }
        this.publish({ ...event, providerInstanceId: instance.instanceId });
      });
      this.unsubscribes.set(instance.instanceId, unsub);
    }
  }

  publish(event: RuntimeEvent) {
    const pending = this.pendingText.get(event.threadId);
    if (event.type === "content.delta") {
      if (pending && sameStream(pending.event, event)) {
        pending.event = { ...pending.event, delta: pending.event.delta + event.delta };
        return;
      }
      if (pending) this.flushThread(event.threadId);
      const timer = setTimeout(() => this.flushThread(event.threadId), DELTA_MERGE_MS);
      timer.unref?.();
      this.pendingText.set(event.threadId, { event, timer });
      return;
    }
    if (pending) this.flushThread(event.threadId);
    this.write(event);
  }

  flush() {
    for (const threadId of Array.from(this.pendingText.keys())) this.flushThread(threadId);
  }

  private flushThread(threadId: string) {
    const pending = this.pendingText.get(threadId);
    if (!pending) return;
    this.pendingText.delete(threadId);
    clearTimeout(pending.timer);
    this.write(pending.event);
  }

  private write(event: RuntimeEvent) {
    const pendingWarning = this.pendingLogWarnings.get(event.threadId);
    const persistedEvents = pendingWarning ? [pendingWarning, redactSecrets(event)] : [redactSecrets(event)];
    try {
      this.appendLog(
        join(EVENTS_DIR, `${event.threadId}.ndjson`),
        persistedEvents.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
        { mode: 0o600 },
      );
      if (pendingWarning) this.pendingLogWarnings.delete(event.threadId);
      capThreadLog(join(EVENTS_DIR, `${event.threadId}.ndjson`), currentThreadLogCap());
    } catch (error) {
      if (!pendingWarning) {
        const warning: RuntimeEvent = {
          eventId: newId(),
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          createdAt: new Date().toISOString(),
          turnId: event.turnId,
          type: "runtime.error",
          message: INCOMPLETE_LOG_MESSAGE,
        };
        this.pendingLogWarnings.set(event.threadId, warning);
        console.error("bus: canonical event log write failed", error);
      }
      const notice = this.savingNotices.next(event.threadId, error);
      if (notice) {
        this.deliver({
          eventId: newId(),
          provider: event.provider,
          providerInstanceId: event.providerInstanceId,
          threadId: event.threadId,
          createdAt: new Date().toISOString(),
          turnId: event.turnId,
          type: "runtime.notice",
          message: notice,
        });
      }
    }
    this.deliver(event);
  }

  private deliver(event: RuntimeEvent) {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (e) {
        console.error("bus: listener threw", e);
      }
    }
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  detachAll() {
    for (const id of this.unsubscribes.keys()) this.detach(id);
  }

  detach(instanceId: string) {
    this.unsubscribes.get(instanceId)?.();
    this.unsubscribes.delete(instanceId);
    this.flush();
  }
}
