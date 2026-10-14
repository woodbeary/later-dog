import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import type { ModelSelection } from "../contracts.ts";
import { getOrCreateChannel } from "../comms-visibility.ts";
import { closeMessageDb } from "../message-db.ts";
import { ProfileRequestService, type ProfileRequestStore } from "../profile-requests.ts";
import { Store } from "../store.ts";

const selection = (): ModelSelection => ({ instanceId: "claude", model: "fake-model" });

describe("a dog can rename a dog through the profile path", () => {
  beforeEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });
  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("applies its own new name at once and keeps the old one for mentions and lines", () => {
    const store = new Store(selection);
    const boss = store.createBot({ name: "New Bot" });
    const helper = store.createBot({ name: "Study Helper" });
    const channel = getOrCreateChannel(store, boss, helper);
    const service = new ProfileRequestService({ store: store as unknown as ProfileRequestStore, autoApply: () => "self" });
    const proposed = service.submit({ botId: helper.id, threadId: helper.threadId, changes: { name: "Tutor" }, reason: "Easier to say" });
    expect(proposed.state).toBe("applied");
    expect(store.bot(helper.id)).toMatchObject({ name: "Tutor", formerNames: ["Study Helper"] });
    expect(store.group(channel.id)?.name).toBe("New Bot ⇄ Tutor");
  });

  it("asks the person before it renames another dog, and renames it only after they confirm", () => {
    const store = new Store(selection);
    const boss = store.createBot({ name: "New Bot" });
    const helper = store.createBot({ name: "Study Helper" });
    const service = new ProfileRequestService({ store: store as unknown as ProfileRequestStore, autoApply: () => null });
    const proposed = service.submit({ botId: boss.id, threadId: boss.threadId, targetBotId: helper.id, changes: { name: "Tutor" }, reason: "Clearer" });
    expect(proposed.state).toBe("pending");
    expect(store.bot(helper.id)?.name).toBe("Study Helper");
    expect(service.resolve({ botId: boss.id, threadId: boss.threadId, requestId: proposed.requestId, behavior: "allow" }).state).toBe("applied");
    expect(store.bot(helper.id)).toMatchObject({ name: "Tutor", formerNames: ["Study Helper"] });
  });

  it("leaves the name alone when the person refuses", () => {
    const store = new Store(selection);
    const boss = store.createBot({ name: "New Bot" });
    const helper = store.createBot({ name: "Study Helper" });
    const service = new ProfileRequestService({ store: store as unknown as ProfileRequestStore, autoApply: () => null });
    const proposed = service.submit({ botId: boss.id, threadId: boss.threadId, targetBotId: helper.id, changes: { name: "Tutor" }, reason: "Clearer" });
    service.resolve({ botId: boss.id, threadId: boss.threadId, requestId: proposed.requestId, behavior: "deny" });
    expect(store.bot(helper.id)).toMatchObject({ name: "Study Helper" });
    expect(store.bot(helper.id)).not.toHaveProperty("formerNames");
  });
});
