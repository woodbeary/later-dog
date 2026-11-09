import { parseExec, type ExecInput } from "./inputs";

export interface StreamingProcess {
  exitCode: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  kill(signal: number): void;
}

export interface ProcessStreamHost {
  start(input: ExecInput, stdin: ReadableStream<Uint8Array>): Promise<StreamingProcess>;
  active(): void;
  finished(): void;
}

const MAX_FRAME = 1024 * 1024;
const MAX_QUEUED = 4 * MAX_FRAME;
const MAX_PROCESS_MS = 2 * 60 * 60_000;

export function serveProcessStream(request: Request, host: ProcessStreamHost): Response {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
  const pair = new WebSocketPair();
  const client = pair[0];
  const socket = pair[1];
  socket.accept();
  runProcessStream(socket as unknown as StreamSocket, host);
  return new Response(null, { status: 101, webSocket: client });
}

export interface StreamSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void;
}

/** One process per socket: a start frame, then stdin in and stdout/stderr/exit out. */
export function runProcessStream(socket: StreamSocket, host: ProcessStreamHost): void {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stdin = new ReadableStream<Uint8Array>({ start(value) { controller = value; } }, { highWaterMark: MAX_QUEUED, size: chunk => chunk.byteLength });
  let child: StreamingProcess | undefined;
  let started = false;
  let closed = false;
  let lastActive = Date.now();
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const send = (value: unknown) => { if (!closed) socket.send(JSON.stringify(value)); };
  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(deadline);
    try { controller.close(); } catch {}
    if (child) {
      try { child.kill(15); } catch {}
      killTimer = setTimeout(() => { try { child?.kill(9); } catch {} }, 5_000);
    }
    try { socket.close(1000, "Process stream ended"); } catch {}
    host.finished();
  };
  const heartbeat = setInterval(() => {
    if (Date.now() - lastActive > 45_000) { stop(); return; }
    host.active();
    send({ channel: "ping" });
  }, 15_000);
  const deadline = setTimeout(stop, MAX_PROCESS_MS);
  const pump = async (stream: ReadableStream<Uint8Array> | null, channel: string) => {
    if (!stream) return;
    const reader = stream.getReader();
    try {
      while (!closed) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (let offset = 0; offset < chunk.value.byteLength; offset += 48 * 1024) {
          const bytes = chunk.value.subarray(offset, offset + 48 * 1024);
          let text = "";
          for (const byte of bytes) text += String.fromCharCode(byte);
          send({ channel, data: btoa(text) });
        }
      }
    } finally { reader.releaseLock(); }
  };
  socket.addEventListener("message", event => {
    if (closed) return;
    if (typeof event.data !== "string" || event.data.length > MAX_FRAME) { stop(); return; }
    lastActive = Date.now();
    host.active();
    let frame: { channel?: string; data?: string; input?: unknown };
    try { frame = JSON.parse(event.data); } catch { stop(); return; }
    if (frame.channel === "pong") return;
    if (!started) {
      if (frame.channel !== "start") { stop(); return; }
      const parsed = parseExec(frame.input);
      if (!parsed.ok) { send({ channel: "error", message: parsed.refusal.message }); stop(); return; }
      started = true;
      void (async () => {
        try {
          child = await host.start(parsed.value, stdin);
          if (closed) { child.kill(9); return; }
          send({ channel: "started" });
          const pumps = [pump(child.stdout, "stdout"), pump(child.stderr, "stderr")];
          const code = await child.exitCode;
          await Promise.all(pumps);
          send({ channel: "exit", code });
          child = undefined;
          if (killTimer !== undefined) clearTimeout(killTimer);
          stop();
        } catch {
          send({ channel: "error", message: "The computer could not start or retain the process." });
          stop();
        }
      })();
      return;
    }
    if (frame.channel === "stop") { stop(); return; }
    if (frame.channel === "stdin" && typeof frame.data === "string") {
      try {
        const text = atob(frame.data);
        if ((controller.desiredSize ?? 0) < text.length) { stop(); return; }
        controller.enqueue(Uint8Array.from(text, char => char.charCodeAt(0)));
      } catch { stop(); }
    } else if (frame.channel === "end") {
      try { controller.close(); } catch {}
    } else { stop(); }
  });
  socket.addEventListener("close", stop);
  socket.addEventListener("error", stop);
}
