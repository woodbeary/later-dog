import { createInterface } from "node:readline";
import type { ProviderInstance } from "../contracts.ts";
import { guestCliDriver } from "./guest-cli-profile.ts";
import { guestHttpDriver } from "./guest-http-profile.ts";
import type { GuestRequest } from "./guest-provider-types.ts";

const write = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n");
console.log = console.info = console.debug = (...parts: unknown[]) => console.error(...parts);

let provider: ProviderInstance | undefined;
let thread = "";
let opening = false;
let stopping: Promise<void> | undefined;
const generation = new AbortController();
const shutdown = () => stopping ??= Promise.resolve().then(async () => {
  generation.abort();
  await provider?.dispose();
});

async function handle(id: number, req: GuestRequest) {
  if (req.op === "open") {
    if (opening || stopping) throw new Error("Engine is already opening.");
    opening = true;
    const driver = guestCliDriver(req.driver) ?? guestHttpDriver(req.driver, req.input);
    if (!driver || !req.input.enabled) throw new Error("This engine is unavailable on the computer.");
    thread = req.threadId;
    provider = await driver.create(req.input);
    provider.adapter.onEvent(event => {
      if (event.threadId === thread) write({ event });
    });
    return true;
  }
  if (!provider) throw new Error("Engine is unavailable.");
  const adapter = provider.adapter;
  switch (req.op) {
    case "send":
      if (req.turn.threadId !== thread) throw new Error("This turn belongs to another chat.");
      if (req.turn.guestConfined && adapter.capabilities.guestTurns !== "confined") throw new Error("This engine cannot run a confined turn.");
      return adapter.sendTurn(req.turn);
    case "interrupt": return adapter.interruptTurn(thread, req.turnId);
    case "answer": return adapter.respondToRequest(thread, req.requestId, req.decision);
    case "steer": return adapter.steer?.(thread, req.text, req.images, () => write({ read: id })) ?? "refused";
    case "generate": {
      if (!provider.generateText) throw new Error("This engine cannot generate text.");
      let usage;
      const text = await provider.generateText(req.prompt, { model: req.model, signal: generation.signal, onUsage: value => { usage = value; } });
      return { text, usage };
    }
    case "context": return adapter.contextUsage?.(thread) ?? { kind: "none" };
    case "stopActor": return adapter.stopNativeActor?.(thread, req.actor);
    case "dispose": return shutdown();
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message: { id: number; request: GuestRequest };
  try { message = JSON.parse(line); } catch { return; }
  const { id, request } = message;
  void handle(id, request).then(value => write({ id, value }), error => write({ id, error: error instanceof Error ? error.message : "Engine operation failed." }));
});
lines.once("close", () => { void shutdown().finally(() => process.exit()); });
