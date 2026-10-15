import { describe, expect, it } from "vitest";
import { initialState, reducer, visibleMessages, type AppState, type Bot, type Message } from "./store";
import { composeMessage, splitTranscriptAttachments } from "@/lib/composer-attachments";
import { editableMessage } from "@/lib/composer-message-edit";

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
const tagCount = (text: string) => text.match(/<attached-image/g)?.length ?? 0;

describe("edited messages with pictures in the store", () => {
  it("shows the edited message with both pictures at once, each once", () => {
    const editable = editableMessage(sent);
    const text = composeMessage("look at these instead", editable.attachments);
    const edited = reducer(state, { type: "editMessage", botId: bot.id, threadId: bot.threadId, messageId: question.id, text, sendId: "edit-1" });
    const shown = visibleMessages(edited.bots[0]!).at(-1)!;
    expect(shown.id).toBe("optimistic-edit-1");
    expect(tagCount(shown.text!)).toBe(2);
    const attached = splitTranscriptAttachments(shown.text!);
    expect(attached.display).toBe("look at these instead");
    expect(attached.images.map((image) => image.path)).toEqual([cloudPicture, macPicture]);
  });

  it("drops a bot's queued picture message once it is taken back for editing", () => {
    const queued = reducer(state, { type: "pendingQueued", threadId: bot.threadId, queueId: "q-pic", text: sent });
    expect(queued.pendingQueued[bot.threadId]).toHaveLength(1);
    const cancelled = reducer(queued, { type: "cancelQueued", botId: bot.id, threadId: bot.threadId, queueId: "q-pic" });
    expect(cancelled.pendingQueued[bot.threadId]).toBeUndefined();
  });

  it("drops a room's queued picture message once it is taken back for editing", () => {
    const queued = reducer(state, { type: "pendingQueued", threadId: "room-thread", queueId: "rq-pic", text: sent });
    const cancelled = reducer(queued, { type: "cancelGroupQueued", groupId: "room", threadId: "room-thread", queueId: "rq-pic" });
    expect(cancelled.pendingQueued["room-thread"]).toBeUndefined();
  });
});
