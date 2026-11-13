import { describe, expect, it } from "vitest";
import type { WireMessage } from "../../shared/wire.ts";
import { buildNotification } from "../notify.ts";
import { onlyTapbackText, reactedText, TAPBACK_PROMPT, tapbackEmoji, tapbackTarget, tapbackStreamChunk, withTapback } from "./tapback.ts";
import { ON_IT_NOTE, STEER_NOTE, workUpdatesPrompt } from "./work-updates.ts";

const text = (id: string, role: "user" | "bot", body: string): WireMessage => ({ id, role, kind: "text", text: body, at: 1 });

describe("a dog's tapback", () => {
  it("takes one emoji and nothing else", () => {
    for (const emoji of ["👍", " ❤️ ", "😂", "🎉", "👍🏽", "🇺🇸", "❤️‍🔥", "👨‍👩‍👧"]) expect(tapbackEmoji(emoji), emoji).toBe(emoji.trim());
    for (const wrong of ["", "  ", "ok", "👍👍", "👍 ok", "1", "a👍", 7, null]) expect(tapbackEmoji(wrong), String(wrong)).toBeNull();
  });

  it("lands on the person's latest message unless a message is named", () => {
    const path = [text("ask", "user", "ship it?"), text("done", "bot", "Shipped."), text("ok", "user", "ok"), { ...text("tool", "bot", ""), kind: "activity" as const }];
    expect(tapbackTarget(path)?.id).toBe("ok");
    expect(tapbackTarget(path, "ask")?.id).toBe("ask");
    expect(tapbackTarget(path, "done")?.id).toBe("done");
    expect(tapbackTarget(path, "tool")).toBeNull();
    expect(tapbackTarget(path, "missing")).toBeNull();
    expect(tapbackTarget([text("hi", "bot", "Hello")])).toBeNull();
  });

  it("skips teammate notes when choosing the person's latest message", () => {
    const path = [text("ok", "user", "ok"), { ...text("peer", "user", "got it"), peerAsk: { botId: "patch", name: "Patch" } }];
    expect(tapbackTarget(path)?.id).toBe("ok");
    expect(tapbackTarget(path, "peer")?.id).toBe("peer");
    expect(tapbackTarget([path[1]!])).toBeNull();
  });

  it("replaces the dog's earlier tapback and leaves everyone else's", () => {
    const before = [{ emoji: "❤️", by: "user" }, { emoji: "👍", by: "clover" }, { emoji: "😂", by: "patch" }];
    expect(withTapback(before, "🎉", "clover")).toEqual([{ emoji: "❤️", by: "user" }, { emoji: "😂", by: "patch" }, { emoji: "🎉", by: "clover" }]);
    expect(withTapback(undefined, "👍", "clover")).toEqual([{ emoji: "👍", by: "clover" }]);
  });

  it("drops a reacting turn's text only when it is just emoji or punctuation", () => {
    for (const quiet of ["", "  ", "👍", "👍!", "❤️ 🎉", "👍🏽", "🇺🇸", "…"]) expect(onlyTapbackText(quiet), quiet).toBe(true);
    for (const said of ["Got it.", "👍 shipped", "Done: 3 files"]) expect(onlyTapbackText(said), said).toBe(false);
  });

  it("holds an emoji-only stream, then preserves every character when words follow", () => {
    let pending: string | undefined = "";
    let shown = "";
    for (const chunk of ["👍", " ", "Shipped", " ", "🎉"]) {
      const next = tapbackStreamChunk(pending, chunk);
      pending = next.pending;
      shown += next.delta ?? "";
    }
    expect(shown).toBe("👍 Shipped 🎉");
    expect(tapbackStreamChunk("", "👍")).toEqual({ pending: "👍" });
    expect(tapbackStreamChunk("👍", " ")).toEqual({ pending: "👍 " });
  });

  it("tells the dog the tapback is the reply and to end the turn", () => {
    expect(reactedText("👍", { text: "ok" })).toBe("Reacted 👍 to “ok”. End your turn now without writing anything; the reaction is the reply.");
    expect(reactedText("👍", { text: "x".repeat(80) })).toContain(`“${"x".repeat(57)}…”`);
  });

  it("sends no notification for a turn that only reacted", () => {
    expect(buildNotification("done", { id: "clover", name: "Clover" } as never, "thread", "")).toBeNull();
  });
});

describe("what dogs are told about tapbacks", () => {
  it("has a dog with the react tool react to an acknowledgment instead of replying, mid-task too", () => {
    expect(workUpdatesPrompt({ react: true })).toContain(TAPBACK_PROMPT);
    expect(TAPBACK_PROMPT).toMatch(/"ok", "thanks", "👍" or "got it", react to it with the react tool and end your turn without writing anything/);
    expect(TAPBACK_PROMPT).toMatch(/for a plain acknowledgment sent mid-task, the reaction is the short reply/);
    expect(TAPBACK_PROMPT.endsWith(" The tapback is the whole reply.")).toBe(true);
    expect(workUpdatesPrompt()).not.toContain("react tool");
  });

  it("makes the steer and on-it notes allow a tapback as the reply", () => {
    expect(STEER_NOTE).toMatch(/Reply to it now in a short line.*If it only acknowledges.*react to it with the react tool instead; that tapback is the reply\.\]$/);
    expect(ON_IT_NOTE).toMatch(/A react tapback needs no on-it line\./);
  });
});
