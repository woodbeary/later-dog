import { describe, expect, it } from "vitest";
import { initialState, reducer, type AppState, type Bot, type Message } from "./store";

const cloudPicture = "/data/.laterdog/attachments/2fd54938-8a55-48c2-a84f-485ac1fd3d89.png";
const macPicture = "/Users/jacob/.laterdog/attachments/7c9e6679-7425-40de-944b-e07fc1f90ae7.jpg";
const sent = `look at this\n\n<attached-image path="${cloudPicture}" name="shot.png" />\n\n<attached-image path="${macPicture}" name="mac.jpg" />`;

const question: Message = { id: "q1", role: "user", kind: "text", text: sent, at: 1 };
const answer: Message = { id: "a1", role: "bot", kind: "text", text: "Nice.", at: 2, parentId: question.id };
const bot = {
  id: "biscuit", threadId: "t1", name: "Biscuit", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [question, answer], activeLeafId: answer.id,
  modelSelection: { instanceId: "codex", model: "m" },
} as Bot;
const state: AppState = { ...initialState, bots: [bot] };

describe("cancelling a message that has not been sent yet", () => {
  it("drops a dog's waiting picture message once it is cancelled", () => {
    const queued = reducer(state, { type: "pendingQueued", threadId: bot.threadId, queueId: "q-pic", text: sent });
    expect(queued.pendingQueued[bot.threadId]).toHaveLength(1);
    const cancelled = reducer(queued, { type: "cancelQueued", botId: bot.id, threadId: bot.threadId, queueId: "q-pic" });
    expect(cancelled.pendingQueued[bot.threadId]).toBeUndefined();
  });

  it("drops a group chat's waiting picture message once it is cancelled", () => {
    const queued = reducer(state, { type: "pendingQueued", threadId: "room-thread", queueId: "rq-pic", text: sent });
    const cancelled = reducer(queued, { type: "cancelGroupQueued", groupId: "room", threadId: "room-thread", queueId: "rq-pic" });
    expect(cancelled.pendingQueued["room-thread"]).toBeUndefined();
  });
});
