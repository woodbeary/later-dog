import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import { MacApprovals } from "./mac-approval.ts";
import { closeMessageDb, deleteThread, importThread } from "./message-db.ts";
import { cancelPeerApprovalsFor, dismissStalePeerCards, requestPeerApproval, resolvePeerComms, type ApprovalBus } from "./peer-approval.ts";
import { Store, type BotRecord, type Message } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
const DOGS = 24;
const MESSAGES_PER_CHAT = 300;
const LINE = "The dog wrote a long reply about the work it did today. ".repeat(18);

function history(threadId: string): Message[] {
  const start = Date.now() - MESSAGES_PER_CHAT * 1000;
  return Array.from({ length: MESSAGES_PER_CHAT }, (_, index) => ({
    id: `${threadId}-m${index}`,
    at: start + index * 1000,
    role: index % 2 ? "bot" : "user",
    kind: index % 50 === 7 ? "options" : "text",
    text: LINE,
    ...(index % 50 === 7 ? { card: { title: "Earlier", options: ["Allow", "Deny"], requestId: `${threadId}-old-${index}`, tool: "ask_bot", answered: "allow" } } : {}),
  }) as Message);
}

function allThreads(store: Store): Set<string> {
  const ids = new Set<string>();
  for (const bot of store.bots) for (const threadId of [bot.threadId, ...(bot.tasks ?? []).map((task) => task.threadId)]) ids.add(threadId);
  return ids;
}

const openCards = (store: Store, threadId: string) =>
  store.messagesFor(threadId).filter((message) => message.card?.requestId && !message.card.answered && !message.card.dismissed);

describe("cards left open by a previous run", () => {
  let dogs: BotRecord[];
  let folder: string;

  beforeEach(() => {
    const before = new Store(selection);
    dogs = Array.from({ length: DOGS }, (_, index) => before.patchBot(before.createBot().id, { name: `Dog ${index}`, approvePeerComms: true })!);
    for (const dog of dogs) {
      deleteThread(dog.threadId);
      importThread(dog.threadId, history(dog.threadId), null);
    }
    before.appendMessage(dogs[3]!.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "@Dog 3 wants to contact @Dog 4", subtitle: "ping", options: ["Allow", "Deny"], requestId: "peer-from-a-dead-process", tool: "ask_bot" },
    });
    before.appendMessage(dogs[9]!.threadId, {
      role: "bot",
      kind: "options",
      card: { title: "Mac", subtitle: "Downloads", options: ["Allow", "Deny"], requestId: "mac-from-a-dead-process", tool: "mac_list_files" },
    });
    folder = mkdtempSync(join(tmpdir(), "laterdog-stale-cards-"));
  });

  afterEach(() => {
    for (const dog of dogs) cancelPeerApprovalsFor(dog.id);
    vi.restoreAllMocks();
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it("closes them at boot without reading any chat's history, so the server is not held", () => {
    const store = new Store(selection);
    const bus: ApprovalBus = { store, broadcast: () => {} };
    const mac = new MacApprovals({ store, notify: () => {}, file: join(folder, "mac-access.json") });
    const reads = vi.spyOn(store, "messagesFor");

    const started = performance.now();
    const peer = dismissStalePeerCards(bus);
    const macStale = mac.dismissStale(allThreads(store));
    const held = performance.now() - started;

    expect({ peer, macStale }).toEqual({ peer: 1, macStale: 1 });
    expect(reads).not.toHaveBeenCalled();
    expect(held).toBeLessThan(100);
    reads.mockRestore();
    expect(openCards(store, dogs[3]!.threadId)).toEqual([]);
    expect(openCards(store, dogs[9]!.threadId)).toEqual([]);
    expect(store.messagesFor(dogs[3]!.threadId).at(-1)?.card).toMatchObject({ answered: "deny", dismissed: true });
    expect(store.messagesFor(dogs[9]!.threadId).at(-1)?.card).toMatchObject({ answered: "unavailable", expired: true });
    expect(store.messagesFor(dogs[5]!.threadId).filter((message) => message.card?.answered === "allow")).toHaveLength(MESSAGES_PER_CHAT / 50);
    mac.close();
  });

  it("leaves a card asked after boot open, and answering it still works", async () => {
    const store = new Store(selection);
    const bus: ApprovalBus = { store, broadcast: () => {} };
    dismissStalePeerCards(bus);
    const [from, target] = [store.bot(dogs[0]!.id)!, store.bot(dogs[1]!.id)!];

    const verdict = requestPeerApproval(bus, from, target, "ping", "delegate_bot");
    const card = openCards(store, from.threadId)[0]!;
    expect(card.card?.tool).toBe("delegate_bot");
    expect(dismissStalePeerCards(bus)).toBe(0);
    expect(openCards(store, from.threadId).map((message) => message.id)).toEqual([card.id]);

    expect(resolvePeerComms(bus, card.card!.requestId!, "allow")).toBe(true);
    expect(await verdict).toBe("allow");
    expect(store.messagesFor(from.threadId).find((message) => message.id === card.id)?.card?.answered).toBe("allow");
  });
});
