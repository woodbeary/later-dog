import { describe, expect, it } from "vitest";
import type { WireMessage } from "../../shared/wire.ts";
import { buildNotification } from "../notify.ts";
import { onlyTapbackText, reactedText, replyTapback, replyTapbackStreamChunk, TAPBACK_NOTE, TAPBACK_PROMPT, tapbackEmoji, tapbackTarget, tapbackStreamChunk, withTapback } from "./tapback.ts";
import { ON_IT_NOTE, SHORT_ON_IT_NOTE, STEER_NOTE, withOnItNote, workUpdatesPrompt } from "./work-updates.ts";

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
    for (const empty of ["<tool_call>\n\n</tool_call>", "<tool_call></tool_call> 👍", "</tool_call>", "<|tool_call|>", "<tool_ca"]) expect(onlyTapbackText(empty), empty).toBe(true);
    for (const said of ["<b>Done</b>", "5 < 7 and 9 > 2", "<tool_call>ship it</tool_call>"]) expect(onlyTapbackText(said), said).toBe(false);
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
    let held: string | undefined = "";
    for (const chunk of ["<tool", "_call>", "\n\n", "</tool_call>"]) {
      const next = tapbackStreamChunk(held, chunk);
      expect(next.delta, chunk).toBeUndefined();
      held = next.pending;
    }
    expect(held).toBe("<tool_call>\n\n</tool_call>");
  });

  it("reads a reply that is only one reaction as a tapback", () => {
    expect(replyTapback("👍")).toBe("👍");
    expect(replyTapback("  ❤️\n")).toBe("❤️");
    expect(replyTapback("👍🏽")).toBe("👍🏽");
    expect(replyTapback("<agents_react>\n{\"emoji\": \"👍\"}\n</agents_react>")).toBe("👍");
    expect(replyTapback("<agents_react>{\"emoji\":\"👍\"}</agents_react>")).toBe("👍");
    expect(replyTapback("<react>👍</react>")).toBe("👍");
    expect(replyTapback("<react>\n  {\"emoji\": \"🎉\"}\n</react>")).toBe("🎉");
    expect(replyTapback("<tool_call>{\"name\":\"agents_react\",\"arguments\":{\"emoji\":\"👍\"}}</tool_call>")).toBe("👍");
    expect(replyTapback("<tool_call>{\"name\":\"mcp__agents__react\",\"arguments\":\"{\\\"emoji\\\":\\\"👍\\\"}\"}</tool_call>")).toBe("👍");
    expect(replyTapback("<|tool_call|>{\"name\": \"react\", \"parameters\": {\"emoji\": \"👍\"}}<|tool_call|>")).toBe("👍");
  });

  it("keeps a sentence, words in JSON, another tool and two emoji as a reply", () => {
    for (const said of [
      "Thanks, glad it worked 👍",
      "👍 shipped",
      "{\"emoji\": \"👍\", \"note\": \"thanks for the help\"}",
      "{\"text\": \"Glad to help 👍\"}",
      "<tool_call>{\"name\":\"send_text\",\"arguments\":{\"emoji\":\"👍\"}}</tool_call>",
      "<tool_call>{\"name\":\"agents_react\",\"arguments\":{\"emoji\":\"👍\",\"messageId\":\"m1\"}}</tool_call>",
      "👍👍",
      "👍 🎉",
      "<tool_call></tool_call>",
      "",
    ]) expect(replyTapback(said), said).toBeNull();
  });

  it("holds a stream only while it could still be one reaction and releases every character once it cannot", () => {
    const play = (chunks: string[]) => {
      let held: string | null | undefined;
      let shown = "";
      for (const chunk of chunks) {
        const next = replyTapbackStreamChunk(held, chunk);
        if (next.pending !== undefined) held = next.pending;
        else {
          held = null;
          shown += next.delta;
        }
      }
      return shown;
    };
    expect(play(["<agents_", "react>\n{\"em", "oji\": \"", "👍\"}\n</agents", "_react>"])).toBe("");
    expect(play(["<tool_call>{\"name\":\"agents_", "react\",\"arguments\":{\"emoji\":\"👍\"}}</tool_call>"])).toBe("");
    expect(play(["👍"])).toBe("");
    expect(play(["👍", " Shipped", " 🎉"])).toBe("👍 Shipped 🎉");
    expect(play(["Sure", ", done"])).toBe("Sure, done");
    expect(play(["<b>", "Done</b>"])).toBe("<b>Done</b>");
    expect(play(["{\"text\": \"Glad", " to help\"}"])).toBe("{\"text\": \"Glad to help\"}");
    expect(play(["5 < 7"])).toBe("5 < 7");
    expect(replyTapbackStreamChunk(null, "more")).toEqual({ delta: "more" });
  });

  it("tells the dog the tapback is added and to carry on, or end without text when there is nothing left", () => {
    expect(reactedText("👍", { text: "ok" })).toBe("Reacted 👍 to “ok”. Carry on with your work; if there is none, end your turn without writing anything.");
    expect(reactedText("👍", { text: "x".repeat(80) })).toContain(`“${"x".repeat(57)}…”`);
  });

  it("sends no notification for a turn that only reacted", () => {
    expect(buildNotification("done", { id: "clover", name: "Clover" } as never, "thread", "")).toBeNull();
  });
});

describe("what dogs are told about tapbacks", () => {
  it("has every engine answer an acknowledgment with one emoji and keep the react tool for mid-work", () => {
    expect(TAPBACK_PROMPT).toMatch(/"ok", "thanks", "👍" or "got it", reply with one emoji and nothing else; the app shows it as a tapback on their message\./);
    expect(TAPBACK_PROMPT).toMatch(/To react in the middle of work, use the react tool and carry on\.$/);
    for (const engine of ["claude", "codex", "other", undefined] as const) {
      expect(workUpdatesPrompt({ react: true, engine })).toContain(TAPBACK_PROMPT);
      expect(withOnItNote("thanks", engine)).toContain(TAPBACK_NOTE);
      expect(withOnItNote("thanks", engine)).not.toContain("react tool");
    }
    expect(SHORT_ON_IT_NOTE).toContain(TAPBACK_NOTE);
    expect(workUpdatesPrompt()).not.toContain("react tool");
  });

  it("makes the steer and on-it notes allow a one-emoji reply", () => {
    expect(STEER_NOTE).toMatch(/Reply to it now in a short line.*If it only acknowledges, such as "ok" or "thanks", reply with one emoji and nothing else; the app shows it as a tapback\.\]$/);
    expect(ON_IT_NOTE).toMatch(/A one-emoji reply needs no on-it line\./);
  });
});
