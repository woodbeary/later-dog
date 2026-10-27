import { newEventId, newId } from "../contracts.ts";
import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  RuntimeEvent,
  RuntimeEventListener,
} from "../contracts.ts";
import { MAC_RELAY_INSTANCE_ID, MacRelayQueue } from "../laterdog/mac-relay.ts";

export const macRelayQueue = new MacRelayQueue();

const MODELS = {
  default: MAC_RELAY_INSTANCE_ID,
  options: [{ id: MAC_RELAY_INSTANCE_ID, label: "This Mac, relayed" }],
};

export const MacRelayDriver: ProviderDriver<Record<string, never>> = {
  driverKind: MAC_RELAY_INSTANCE_ID,
  metadata: { displayName: "This Mac (relayed)" },
  models: MODELS,
  decodeConfig: () => ({}),
  defaultConfig: () => ({}),
  async create(input: DriverCreateInput<Record<string, never>>): Promise<ProviderInstance> {
    const listeners = new Set<RuntimeEventListener>();
    const emit = (event: RuntimeEvent) => { for (const listener of Array.from(listeners)) listener(event); };
    return {
      instanceId: input.instanceId,
      driverKind: MAC_RELAY_INSTANCE_ID,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot: async () => ({ state: "available" }),
      adapter: {
        provider: MAC_RELAY_INSTANCE_ID,
        capabilities: { sessionModelSwitch: "unsupported" },
        async sendTurn(turnInput) {
          const turnId = newId();
          const base = {
            provider: MAC_RELAY_INSTANCE_ID,
            providerInstanceId: input.instanceId,
            threadId: turnInput.threadId,
            createdAt: new Date().toISOString(),
            turnId,
          };
          emit({ ...base, eventId: newEventId(), type: "turn.started" });
          const botId = turnInput.botId ?? input.instanceId;
          macRelayQueue.requestTurn(botId, turnInput.threadId, turnInput.text).then(
            (text) => {
              emit({ ...base, eventId: newEventId(), type: "item.completed", itemType: "assistant_text", text });
              emit({ ...base, eventId: newEventId(), type: "turn.completed", ok: true });
            },
            (error: unknown) => {
              emit({ ...base, eventId: newEventId(), type: "runtime.error", message: error instanceof Error ? error.message : String(error) });
              emit({ ...base, eventId: newEventId(), type: "turn.completed", ok: false });
            },
          );
          return { turnId };
        },
        async interruptTurn() {},
        async respondToRequest() { return "unavailable" as const; },
        hasSession: () => false,
        async stopAll() {},
        onEvent: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
      dispose: async () => { listeners.clear(); },
    };
  },
};
