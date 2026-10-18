import { describe, expect, it } from "vitest";
import type { Message } from "@/state/store";
import { waitingOnPerson } from "./waiting-on-person";

const card = (extra: Partial<NonNullable<Message["card"]>> = {}): Message =>
  ({ id: "q", role: "bot", kind: "options", at: 1, card: { title: "Quill has a question", options: [], requestId: "r1", ...extra } }) as Message;

describe("waiting on the person", () => {
  it("is true while the open chat has a question or approval nobody answered", () => {
    expect(waitingOnPerson({ messages: [card()], activeLeafId: undefined })).toBe(true);
    expect(waitingOnPerson({ messages: [card({ answered: "Allow once" })], activeLeafId: undefined })).toBe(false);
    expect(waitingOnPerson({ messages: [card({ dismissed: true })], activeLeafId: undefined })).toBe(false);
    expect(waitingOnPerson({ messages: [{ id: "t", role: "bot", kind: "text", at: 1, text: "Hi" } as Message], activeLeafId: undefined })).toBe(false);
    expect(waitingOnPerson(undefined)).toBe(false);
  });
});
