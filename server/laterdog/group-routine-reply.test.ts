import { describe, expect, it } from "vitest";

import { groupRoutineReply } from "./group-routine-reply.ts";

type GroupLine = Parameters<typeof groupRoutineReply>[0][number];

const dog = { botId: "dog", name: "Dog", color: "#000" };
const other = { botId: "other", name: "Other", color: "#000" };
const prompt: GroupLine = { id: "run", role: "user", kind: "text", text: "Post the morning summary." };
const line = (id: string, extra: Partial<GroupLine>): GroupLine => ({ id, role: "bot", kind: "text", from: dog, ...extra });
const card = (title: string, requestType?: "permission" | "question") => ({ title, subtitle: "", options: ["Yes", "No"], ...(requestType ? { requestType } : {}) });

describe("whether a group routine's dog replied", () => {
  it("takes the dog's last words after the routine prompt", () => {
    const before = line("old", { text: "Yesterday's summary." });
    expect(groupRoutineReply([before, prompt, line("a", { text: "First." }), line("b", { text: " Done. " })], "run", "dog")).toBe("Done.");
  });

  it("finds no reply when the dog said nothing after the prompt, or only another dog spoke", () => {
    const before = line("old", { text: "Yesterday's summary." });
    expect(groupRoutineReply([before, prompt], "run", "dog")).toBeNull();
    expect(groupRoutineReply([prompt, line("x", { from: other, text: "Hi." }), line("y", { kind: "activity", text: "Reading files" })], "run", "dog")).toBeNull();
    expect(groupRoutineReply([prompt, line("p", { kind: "options", card: card("Run git push?", "permission") })], "run", "dog")).toBeNull();
  });

  it("counts a question card, a file or a voice note as a reply", () => {
    expect(groupRoutineReply([prompt, line("q", { kind: "options", card: card("Which report?", "question") })], "run", "dog")).toBe("Which report?");
    const file = { kind: "file" as const, path: "/tmp/r.pdf", mime: "application/pdf", name: "r.pdf" };
    expect(groupRoutineReply([prompt, line("f", { text: "", attachments: [file] })], "run", "dog")).toBe("Replied in the group chat.");
    const voice = { kind: "audio" as const, path: "/tmp/v.m4a", mime: "audio/mp4" };
    expect(groupRoutineReply([prompt, line("t", { text: "Here it is." }), line("v", { attachments: [voice] })], "run", "dog")).toBe("Here it is.");
  });
});
