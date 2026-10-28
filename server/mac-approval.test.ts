import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection } from "./contracts.ts";
import {
  MAC_ALLOW_KEY,
  MAC_CANCELLED,
  MAC_DENIED,
  MAC_EXPIRED,
  MAC_NEVER,
  MacApprovals,
  macDetail,
  macPathLabel,
  macTool,
  type MacCheck,
} from "./mac-approval.ts";
import { closeMessageDb } from "./message-db.ts";
import type { Notification } from "./notify.ts";
import { Store, type BotRecord } from "./store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });
const MAC = "Jo's MacBook Air";
const MAC_ID = "mac-air";
const OTHER_MAC_ID = "mac-studio";

describe("Mac approval gate", () => {
  let store: Store;
  let dog: BotRecord;
  let folder: string;
  let notes: Array<Notification | null>;
  let gate: MacApprovals;

  const make = (extra: { cardMs?: number; sweepMs?: number } = {}) =>
    new MacApprovals({ store, file: join(folder, "mac-access.json"), notify: (note) => notes.push(note), ...extra });

  const ask = (operation: MacCheck["operation"], over: Partial<MacCheck> = {}) =>
    gate.check({ bot: dog, threadId: dog.threadId, computer: MAC, computerId: MAC_ID, operation, active: () => true, ...over });

  const openCards = (threadId = dog.threadId) =>
    store.messagesFor(threadId).filter((message) => message.card?.requestId && !message.card.answered && !message.card.dismissed);

  const say = (text: string, threadId = dog.threadId) => store.appendMessage(threadId, { role: "user", kind: "text", text });

  beforeEach(() => {
    store = new Store(selection);
    dog = store.patchBot(store.createBot().id, { name: "Biscuit" })!;
    folder = mkdtempSync(join(tmpdir(), "laterdog-mac-access-"));
    notes = [];
    gate = make();
    say("find the newest PDF in my Downloads");
  });

  const asking = () => gate.update({ computers: { [MAC_ID]: "ask" } });

  it("lets every dog use the owner's Mac at once, with no card, by default", async () => {
    const other = store.patchBot(store.createBot().id, { name: "Scout" })!;
    store.appendMessage(other.threadId, { role: "user", kind: "text", text: "tidy my Desktop" });
    expect(gate.settings()).toEqual({ mode: "always", computers: {} });
    expect(gate.modeFor(MAC_ID)).toBe("always");
    await expect(Promise.all([
      ask({ action: "run_command", command: "ls ~/Downloads" }),
      ask({ action: "list_files", path: "Downloads" }),
      ask({ action: "read_file", path: "Downloads/a.pdf" }),
      ask({ action: "write_file", path: "Desktop/summary.md" }),
      ask({ action: "computer_call", tool_name: "launch_app", arguments: { name: "Mail" } }),
      gate.check({ bot: other, threadId: other.threadId, computer: MAC, computerId: MAC_ID, operation: { action: "run_command", command: "ls" }, active: () => true }),
    ])).resolves.toEqual(Array(6).fill({ ok: true }));
    expect(openCards()).toHaveLength(0);
    expect(openCards(other.threadId)).toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(gate.pending(dog.threadId)).toBe(false);
  });

  it("keeps each Mac's own choice: Never refuses without a card, Ask shows one, and other Macs keep the default", async () => {
    gate.update({ computers: { [MAC_ID]: "never" } });
    expect(await ask({ action: "run_command", command: "ls" })).toEqual({ ok: false, status: 403, error: MAC_NEVER });
    expect(openCards()).toHaveLength(0);
    expect(notes).toHaveLength(0);
    expect(await ask({ action: "run_command", command: "ls" }, { computerId: OTHER_MAC_ID })).toEqual({ ok: true });

    gate.update({ computers: { [MAC_ID]: "ask" } });
    const verdict = ask({ action: "run_command", command: "ls" });
    expect(openCards()).toHaveLength(1);
    gate.resolve(openCards()[0]!.card!.requestId!, "deny");
    expect(await verdict).toEqual({ ok: false, status: 403, error: MAC_DENIED });
    expect(gate.settings()).toEqual({ mode: "always", computers: { [MAC_ID]: "ask" } });
  });

  it("Never on a card refuses this request and every later one on that Mac", async () => {
    gate.update({ computers: { [MAC_ID]: "ask" } });
    const verdict = ask({ action: "list_files", path: "Downloads" });
    const requestId = openCards()[0]!.card!.requestId!;
    expect(gate.resolve(requestId, "deny", "never")).toBe(true);
    expect(await verdict).toEqual({ ok: false, status: 403, error: MAC_NEVER });
    expect(store.messagesFor(dog.threadId).find((message) => message.card?.requestId === requestId)?.card?.answered).toBe("deny");
    expect(gate.modeFor(MAC_ID)).toBe("never");
    say("try again");
    expect(await ask({ action: "list_files", path: "Desktop" })).toEqual({ ok: false, status: 403, error: MAC_NEVER });
    expect(openCards()).toHaveLength(0);
  });

  it("Always allow on a card lets every dog use that Mac without another card, until it is set to Never", async () => {
    gate.update({ computers: { [MAC_ID]: "ask" } });
    const waiting = ask({ action: "computer_call", tool_name: "launch_app", arguments: { name: "Mail" } });
    const requestId = openCards()[0]!.card!.requestId!;
    expect(openCards()[0]!.card?.subtitle).toBe("Mail");
    expect(gate.choose(requestId, "always")).toBe(true);
    expect(await waiting).toEqual({ ok: true });
    expect(gate.resolve(requestId, "allow")).toBe(true);
    expect(gate.resolve(requestId, "allow")).toBe(false);
    say("and again tomorrow");
    await expect(ask({ action: "run_command", command: "open -a Mail" })).resolves.toEqual({ ok: true });
    const other = store.patchBot(store.createBot().id, { name: "Scout" })!;
    store.appendMessage(other.threadId, { role: "user", kind: "text", text: "check my Desktop" });
    await expect(gate.check({ bot: other, threadId: other.threadId, computer: MAC, computerId: MAC_ID, operation: { action: "list_files", path: "Desktop" }, active: () => true })).resolves.toEqual({ ok: true });
    gate.update({ computers: { [MAC_ID]: "never" } });
    await expect(ask({ action: "read_file", path: "a" })).resolves.toMatchObject({ ok: false });
  });

  afterEach(() => {
    gate.close();
    vi.useRealTimers();
    closeMessageDb();
    rmSync(folder, { recursive: true, force: true });
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("asks once with a card naming the Mac and the folder, and lets the dog go on Allow", async () => {
    asking();
    const verdict = ask({ action: "list_files", path: "Downloads" });
    const [card] = openCards();
    expect(card?.card).toMatchObject({
      title: MAC,
      subtitle: "~/Downloads",
      options: ["Allow", "Deny", "Always allow"],
      tool: "mac_list_files",
      approvalScope: "local-computer",
      allowKey: MAC_ALLOW_KEY,
    });
    expect(notes).toHaveLength(1);
    expect(gate.pending(dog.threadId, dog.id)).toBe(true);

    expect(gate.resolve(card!.card!.requestId!, "allow")).toBe(true);
    expect(await verdict).toEqual({ ok: true });
    expect(store.messagesFor(dog.threadId).find((message) => message.id === card!.id)?.card?.answered).toBe("allow");
    expect(gate.pending(dog.threadId)).toBe(false);
  });

  it("keeps an Allow for the rest of the same request, per kind of action", async () => {
    asking();
    const first = ask({ action: "list_files", path: "~/Downloads" });
    gate.resolve(openCards()[0]!.card!.requestId!, "allow");
    await first;

    expect(await ask({ action: "read_file", path: "~/Downloads/invoice.pdf" })).toEqual({ ok: true });
    expect(openCards()).toHaveLength(0);

    const saving = ask({ action: "write_file", path: "~/Desktop/summary.md" });
    expect(openCards().map((message) => message.card?.tool)).toEqual(["mac_write_file"]);
    gate.resolve(openCards()[0]!.card!.requestId!, "deny");
    expect(await saving).toEqual({ ok: false, status: 403, error: MAC_DENIED });

    say("now look in Documents");
    const again = ask({ action: "list_files", path: "Documents" });
    expect(openCards()).toHaveLength(1);
    gate.resolve(openCards()[0]!.card!.requestId!, "allow");
    expect(await again).toEqual({ ok: true });
  });

  it("keeps an older card's Allow with its own request when another message arrives", async () => {
    asking();
    const firstRequest = store.activePath(dog.threadId).findLast((message) => message.role === "user")!.id;
    const first = ask({ action: "list_files", path: "Downloads" }, { requestMessageId: firstRequest });
    const firstCard = openCards()[0]!;
    const nextRequest = say("now look in Documents").id;

    gate.resolve(firstCard.card!.requestId!, "allow");
    expect(await first).toEqual({ ok: true });
    expect(await ask({ action: "read_file", path: "Downloads/invoice.pdf" }, { requestMessageId: firstRequest })).toEqual({ ok: true });

    const next = ask({ action: "list_files", path: "Documents" }, { requestMessageId: nextRequest });
    const nextCards = openCards();
    expect(nextCards).toHaveLength(1);
    gate.resolve(nextCards[0]!.card!.requestId!, "deny");
    expect(await next).toEqual({ ok: false, status: 403, error: MAC_DENIED });
  });

  it("does not combine pending cards belonging to different requests", async () => {
    asking();
    const firstRequest = store.activePath(dog.threadId).findLast((message) => message.role === "user")!.id;
    const first = ask({ action: "list_files", path: "Downloads" }, { requestMessageId: firstRequest });
    const nextRequest = say("look on my Desktop").id;
    const next = ask({ action: "list_files", path: "Desktop" }, { requestMessageId: nextRequest });
    const cards = openCards();
    expect(cards).toHaveLength(2);
    gate.resolve(cards[0]!.card!.requestId!, "allow");
    expect(await first).toEqual({ ok: true });
    expect(openCards()).toHaveLength(1);
    gate.resolve(cards[1]!.card!.requestId!, "deny");
    expect(await next).toEqual({ ok: false, status: 403, error: MAC_DENIED });
  });

  it("shares one card between dogs' parallel asks of the same kind", async () => {
    asking();
    const one = ask({ action: "list_files", path: "Downloads" });
    const two = ask({ action: "read_file", path: "Downloads/notes.txt" });
    expect(openCards()).toHaveLength(1);
    gate.resolve(openCards()[0]!.card!.requestId!, "allow");
    expect(await Promise.all([one, two])).toEqual([{ ok: true }, { ok: true }]);
  });

  it("tells the dog plainly when nobody answers in time", async () => {
    vi.useFakeTimers();
    gate.close();
    gate = make({ cardMs: 5_000 });
    asking();
    const verdict = ask({ action: "run_command", command: "ls ~/Downloads" });
    const card = openCards()[0]!;
    expect(card.card?.subtitle).toBe("ls ~/Downloads");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await verdict).toEqual({ ok: false, status: 408, error: MAC_EXPIRED });
    expect(store.messagesFor(dog.threadId).find((message) => message.id === card.id)?.card).toMatchObject({ answered: "unavailable", expired: true });
  });

  it("never asks when set to Always, and refuses without a card when set to Never", async () => {
    asking();
    gate.update({ mode: "always", computers: { [MAC_ID]: "always" } });
    expect(await ask({ action: "write_file", path: "notes.md" })).toEqual({ ok: true });
    gate.update({ mode: "never", computers: { [MAC_ID]: "never" } });
    expect(await ask({ action: "list_files", path: "Downloads" })).toEqual({ ok: false, status: 403, error: MAC_NEVER });
    expect(await ask({ action: "list_files", path: "Downloads" }, { computerId: OTHER_MAC_ID })).toEqual({ ok: false, status: 403, error: MAC_NEVER });
    expect(openCards()).toHaveLength(0);
    expect(notes).toHaveLength(0);
  });

  it("settles waiting cards when the setting changes", async () => {
    asking();
    const waiting = ask({ action: "list_files", path: "Downloads" });
    gate.update({ computers: { [MAC_ID]: "always" } });
    expect(await waiting).toEqual({ ok: true });
    asking();
    say("look on my Desktop too");
    const refused = ask({ action: "list_files", path: "Desktop" });
    expect(openCards()).toHaveLength(1);
    gate.update({ computers: { [OTHER_MAC_ID]: "never" } });
    expect(openCards()).toHaveLength(1);
    gate.update({ computers: { [MAC_ID]: "never" } });
    expect(await refused).toEqual({ ok: false, status: 403, error: MAC_NEVER });
    expect(openCards()).toHaveLength(0);
  });

  it("forgets a deleted dog and cancels what it was waiting on", async () => {
    asking();
    const waiting = ask({ action: "list_files", path: "Downloads" });
    gate.forgetDog(dog.id);
    expect(await waiting).toEqual({ ok: false, status: 409, error: MAC_CANCELLED });
    expect(openCards()).toHaveLength(0);
  });

  it("drops the ask when the dog's turn has already ended, and cancels cards whose turn ends while waiting", async () => {
    asking();
    expect(await ask({ action: "list_files", path: "Downloads" }, { active: () => false })).toMatchObject({ ok: false, status: 401 });
    expect(openCards()).toHaveLength(0);

    vi.useFakeTimers();
    gate.close();
    gate = make({ sweepMs: 1_000 });
    asking();
    let running = true;
    const waiting = ask({ action: "list_files", path: "Downloads" }, { active: () => running });
    expect(openCards()).toHaveLength(1);
    running = false;
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await waiting).toMatchObject({ ok: false, status: 401 });
    expect(openCards()).toHaveLength(0);
  });

  it("offers only Allow and Deny in a group chat", async () => {
    asking();
    const other = store.patchBot(store.createBot().id, { name: "Scout" })!;
    const room = store.createGroup("Planning", [dog.id, other.id]);
    store.appendMessage(room.threadId, { role: "user", kind: "text", text: "Biscuit, check Downloads" });
    const verdict = gate.check({ bot: dog, threadId: room.threadId, computer: MAC, computerId: MAC_ID, operation: { action: "list_files", path: "Downloads" }, active: () => true });
    const card = openCards(room.threadId)[0]!;
    expect(card.card?.options).toEqual(["Allow", "Deny"]);
    expect(card.card?.allowKey).toBeUndefined();
    expect(card.from?.name).toBe("Biscuit");
    gate.cancelThread(room.threadId);
    expect(await verdict).toEqual({ ok: false, status: 409, error: MAC_CANCELLED });
  });

  it("lets anything that isn't a Mac action through untouched", async () => {
    expect(macTool("screenshot")).toBeNull();
    expect(macTool("constructor")).toBeNull();
    expect(await ask({ action: "screenshot" })).toEqual({ ok: true });
    expect(openCards()).toHaveLength(0);
  });

  it("saves each Mac's choice and reads it back, and falls back to Always allow on a damaged file", () => {
    gate.update({ computers: { [MAC_ID]: "ask", [OTHER_MAC_ID]: "never" } });
    const saved = JSON.parse(readFileSync(join(folder, "mac-access.json"), "utf8"));
    expect(saved).toEqual({ version: 2, mode: "always", computers: { [MAC_ID]: "ask", [OTHER_MAC_ID]: "never" } });
    expect(make().settings()).toEqual({ mode: "always", computers: { [MAC_ID]: "ask", [OTHER_MAC_ID]: "never" } });

    writeFileSync(join(folder, "mac-access.json"), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(make().settings()).toEqual({ mode: "always", computers: {} });
    warn.mockRestore();
  });

  it("moves the first saved setting over once: Never stays Never, and Ask, which never asked the owner, becomes Always allow", () => {
    writeFileSync(join(folder, "mac-access.json"), JSON.stringify({ version: 1, mode: "never", dogs: [] }));
    expect(make().settings()).toEqual({ mode: "never", computers: {} });
    writeFileSync(join(folder, "mac-access.json"), JSON.stringify({ version: 1, mode: "ask", dogs: [dog.id] }));
    expect(make().settings()).toEqual({ mode: "always", computers: {} });
  });

  it("expires cards left open by a restart, and leaves its own open cards alone", () => {
    asking();
    void ask({ action: "list_files", path: "Downloads" });
    const leftover = openCards()[0]!;
    expect(gate.dismissStale([dog.threadId])).toBe(0);
    const restarted = make();
    expect(restarted.dismissStale([dog.threadId])).toBe(1);
    expect(restarted.dismissStale([dog.threadId])).toBe(0);
    expect(store.messagesFor(dog.threadId).find((message) => message.id === leftover.id)?.card).toMatchObject({ answered: "unavailable", expired: true });
    restarted.close();
  });
});

describe("Mac card wording", () => {
  it("shows paths from the home folder", () => {
    expect(macPathLabel("Downloads")).toBe("~/Downloads");
    expect(macPathLabel("~/Downloads/")).toBe("~/Downloads");
    expect(macPathLabel("./notes/today.md")).toBe("~/notes/today.md");
    expect(macPathLabel("~")).toBe("~");
    expect(macPathLabel(".")).toBe("~");
    expect(macPathLabel(undefined)).toBe("~");
    expect(macPathLabel("/Applications/")).toBe("/Applications");
  });

  it("shows the command or app, cut short when long", () => {
    expect(macDetail({ action: "run_command", command: "  ls -la  " })).toBe("ls -la");
    expect(macDetail({ action: "computer_call", tool_name: "launch_app", arguments: { bundle_id: "com.apple.mail" } })).toBe("com.apple.mail");
    expect(macDetail({ action: "computer_call", tool_name: "click" })).toBe("");
    const long = macDetail({ action: "run_command", command: "x".repeat(300) });
    expect(long).toHaveLength(201);
    expect(long.endsWith("…")).toBe(true);
  });

  it("shows what a search looks for", () => {
    expect(macDetail({ action: "search_files", path: "code/app", pattern: " TODO " })).toBe("~/code/app for TODO");
    expect(macDetail({ action: "search_files", path: "code/app" })).toBe("~/code/app");
    expect(macDetail({ action: "search_files", pattern: "x".repeat(300) })).toHaveLength(201);
  });
});
