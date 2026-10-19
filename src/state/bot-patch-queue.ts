import type { Bot, BotAnnouncement } from "./store";

export type BotUpdatePatch = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "soul"
    | "notifications"
    | "cloudBackend"
    | "autoStartVps"
    | "color"
    | "mascotExpression"
    | "mascotBody"
    | "avatarUrl"
    | "avatarCrop"
    | "avatarZoom"
    | "avatarFocusX"
    | "avatarFocusY"
    | "autoApprove"
    | "approvalMode"
    | "fallback"
    | "speakReplies"
    | "voice"
    | "voiceNotes"
    | "pinned"
    | "hidden"
    | "section"
    | "pinnedMessageId"
    | "chiefOfStaff"
    | "approvePeerComms"
    | "composio"
    | "browser"
    | "browserProfile"
    | "memoryUpkeep"
    | "mcpServers"
    | "modelSelection"
  >
> & {
  computer?: Bot["computer"] | null;
  connectorTools?: Bot["connectorTools"] | null;
  acknowledgeLocalAuto?: boolean;
  confirmFullAccess?: boolean;
  applyToAllThreads?: boolean;
};

export type BotStatePatch = Omit<
  BotUpdatePatch,
  "computer" | "connectorTools" | "acknowledgeLocalAuto" | "confirmFullAccess" | "applyToAllThreads"
> & {
  computer?: Bot["computer"];
  connectorTools?: Bot["connectorTools"];
};

interface BotPatchQueueEntry {
  botId: string;
  fallback: BotAnnouncement;
  pending: BotUpdatePatch;
  inFlight: BotUpdatePatch;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  controller: AbortController | null;
  cancelled: boolean;
  idleWaiters: Array<(bot: BotAnnouncement | null) => void>;
}

export interface BotPatchQueueOptions {
  delayMs?: number;
  send: (
    botId: string,
    patch: BotUpdatePatch,
    signal: AbortSignal,
    current: BotAnnouncement,
  ) => Promise<BotAnnouncement>;
  reconcile: (botId: string, signal: AbortSignal) => Promise<BotAnnouncement | null>;
  onAuthoritative: (bot: BotAnnouncement, optimisticOverlay: BotStatePatch) => void;
  onError: (error: Error, botId: string) => void;
}

export interface BotPatchQueue {
  enqueue: (botId: string, patch: BotUpdatePatch, fallback: BotAnnouncement) => void;
  flush: (botId: string) => Promise<BotAnnouncement | null>;
  overlayFor: (botId: string) => BotStatePatch;
  cancel: (botId: string) => void;
  revive: () => void;
  dispose: () => void;
}

const hasFields = (patch: BotUpdatePatch): boolean => Object.keys(patch).length > 0;
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const isAbortError = (error: unknown): boolean =>
  Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");

const stateOverlay = (patch: BotUpdatePatch): BotStatePatch => {
  const {
    acknowledgeLocalAuto: _localAck,
    confirmFullAccess: _fullConfirmation,
    applyToAllThreads: _allThreads,
    computer,
    connectorTools,
    ...fields
  } = patch;
  const normalized: BotStatePatch = { ...fields };
  if (computer === null) normalized.computer = undefined;
  else if (computer !== undefined) normalized.computer = computer;
  if (connectorTools === null) normalized.connectorTools = undefined;
  else if (connectorTools !== undefined) normalized.connectorTools = connectorTools;
  return normalized;
};

export function createBotPatchQueue(options: BotPatchQueueOptions): BotPatchQueue {
  const entries = new Map<string, BotPatchQueueEntry>();
  const delayMs = options.delayMs ?? 400;
  let disposed = false;

  const settleIfIdle = (entry: BotPatchQueueEntry) => {
    if (entry.running || entry.timer !== null || hasFields(entry.pending)) return;
    entries.delete(entry.botId);
    for (const resolve of entry.idleWaiters.splice(0)) resolve(entry.fallback);
  };

  const drain = async (entry: BotPatchQueueEntry): Promise<void> => {
    if (disposed || entry.running || entry.timer !== null || !hasFields(entry.pending)) return;
    entry.running = true;
    const patch = entry.pending;
    entry.pending = {};
    entry.inFlight = patch;
    const controller = new AbortController();
    entry.controller = controller;

    try {
      const bot = await options.send(entry.botId, patch, controller.signal, entry.fallback);
      if (disposed || entry.cancelled) return;
      entry.fallback = bot;
      options.onAuthoritative(bot, stateOverlay(entry.pending));
    } catch (caught) {
      if (!disposed && !entry.cancelled) {
        const supersededApproval = controller.signal.aborted &&
          hasOwn(entry.pending, "approvalMode") &&
          isAbortError(caught);
        if (supersededApproval) return;
        entry.inFlight = {};
        let bot: BotAnnouncement | null = entry.fallback;
        try {
          bot = await options.reconcile(entry.botId, controller.signal);
          if (bot) entry.fallback = bot;
        } catch {}
        if (disposed || entry.cancelled) return;
        if (bot) options.onAuthoritative(bot, stateOverlay(entry.pending));
        options.onError(caught instanceof Error ? caught : new Error(String(caught)), entry.botId);
      }
    } finally {
      entry.controller = null;
      entry.inFlight = {};
      entry.running = false;
      if (!disposed && !entry.cancelled) {
        if (hasFields(entry.pending) && entry.timer === null) void drain(entry);
        settleIfIdle(entry);
      }
    }
  };

  const schedule = (entry: BotPatchQueueEntry) => {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void drain(entry);
    }, delayMs);
  };

  return {
    enqueue(botId, patch, fallback) {
      if (disposed || !hasFields(patch)) return;
      const entry = entries.get(botId) ?? {
        botId,
        fallback,
        pending: {},
        inFlight: {},
        timer: null,
        running: false,
        controller: null,
        cancelled: false,
        idleWaiters: [],
      };
      entries.set(botId, entry);
      entry.pending = { ...entry.pending, ...patch };
      const inFlightMode = entry.inFlight.approvalMode;
      if (
        entry.running &&
        (inFlightMode === "full" || inFlightMode === "custom") &&
        hasOwn(patch, "approvalMode") &&
        patch.approvalMode !== inFlightMode
      ) {
        entry.controller?.abort();
      }
      const immediate = Object.prototype.hasOwnProperty.call(patch, "approvalMode") ||
        Object.prototype.hasOwnProperty.call(patch, "modelSelection") ||
        Object.prototype.hasOwnProperty.call(patch, "connectorTools");
      if (immediate) {
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.timer = null;
        void drain(entry);
      } else {
        schedule(entry);
      }
    },

    flush(botId) {
      const entry = entries.get(botId);
      if (!entry) return Promise.resolve(null);
      if (entry.timer !== null) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      const idle = new Promise<BotAnnouncement | null>((resolve) => entry.idleWaiters.push(resolve));
      void drain(entry);
      settleIfIdle(entry);
      return idle;
    },

    overlayFor(botId) {
      const entry = entries.get(botId);
      return entry ? stateOverlay({ ...entry.inFlight, ...entry.pending }) : {};
    },

    cancel(botId) {
      const entry = entries.get(botId);
      if (!entry) return;
      entry.cancelled = true;
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.controller?.abort();
      entries.delete(botId);
      for (const resolve of entry.idleWaiters.splice(0)) resolve(null);
    },

    revive() {
      disposed = false;
    },

    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        entry.cancelled = true;
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.controller?.abort();
        for (const resolve of entry.idleWaiters.splice(0)) resolve(null);
      }
      entries.clear();
    },
  };
}
