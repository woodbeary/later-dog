import { describe, expect, it } from "vitest";
import { deskReplyLine, deskUserLine } from "../../deploy/laterdog/home/src/desk-stream.ts";
import { withShownLines } from "./saved-copy";
import type { Message } from "./store";

const line = (id: string, at: number, parentId: string | null, extra: Partial<Message> = {}): Message =>
  ({ id, role: "bot", kind: "text", text: id, at, parentId, ...extra });
const chain = (...ids: string[]): Message[] => ids.map((id, index) => line(id, index + 1, ids[index - 1] ?? null));
const chat = (messages: Message[], extra: { activeLeafId?: string | null; hasMore?: boolean; threadId?: string } = {}) =>
  ({ threadId: "thread", messages, activeLeafId: messages.at(-1)?.id ?? null, ...extra });
const ids = (kept: { messages: Message[] }) => kept.messages.map((message) => message.id);

describe("what the device shows against the edge's saved copy of the same chat", () => {
  it("keeps the lines the copy lacks after the line they followed, and stays on the newest one", () => {
    const kept = withShownLines(chat(chain("a", "b", "c", "d")), chat(chain("a", "b")), true);
    expect(ids(kept)).toEqual(["a", "b", "c", "d"]);
    expect(kept.activeLeafId).toBe("d");
  });

  it("takes the copy as it is for another conversation, and for a chat the device does not show", () => {
    const saved = chat(chain("a", "b"));
    expect(withShownLines(chat(chain("x", "y"), { threadId: "earlier-thread" }), saved, true)).toBe(saved);
    expect(withShownLines(undefined, saved, true)).toBe(saved);
  });

  it("takes the copy as it is when a restored screen shows nothing newer", () => {
    const saved = chat(chain("a", "b", "c"));
    expect(withShownLines(chat(chain("a", "b")), saved, false)).toBe(saved);
    expect(withShownLines(chat([]), saved, false)).toBe(saved);
  });

  it("puts earlier lines only the copy has before a restored screen's lines, and uses the copy's fuller version of a shared line", () => {
    const [a, b, c, d] = chain("a", "b", "c", "d") as [Message, Message, Message, Message];
    const saved = chat([a, b, { ...c, png: "picture" }], { hasMore: false });
    const kept = withShownLines(chat([c, d], { hasMore: true }), saved, false);
    expect(ids(kept)).toEqual(["a", "b", "c", "d"]);
    expect(kept.messages[2]!.png).toBe("picture");
    expect(kept.activeLeafId).toBe("d");
    expect(kept.hasMore).toBe(false);
  });

  it("keeps the newer version of a line the device has seen change since the copy was saved", () => {
    const [a, b] = chain("a", "b") as [Message, Message];
    const kept = withShownLines(chat([a, { ...b, text: "answered" }]), chat([a, b]), true);
    expect(kept.messages[1]!.text).toBe("answered");
  });

  it("keeps earlier pages the person loaded, with their own word on whether more exist", () => {
    const kept = withShownLines(chat(chain("older", "a", "b", "c"), { hasMore: false }), chat(chain("a", "b").map((message) => (message.id === "a" ? { ...message, parentId: "older" } : message)), { hasMore: true }), true);
    expect(ids(kept)).toEqual(["older", "a", "b", "c"]);
    expect(kept.hasMore).toBe(false);
  });

  it("puts the copy first when nothing is shared and the shown lines are newer", () => {
    const shown = chat([line("y", 20, "x"), line("z", 21, "y")]);
    const kept = withShownLines(shown, chat(chain("a", "b")), false);
    expect(ids(kept)).toEqual(["a", "b", "y", "z"]);
    expect(kept.activeLeafId).toBe("z");
  });

  it("leaves a line that is still being sent to the outbox, and stays on the line before it", () => {
    const sending = line("optimistic-send-1", 9, "c", { role: "user", sendId: "send-1" });
    const kept = withShownLines(chat([...chain("a", "b", "c"), sending]), chat(chain("a", "b")), true);
    expect(ids(kept)).toEqual(["a", "b", "c"]);
    expect(kept.activeLeafId).toBe("c");
  });

  it("continues from the newest shown line with a message the edge answered knowing only the older copy", () => {
    const user = deskUserLine({ sendId: "send-2", text: "And the pricing line?", at: 30, parentId: "b" }) as Message;
    const reply = deskReplyLine({ sendId: "send-2", text: "Still to confirm.", at: 31 }) as Message;
    const kept = withShownLines(chat(chain("a", "b", "c", "d")), chat([...chain("a", "b"), user, reply]), true);
    expect(ids(kept)).toEqual(["a", "b", "c", "d", user.id, reply.id]);
    expect(kept.messages[4]!.parentId).toBe("d");
    expect(kept.messages[5]!.parentId).toBe(user.id);
    expect(kept.activeLeafId).toBe(reply.id);
  });

  it("stays on the branch the person switched to after the copy was saved", () => {
    const messages = [...chain("a", "b"), line("b-again", 5, "a")];
    const kept = withShownLines(chat(messages, { activeLeafId: "b" }), chat(messages), true);
    expect(kept.activeLeafId).toBe("b");
  });

  it("keeps a group chat's newer lines without giving it a branch", () => {
    const room = (messages: Message[]) => ({ threadId: "room-thread", messages });
    const kept = withShownLines(room(chain("a", "b", "c")), room(chain("a")), true);
    expect(ids(kept)).toEqual(["a", "b", "c"]);
    expect("activeLeafId" in kept).toBe(false);
  });
});
