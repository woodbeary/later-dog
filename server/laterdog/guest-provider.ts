import { randomUUID } from "node:crypto";
import { DATA_DIR } from "../config.ts";
import { newEventId } from "../contracts.ts";
import type { DriverCreateInput, ProviderAdapter, ProviderInstance, RuntimeEventListener, SendTurnInput, TextGenerationOptions, TextGenerationUsage } from "../contracts.ts";
import { engineOpener, notePlacement, recordEngineTurn, remoteEngineChoice, spawnPlacedEngine } from "./engine-placement.ts";
import { engineWaitEvent } from "./engine-waiting.ts";
import { GuestProviderChannel } from "./guest-provider-channel.ts";
import { guestProviderPlan } from "./guest-provider-plan.ts";
import { guestCliProfile } from "./guest-cli-profile.ts";
import { guestHttpProfile } from "./guest-http-profile.ts";

interface ActiveChannel {
  opening: Promise<GuestProviderChannel>;
  channel?: GuestProviderChannel;
  stopped: boolean;
  ready?: boolean;
}

function withMembers<T extends object>(original: T, members: Partial<T>): T {
  return Object.create(Object.getPrototypeOf(original), { ...Object.getOwnPropertyDescriptors(original), ...Object.getOwnPropertyDescriptors(members) });
}

export function placeProvider(instance: ProviderInstance, input: DriverCreateInput<unknown>, dataDir = DATA_DIR): ProviderInstance {
  const driver = instance.driverKind;
  if (process.env.LATERDOG_CLOUD_ROLE !== "home" || driver === "claudeAgent" || driver === "codex") return instance;
  const local = instance.adapter;
  const active = new Map<string, ActiveChannel>();
  const listeners = new Set<RuntimeEventListener>();
  const log = (turn: SendTurnInput, result: string) => notePlacement(dataDir, "[engine] " + JSON.stringify({ driver, account: instance.instanceId, botId: turn.botId, threadId: turn.threadId, messageId: turn.sourceMessageId, placement: result }));
  const open = async (state: ActiveChannel, turn: SendTurnInput) => {
    const profile = await guestHttpProfile(driver, input) ?? await guestCliProfile(driver, input, turn, dataDir);
    if (!profile) throw new Error("This engine does not have a runtime on the dog's computer.");
    if (state.stopped) throw new Error("The turn was interrupted while the computer was starting.");
    const opener = engineOpener();
    if (!opener) throw new Error("The engine cannot reach the dog's computer.");
    const prepared = await guestProviderPlan(dataDir, driver, profile, turn, opener);
    const proc = spawnPlacedEngine(prepared.plan, (plan, signal) => opener.open(turn.botId!, plan, signal), undefined, undefined, undefined, {
      openBudgetMs: opener.openBudgetMs,
      onWaiting: wait => {
        if (turn.threadId.startsWith("writing-")) return;
        const event = { eventId: newEventId(), createdAt: new Date().toISOString(), provider: driver, providerInstanceId: instance.instanceId, threadId: turn.threadId, ...engineWaitEvent(wait) };
        for (const listener of listeners) listener(event);
      },
    });
    const channel = new GuestProviderChannel(proc, driver, instance.instanceId, turn.threadId, dataDir, prepared.turn, event => {
      if (event.type === "turn.started" && event.turnId) recordEngineTurn(dataDir, driver, instance.instanceId, turn, event.turnId, "computer");
      for (const listener of listeners) listener(event);
    });
    state.channel = channel;
    void channel.closed.then(() => { if (active.get(turn.threadId) === state) active.delete(turn.threadId); });
    try {
      await channel.request({ op: "open", driver, input: profile.input, threadId: turn.threadId });
      if (state.stopped) throw new Error("The turn was interrupted while the computer was starting.");
      if (profile.renew) {
        const renew = profile.renew;
        let timer: NodeJS.Timeout;
        let ended = false;
        const schedule = (delay: number) => {
          if (ended) return;
          timer = setTimeout(async () => {
            try {
              const token = await renew();
              if (!ended) await channel.request({ op: "renew", token });
              schedule(40 * 60_000);
            } catch { schedule(60_000); }
          }, delay);
          timer.unref();
        };
        schedule(30 * 60_000);
        void channel.closed.then(() => { ended = true; clearTimeout(timer); });
      }
      state.ready = true;
      return channel;
    } catch (error) {
      await channel.dispose();
      throw error;
    }
  };
  const stop = async (threadId: string, turnId?: string) => {
    const state = active.get(threadId);
    if (!state) return local.interruptTurn(threadId, turnId);
    state.stopped = true;
    if (state.channel?.finishing) { await state.channel.closed; return; }
    if (!state.channel) return;
    if (!state.ready) { state.channel.abort(); await state.channel.closed; return; }
    try { await state.channel.request({ op: "interrupt", turnId }); } finally { await state.channel.dispose(); }
  };
  const stopAll = async () => {
    await Promise.all([...active.keys()].map(id => stop(id)));
    await local.stopAll();
  };
  const adapter = withMembers<ProviderAdapter>(local, {
    async sendTurn(turn) {
      if (!remoteEngineChoice(dataDir, turn.botId ?? "").required) {
        const started = await local.sendTurn(turn);
        recordEngineTurn(dataDir, driver, instance.instanceId, turn, started.turnId, "home");
        return started;
      }
      const previous = active.get(turn.threadId);
      if (previous?.channel?.finishing) await previous.channel.closed;
      if (active.has(turn.threadId)) throw new Error("A turn is already running in this chat.");
      if (!turn.botId) throw new Error("The engine needs a dog to select its computer.");
      const state: ActiveChannel = { opening: Promise.resolve().then(() => open(state, turn)), stopped: false };
      active.set(turn.threadId, state);
      try {
        const channel = await state.opening;
        return await channel.send(channel.turn);
      } catch (error) {
        log(turn, "computer-failed");
        await state.channel?.dispose();
        if (active.get(turn.threadId) === state) active.delete(turn.threadId);
        throw error;
      }
    },
    interruptTurn: stop,
    respondToRequest: async (threadId, requestId, decision) => {
      const state = active.get(threadId);
      return state ? (await state.opening).request({ op: "answer", requestId, decision }) : local.respondToRequest(threadId, requestId, decision);
    },
    ...(local.steer ? { steer: async (threadId, text, images, onRead) => {
      const state = active.get(threadId);
      if (!state) return local.steer!(threadId, text, images, onRead);
      if (images?.length) return "refused";
      return (await state.opening).request({ op: "steer", text }, onRead);
    } } : {}),
    ...(local.stopNativeActor ? { stopNativeActor: async (threadId, actor) => {
      const state = active.get(threadId);
      if (!state) return local.stopNativeActor!(threadId, actor);
      await (await state.opening).request({ op: "stopActor", actor });
    } } : {}),
    ...(local.contextUsage ? { contextUsage: async threadId => {
      const state = active.get(threadId);
      return state ? (await state.opening).request({ op: "context" }) : local.contextUsage!(threadId);
    } } : {}),
    hasSession: threadId => active.has(threadId) || local.hasSession(threadId),
    onEvent(listener) {
      listeners.add(listener);
      const unsubscribe = local.onEvent(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    },
    stopAll,
  });
  const generateText = instance.generateText && (async (prompt: string, options?: TextGenerationOptions) => {
    if (!remoteEngineChoice(dataDir, options?.botId ?? "").required) return instance.generateText!(prompt, options);
    if (!options?.botId) throw new Error("A dog is required to run its writing task.");
    options.signal?.throwIfAborted();
    const turn = { botId: options.botId, threadId: "writing-" + randomUUID(), text: "" };
    const state: ActiveChannel = { opening: Promise.resolve().then(() => open(state, turn)), stopped: false };
    active.set(turn.threadId, state);
    const cancel = () => { state.stopped = true; state.channel?.abort(); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      const channel = await state.opening;
      const result = await channel.request<{ text: string; usage?: TextGenerationUsage }>({ op: "generate", prompt, model: options.model });
      if (result.usage) options.onUsage?.(result.usage);
      log(turn, "computer");
      return result.text;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      await state.channel?.dispose();
      active.delete(turn.threadId);
    }
  });
  return withMembers(instance, { adapter, ...(generateText ? { generateText } : {}), dispose: async () => { await stopAll(); await instance.dispose(); } });
}
