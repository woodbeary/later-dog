export const RFB_BANNER = "RFB 003.008\n";

export class FakeSocket {
  binaryType = "blob";
  closed: { code?: number; reason?: string } | undefined;
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(private readonly banner: string | undefined) {}

  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void {
    const wrapped = options?.once ? (event: unknown) => {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== wrapped));
      listener(event);
    } : listener;
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), wrapped]);
  }

  accept(): void {
    queueMicrotask(() => {
      if (this.banner === undefined) this.emit("close", { code: 1011 });
      else this.emit("message", { data: this.banner });
    });
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}
