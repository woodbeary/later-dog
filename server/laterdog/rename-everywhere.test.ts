import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { getOrCreateChannel } from "../comms-visibility.ts";
import { closeMessageDb } from "../message-db.ts";
import { Store, toWireTask } from "../store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("renaming a dog", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  const pair = () => {
    const store = new Store(selection);
    const boss = store.createBot({ name: "New Bot" });
    const helper = store.createBot({ name: "Study Helper" });
    const channel = getOrCreateChannel(store, boss, helper);
    return { store, boss, helper, channel };
  };

  it("refreshes dependent thread titles on save, reload and Undo without rewriting custom titles", () => {
    const { store, boss, helper } = pair();
    const task = store.createTask(boss.id, "@Study Helper · work", false, undefined,
      { botId: helper.id, name: helper.name, kind: "work", at: 1 })!;
    const custom = store.createTask(boss.id, "Study Helper notes", false, undefined,
      { botId: helper.id, name: helper.name, kind: "work", at: 1 })!;
    const events: string[] = [];
    const unsubscribe = store.onChange((change) => { if (change.type === "bot") events.push(change.botId); });
    store.patchBotProfile(helper.id, { name: "Tutor" });
    expect(events).toContain(boss.id);
    expect(toWireTask(task, selection(), store.bots).title).toBe("@Tutor · work");
    const reloaded = new Store(selection);
    expect(toWireTask(reloaded.taskByThread(boss.id, task.threadId)!, selection(), reloaded.bots).title).toBe("@Tutor · work");
    expect(toWireTask(custom, selection(), store.bots).title).toBe("Study Helper notes");
    reloaded.patchBotProfile(helper.id, { name: "Study Helper" });
    expect(toWireTask(reloaded.taskByThread(boss.id, task.threadId)!, selection(), reloaded.bots).title).toBe("@Study Helper · work");
    unsubscribe();
  });

  it("remembers the earlier name when a profile is saved with a new one", () => {
    const { store, helper } = pair();
    store.patchBotProfile(helper.id, { name: "Tutor" });
    expect(store.bot(helper.id)).toMatchObject({ name: "Tutor", formerNames: ["Study Helper"] });
    store.patchBotProfile(helper.id, { name: "Coach" });
    expect(store.bot(helper.id)?.formerNames).toEqual(["Tutor", "Study Helper"]);
  });

  it("remembers the earlier name on a plain patch as well, and survives a restart", () => {
    const { store, helper } = pair();
    store.patchBot(helper.id, { name: "Tutor" });
    expect(new Store(selection).bot(helper.id)).toMatchObject({ name: "Tutor", formerNames: ["Study Helper"] });
  });

  it("changes nothing when a patch repeats the same name", () => {
    const { store, helper } = pair();
    store.patchBotProfile(helper.id, { name: "Study Helper", title: "Tutor" });
    expect(store.bot(helper.id)).not.toHaveProperty("formerNames");
  });

  it("keeps the history when only the capital letters of a name change", () => {
    const { store, helper } = pair();
    store.patchBotProfile(helper.id, { name: "Tutor" });
    store.patchBotProfile(helper.id, { name: "tutor" });
    expect(store.bot(helper.id)).toMatchObject({ name: "tutor", formerNames: ["Study Helper"] });
    store.patchBot(helper.id, { name: "TUTOR" });
    expect(store.bot(helper.id)).toMatchObject({ name: "TUTOR", formerNames: ["Study Helper"] });
    expect(new Store(selection).bot(helper.id)?.formerNames).toEqual(["Study Helper"]);
  });

  it("does not rename an exchange the person named themselves", () => {
    const { store, helper, channel } = pair();
    store.patchGroup(channel.id, { name: "Sky notes" });
    store.patchBotProfile(helper.id, { name: "Tutor" });
    expect(store.group(channel.id)?.name).toBe("Sky notes");
    store.patchBot(helper.id, { name: "Coach" });
    expect(store.group(channel.id)?.name).toBe("Sky notes");
  });

  it("renames the exchange between two dogs in both orders", () => {
    const { store, boss, helper, channel } = pair();
    expect(store.group(channel.id)?.name).toBe("New Bot ⇄ Study Helper");
    store.patchBotProfile(helper.id, { name: "Tutor" });
    expect(store.group(channel.id)?.name).toBe("New Bot ⇄ Tutor");
    store.patchBot(boss.id, { name: "Chief" });
    expect(store.group(channel.id)?.name).toBe("Chief ⇄ Tutor");
    expect(new Store(selection).group(channel.id)?.name).toBe("Chief ⇄ Tutor");
  });

  it("leaves rooms the person named alone", () => {
    const { store, helper, boss } = pair();
    const room = store.createGroup("Launch", [boss.id, helper.id], false);
    store.patchBotProfile(helper.id, { name: "Tutor" });
    expect(store.group(room.id)?.name).toBe("Launch");
  });
});
