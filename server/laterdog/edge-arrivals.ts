import { capabilitySecret, signCapabilitySync } from "./signed-capability-node.ts";

export const ADMISSION_ROUTE = "/api/internal/coordinator/admission";
export const ARRIVAL_POLL_MS = 250;
export const ARRIVAL_LANES = 16;
const CALL_MS = 10_000;
const TOKEN_MS = 10 * 60_000;
const CONFIGURE_DELAY_MS = 100;

export interface AdmissionSession {
  hash: string;
  id: string;
  scopes: string[];
  expiresAt: number;
}

export interface Arrival {
  id: string;
  dog: string;
  chat: string;
  session: string;
  body: Record<string, unknown>;
  at: number;
}

export interface DeliveredArrival {
  status: number;
  body: Record<string, unknown>;
}

export interface EdgeArrivalsOptions {
  origin: string;
  home: string;
  bootstrapSecret: string;
  sessions(): AdmissionSession[];
  dogs(): string[];
  deliver(arrival: Arrival): Promise<DeliveredArrival>;
  undelivered(arrival: Arrival, why: string): void;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export class EdgeArrivals {
  private readonly options: EdgeArrivalsOptions;
  private readonly secret: Buffer;
  private readonly send: typeof fetch;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private configureTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = true;
  readonly state = { taken: 0, delivered: 0, refused: 0, failures: 0, lastError: null as string | null, configured: 0 };

  constructor(options: EdgeArrivalsOptions) {
    this.options = options;
    this.secret = capabilitySecret(options.bootstrapSecret);
    this.send = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  refresh(): void {
    if (this.configureTimer) return;
    this.configureTimer = setTimeout(() => {
      this.configureTimer = null;
      void this.configure().catch((error) => {
        this.state.failures += 1;
        this.state.lastError = (error as Error).message;
        this.refresh();
      });
    }, CONFIGURE_DELAY_MS);
    this.configureTimer.unref?.();
  }

  async configure(): Promise<void> {
    const dogs = this.options.dogs();
    await this.call({ op: "configure", config: { dogs, sessions: dogs.length ? this.options.sessions() : [] } });
    this.state.configured = this.now();
    if (dogs.length) this.start();
    else this.stop();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async pollOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const answer = await this.call({ op: "take", limit: 50 });
      const arrivals = Array.isArray(answer.arrivals) ? (answer.arrivals as Arrival[]) : [];
      this.state.taken += arrivals.length;
      const done: string[] = [];
      const chats = new Map<string, Arrival[]>();
      for (const arrival of arrivals) {
        const key = `${arrival.dog}\0${arrival.chat}`;
        chats.set(key, [...(chats.get(key) ?? []), arrival]);
      }
      const lanes = [...chats.values()];
      const deliverChat = async (lane: Arrival[]) => {
        for (const arrival of lane) {
          try {
            const delivered = await this.options.deliver(arrival);
            if (delivered.status >= 200 && delivered.status < 300) this.state.delivered += 1;
            else {
              this.state.refused += 1;
              this.options.undelivered(arrival, typeof delivered.body.error === "string" ? delivered.body.error : `answered ${delivered.status}`);
            }
            done.push(arrival.id);
          } catch (error) {
            this.state.failures += 1;
            this.state.lastError = (error as Error).message;
            this.log(`[edge arrivals] ${arrival.id} not delivered yet: ${(error as Error).message}`);
            return;
          }
        }
      };
      const worker = async () => {
        for (let lane = lanes.shift(); lane; lane = lanes.shift()) await deliverChat(lane);
      };
      await Promise.all(Array.from({ length: Math.min(ARRIVAL_LANES, lanes.length) }, worker));
      if (done.length) await this.call({ op: "done", ids: done });
      return arrivals.length;
    } finally {
      this.running = false;
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollOnce().then(
        (count) => this.schedule(count ? 0 : ARRIVAL_POLL_MS),
        (error) => {
          this.state.failures += 1;
          this.state.lastError = (error as Error).message;
          this.schedule(ARRIVAL_POLL_MS * 8);
        },
      );
    }, delay);
    this.timer.unref?.();
  }

  private async call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const at = this.now();
    const token = signCapabilitySync(this.secret, { home: this.options.home, dog: "home", chat: "admission", generation: "admission", kind: "turns", issuedAt: at, expiresAt: at + TOKEN_MS });
    const response = await this.send(`${this.options.origin}${ADMISSION_ROUTE}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_MS),
    });
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || answer.ok !== true) throw new Error(`admission ${String(body.op)} answered ${response.status} ${String(answer.error ?? "")}`.trim());
    return answer;
  }
}
