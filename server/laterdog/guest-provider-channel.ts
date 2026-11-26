import { createInterface } from "node:readline";
import { newEventId, type RuntimeEvent, type RuntimeEventListener, type SendTurnInput } from "../contracts.ts";
import type { GuestRequest } from "./guest-provider-types.ts";
import type { EngineProcess } from "./engine-remote.ts";

export class GuestProviderChannel {
  private sequence = 0;
  private readonly pending = new Map<number, { done: (value: unknown) => void; fail: (error: Error) => void; read?: () => void }>();
  private ended = false;
  private turnId?: string;
  private completion?: Extract<RuntimeEvent, { type: "turn.completed" }>;
  private sending = false;
  private disposing?: Promise<void>;
  readonly closed: Promise<void>;

  private readonly engine: EngineProcess;
  private readonly driver: string;
  private readonly instanceId: string;
  private readonly threadId: string;
  readonly turn: SendTurnInput;
  private readonly publish: RuntimeEventListener;

  constructor(engine: EngineProcess, driver: string, instanceId: string, threadId: string, turn: SendTurnInput, publish: RuntimeEventListener) {
    this.engine = engine;
    this.driver = driver;
    this.instanceId = instanceId;
    this.threadId = threadId;
    this.turn = turn;
    this.publish = publish;
    const lines = createInterface({ input: engine.stdout });
    lines.on("line", line => this.receive(line));
    engine.stderr.resume();
    this.closed = new Promise(resolve => engine.once("close", () => {
      this.ended = true;
      const reason = engine.notDispatched ? "The computer could not start the engine." : "The connection to the engine on this dog's computer ended.";
      const error = new Error(reason);
      for (const call of this.pending.values()) call.fail(error);
      this.pending.clear();
      if (this.completion && engine.exitCode === 0) publish(this.completion);
      else if (this.turnId) {
        const base = { threadId, turnId: this.turnId, provider: driver, providerInstanceId: instanceId, createdAt: new Date().toISOString() };
        publish({ ...base, eventId: newEventId(), type: "runtime.error", message: reason, terminal: true });
        publish({ ...base, eventId: newEventId(), type: "turn.completed", ok: false, stopReason: "disconnected" });
      }
      resolve();
    }));
  }

  private receive(line: string) {
    let frame: { id?: number; read?: number; event?: RuntimeEvent; value?: unknown; error?: string };
    try { frame = JSON.parse(line); } catch { return; }
    const event = frame.event;
    if (event) {
      if (event.threadId !== this.threadId || event.provider !== this.driver || (event.providerInstanceId && event.providerInstanceId !== this.instanceId)) return;
      if (event.type === "turn.started") this.turnId = event.turnId;
      if (event.type === "turn.completed") {
        this.completion = { ...event, providerInstanceId: this.instanceId };
        if (!this.sending) void this.dispose();
      } else this.publish({ ...event, providerInstanceId: this.instanceId });
      return;
    }
    if (frame.read !== undefined) { this.pending.get(frame.read)?.read?.(); return; }
    if (frame.id === undefined) return;
    const call = this.pending.get(frame.id);
    if (!call) return;
    this.pending.delete(frame.id);
    if (typeof frame.error === "string") call.fail(new Error(frame.error));
    else call.done(frame.value);
  }

  request<T>(request: GuestRequest, read?: () => void): Promise<T> {
    if (this.ended) return Promise.reject(new Error("The engine connection has ended."));
    const id = ++this.sequence;
    return new Promise((done, fail) => {
      this.pending.set(id, { done: value => done(value as T), fail, read });
      this.engine.stdin.write(JSON.stringify({ id, request }) + "\n", error => {
        if (!error) return;
        this.pending.delete(id);
        fail(error);
      });
    });
  }

  async send(turn: Extract<GuestRequest, { op: "send" }>["turn"]) {
    this.sending = true;
    try {
      const result = await this.request<{ turnId: string }>({ op: "send", turn });
      this.turnId = result.turnId;
      return result;
    } finally {
      this.sending = false;
      if (this.completion) void this.dispose();
    }
  }

  abort() { this.engine.kill(); }

  get finishing() { return Boolean(this.completion) || Boolean(this.disposing); }

  dispose(): Promise<void> {
    return this.disposing ??= (async () => {
      if (this.ended) return;
      const timer = setTimeout(() => this.engine.kill(), 12_000);
      timer.unref();
      try { await this.request({ op: "dispose" }); } catch {} finally {
        clearTimeout(timer);
        this.engine.stdin.end();
      }
      await this.closed;
    })();
  }
}
