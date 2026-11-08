import { describe, expect, it } from "vitest";
import { crossDogChats, interleave, isRecallMemoryFile, mayRecallAcrossDogs, safeRecallText } from "./cross-dog-recall.ts";

const dogs = [
  { id: "clover", name: "Clover", threadId: "t-clover", tasks: [{ threadId: "t-clover", title: "Main" }, { threadId: "t-clover-2", title: "Site audit" }] },
  { id: "patch", name: "Patch", threadId: "t-patch", tasks: [{ threadId: "t-patch-2", title: "Release" }] },
  { id: "pane", name: "Pane", threadId: "t-pane" },
];
const rooms = [
  { id: "r1", name: "Ship room", threadId: "t-room", memberIds: ["patch", "pane"], tasks: [{ threadId: "t-room-2", title: "v0.4" }] },
  { id: "r2", name: "Quiet", threadId: "t-quiet", memberIds: ["clover"] },
];

describe("cross-dog recall", () => {
  it("lets the main dog and owner work search other dogs, never a guest-driven chat", () => {
    expect(mayRecallAcrossDogs({ main: true, ownerWork: false, guestDriven: false })).toBe(true);
    expect(mayRecallAcrossDogs({ main: false, ownerWork: true, guestDriven: false })).toBe(true);
    expect(mayRecallAcrossDogs({ main: false, ownerWork: false, guestDriven: false })).toBe(false);
    expect(mayRecallAcrossDogs({ main: true, ownerWork: true, guestDriven: true })).toBe(false);
  });

  it("labels each chat by dog and chat, with group chats under their members", () => {
    const all = crossDogChats(dogs, rooms, new Set(["clover", "patch", "pane"]));
    expect(all.get("t-clover")).toEqual({ dogId: "clover", dog: "Clover", chat: "main chat" });
    expect(all.get("t-clover-2")).toEqual({ dogId: "clover", dog: "Clover", chat: 'task "Site audit"' });
    expect(all.get("t-room")).toEqual({ dog: "Patch, Pane", chat: 'group chat "Ship room"', room: "Ship room" });
    expect(all.get("t-room-2")?.chat).toBe('group chat "Ship room", task "v0.4"');
    const patchOnly = crossDogChats(dogs, rooms, new Set(["patch"]));
    expect([...patchOnly.keys()].sort()).toEqual(["t-patch", "t-patch-2", "t-room", "t-room-2"]);
    expect(patchOnly.get("t-room")?.dog).toBe("Patch");
  });

  it("shows secure forms and key requests by title only, and masks keys in text", () => {
    expect(safeRecallText({ kind: "secret", text: "hunter2", secureForm: { title: "Sign in to GitHub" } })).toBe("Secure form: Sign in to GitHub");
    expect(safeRecallText({ kind: "secret", secret: { label: "xAI API key" } })).toBe("Key request: xAI API key");
    expect(safeRecallText({ kind: "secret", text: "hunter2" })).toBe("Secure request");
    const masked = safeRecallText({ kind: "text", text: "use sk-ant-abcdefghijklmnopqrstuvwx now" });
    expect(masked).not.toContain("abcdefghijklmnop");
    expect(masked).toContain("now");
  });

  it("takes memory hits from every dog in turn up to the limit", () => {
    expect(interleave([[1, 2, 3], [10], [20, 21]], 5)).toEqual([1, 10, 20, 2, 21]);
    expect(interleave([[], []], 3)).toEqual([]);
  });

  it("reads only memory files inside a dog's memory", () => {
    for (const ok of ["MEMORY.md", "memory/archive.md", "memory/log/2026-11-08.md", "memory/site audit.md"]) expect(isRecallMemoryFile(ok), ok).toBe(true);
    for (const bad of ["../MEMORY.md", "memory/../../x.md", "memory/a/b.md", "SOUL.md", "memory/x.txt", "/etc/passwd"]) expect(isRecallMemoryFile(bad), bad).toBe(false);
  });
});
