import { describe, expect, it } from "vitest";
import { runProcessStream, type StreamingProcess, type StreamSocket } from "../src/process-stream";

class Socket implements StreamSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  #listeners = new Map<string, Array<(event: { data?: unknown }) => void>>();
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  addEventListener(type: string, listener: (event: { data?: unknown }) => void) { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]); }
  emit(type: string, event: { data?: unknown } = {}) { for (const listener of this.#listeners.get(type) ?? []) listener(event); }
  frame(value: unknown) { this.emit("message", { data: JSON.stringify(value) }); }
}

function fakeProcess() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (code: number) => void;
  const killed: number[] = [];
  let stdin: ReadableStream<Uint8Array> | undefined;
  const process: StreamingProcess = {
    stdout: new ReadableStream({ start(controller) { out = controller; } }),
    stderr: null,
    exitCode: new Promise((resolve) => { finish = resolve; }),
    kill(signal) { killed.push(signal); if (signal === 9) { try { out.close(); } catch {} finish(137); } },
  };
  return { process, killed, write: (text: string) => out.enqueue(new TextEncoder().encode(text)), exit: (code: number) => { out.close(); finish(code); }, stdin: () => stdin!, setStdin: (value: ReadableStream<Uint8Array>) => { stdin = value; } };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("process stream", () => {
  it("starts one process, carries stdin and stdout, and reports its exit", async () => {
    const socket = new Socket();
    const child = fakeProcess();
    let started = "";
    let finished = 0;
    runProcessStream(socket, { start: async (input, stdin) => { started = input.command; child.setStdin(stdin); return child.process; }, active: () => {}, finished: () => { finished += 1; } });
    socket.frame({ channel: "start", input: { command: "exec node relay.js" } });
    await tick();
    expect(started).toBe("exec node relay.js");
    expect(socket.sent).toContainEqual({ channel: "started" });
    socket.frame({ channel: "stdin", data: btoa("hello\n") });
    const reader = child.stdin().getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("hello\n");
    child.write("answer\n");
    await tick();
    expect(socket.sent).toContainEqual({ channel: "stdout", data: btoa("answer\n") });
    child.exit(0);
    await tick();
    expect(socket.sent.at(-1)).toEqual({ channel: "exit", code: 0 });
    expect(socket.closed).toBe(true);
    expect(finished).toBe(1);
  });

  it("stops the process when the connection ends, so it never keeps running unseen", async () => {
    const socket = new Socket();
    const child = fakeProcess();
    let finished = 0;
    runProcessStream(socket, { start: async () => child.process, active: () => {}, finished: () => { finished += 1; } });
    socket.frame({ channel: "start", input: { command: "sleep 100" } });
    await tick();
    socket.emit("close");
    expect(child.killed).toEqual([15]);
    expect(finished).toBe(1);
  });

  it("refuses input before the process is started", async () => {
    const socket = new Socket();
    let starts = 0;
    runProcessStream(socket, { start: async () => { starts += 1; return fakeProcess().process; }, active: () => {}, finished: () => {} });
    socket.frame({ channel: "stdin", data: btoa("x") });
    expect(socket.closed).toBe(true);
    expect(starts).toBe(0);
  });
});
