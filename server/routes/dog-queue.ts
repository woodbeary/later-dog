import type { RoomHandoff } from "../room-handoffs.ts";
import type { BotRecord } from "../store.ts";
import type { InternalRouteHandler } from "./internal.ts";
import { PASS } from "./table.ts";
import { matchDogs } from "./dog-accounts.ts";

export const DOG_QUEUE_PATH = "/api/internal/dog-queue";

export interface QueuedMessageRow {
  queueId: string;
  text: string;
  threadId: string;
}

export interface DogQueueRouteDeps {
  active(capability: unknown): boolean;
  ownerActing(capability: unknown, threadId: string): boolean;
  mainBotId(): string | null;
  dogs(): BotRecord[];
  queueOf(botId: string): RoomHandoff[];
  senderOf(node: RoomHandoff): string | undefined;
  node(id: string): RoomHandoff | undefined;
  personQueue(botId: string): QueuedMessageRow[];
  busyThreads(bot: BotRecord): string[];
  cancel(id: string, reason: string): RoomHandoff | string;
  replace(id: string, text: string): RoomHandoff | string;
  stop(input: { dog: BotRecord; threadId: string; by: BotRecord; force: boolean; why?: string }): Promise<"safe" | "stopped" | "idle">;
}

const snippet = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
};

export function queueText(dog: BotRecord, nodes: readonly RoomHandoff[], person: readonly QueuedMessageRow[], busy: readonly string[],
  nameOf: (botId: string | undefined) => string, senderOf: (node: RoomHandoff) => string | undefined): string {
  const running = nodes.filter((n) => n.status === "running");
  const waiting = nodes.filter((n) => n.status !== "running");
  const line = (n: RoomHandoff) => `- [requestId: ${n.id}] from ${nameOf(senderOf(n))}${n.urgent ? ", urgent" : ""}: ${snippet(n.text)}`;
  const parts = [
    `${dog.name} [id: ${dog.id}] is ${busy.length ? `working in ${busy.length} chat${busy.length === 1 ? "" : "s"}` : "idle"}.`,
    running.length ? `Running:\n${running.map(line).join("\n")}` : busy.length ? "Running: work from the owner or a routine, not a teammate request." : "Running: nothing.",
    waiting.length ? `Queued teammate requests, in the order they run:\n${waiting.map(line).join("\n")}` : "Queued teammate requests: none.",
    ...(person.length ? [`Queued messages from the owner: ${person.length} (${person.map((row) => `"${snippet(row.text)}"`).join(", ")}).`] : []),
  ];
  return parts.join("\n\n");
}

export type QueueAction = "view" | "stop" | "cancel" | "replace";

export function mayManage(input: { action: QueueAction; main: boolean; sender: string; requestSender: string | undefined }): string | null {
  if (input.action === "view" || input.main) return null;
  if (input.requestSender === input.sender) return null;
  return input.action === "stop"
    ? "Only the owner's main dog can stop work it didn't send. Name the request you sent with request_id."
    : "Only the owner's main dog can change a request another dog sent.";
}

export function createDogQueueRoute(deps: DogQueueRouteDeps): InternalRouteHandler {
  return async ({ res, path, method, json, readBody, capability, sender, threadId }) => {
    if (path !== DOG_QUEUE_PATH || method !== "POST") return PASS;
    if (!deps.active(capability)) return json(res, 401, { error: "the internal turn capability has expired" });
    if (!deps.ownerActing(capability, threadId)) {
      return json(res, 403, { error: "Only the owner's own dogs, working for the owner in the owner's home, can stop or change another dog's work." });
    }
    const body = await readBody();
    const action: QueueAction = ["stop", "cancel", "replace"].includes(body?.action) ? body.action : "view";
    const requestId = typeof body?.requestId === "string" ? body.requestId.trim() : "";
    const message = typeof body?.message === "string" ? body.message.trim().slice(0, 4000) : "";
    const named = typeof body?.dog === "string" ? body.dog.trim() : "";
    const dogs = deps.dogs();
    const nameOf = (botId: string | undefined) => (botId ? dogs.find((dog) => dog.id === botId)?.name ?? "a teammate" : "the owner");
    const node = requestId ? deps.node(requestId) : undefined;
    if (requestId && (!node || !node.parentId)) return json(res, 404, { error: `No teammate request with id ${requestId}.` });
    let dog: BotRecord | undefined;
    if (named) {
      const { found, problems } = matchDogs([named], dogs);
      if (!found[0]) return json(res, 404, { error: problems.join(" ") });
      dog = found[0];
    } else if (node) dog = dogs.find((each) => each.id === node.botId);
    if (!dog) return json(res, 400, { error: "Name the dog (dog) or the request (request_id)." });
    if (node && node.botId !== dog.id) return json(res, 409, { error: `Request ${requestId} is for ${nameOf(node.botId)}, not ${dog.name}.` });
    const main = deps.mainBotId() === sender.id;
    const view = () => queueText(dog!, deps.queueOf(dog!.id), deps.personQueue(dog!.id), deps.busyThreads(dog!), nameOf, deps.senderOf);

    if (action === "view") return json(res, 200, { text: view() });

    if (action === "cancel" || action === "replace") {
      if (!node) return json(res, 400, { error: `${action} needs request_id; dog_queue with just dog lists them.` });
      const refusal = mayManage({ action, main, sender: sender.id, requestSender: deps.senderOf(node) });
      if (refusal) return json(res, 403, { error: refusal });
      if (action === "cancel") {
        const done = deps.cancel(node.id, `${sender.name} cancelled this request for the owner before it started.`);
        if (typeof done === "string") return json(res, 409, { error: done });
        return json(res, 200, { text: `Cancelled request ${node.id} to ${dog.name}; ${nameOf(deps.senderOf(node))} is told. Its other queued work is untouched.\n\n${view()}` });
      }
      if (!message) return json(res, 400, { error: "replace needs message: the new request." });
      const done = deps.replace(node.id, message);
      if (typeof done === "string") return json(res, 409, { error: done });
      return json(res, 200, { requestId: done.id, text: `Replaced request ${node.id} with ${done.id}, in the same place in ${dog.name}'s queue. Its result comes back to ${nameOf(deps.senderOf(done))}.\n\n${view()}` });
    }

    const busy = deps.busyThreads(dog);
    const target = node ? node.threadId : busy[0];
    if (node && node.status !== "running") return json(res, 409, { error: `Request ${node.id} isn't running (it is ${node.status}); cancel it instead.` });
    const runningHere = node ?? deps.queueOf(dog.id).find((each) => each.status === "running" && each.threadId === target);
    const refusal = mayManage({ action, main, sender: sender.id, requestSender: runningHere ? deps.senderOf(runningHere) : undefined });
    if (refusal) return json(res, 403, { error: refusal });
    if (!target || (!node && !busy.length)) return json(res, 200, { text: `${dog.name} isn't working, so there is nothing to stop.\n\n${view()}` });
    if (target === threadId) return json(res, 409, { error: "That is this conversation; end your own turn instead." });
    const outcome = await deps.stop({ dog, threadId: target, by: sender, force: body?.force === true, ...(message ? { why: message } : {}) });
    const words = outcome === "idle" ? `${dog.name} had already finished.`
      : outcome === "safe" ? `Asked ${dog.name} to stop at a safe point: it finishes or rolls back the step it is in, then stops. If it is still going in two minutes, later.dog stops it.`
        : `Stopped ${dog.name}'s turn.`;
    return json(res, 200, { outcome, text: `${words} Its chat says you stopped it, and the dog that sent that work is told.\n\n${view()}` });
  };
}
