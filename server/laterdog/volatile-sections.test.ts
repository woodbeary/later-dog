import { describe, expect, it, vi } from "vitest";

import { buildSystemPrompt, todayPrompt } from "../system-prompt.ts";
import { recentWorkPrompt } from "../recent-work.ts";
import { memorySystemPrompt, writeMemoryFile, writeMemoryTopic } from "../workspace.ts";
import { syncCodexInstructions } from "../drivers/codex-instructions.ts";
import {
  ALL_SECTIONS_CLEARED,
  CHANGED_SECTIONS_HEADING,
  FULL_SECTIONS_HEADING,
  claudeContextNote,
  claudeSeenVolatile,
  claudeVolatileNote,
  matchingSections,
  volatileSectionsOf,
  type VolatileSection,
} from "./volatile-sections.ts";

const BOT = "bot-volatile-sections";
writeMemoryFile(BOT, "# Memory\n\n- Prefers pnpm.\n- Keeps repos under ~/code.\n");
writeMemoryTopic(BOT, "deploys.md", "---\ntitle: deploys\ndescription: notes about deploys\n---\nbody");

const recentLine = (said: string, at: number) => ({ threadId: "t1", at, where: "your chat", title: "Deploy", said, private: false });

function prompt(input: { day?: string; said?: string; memoryReadOnly?: boolean; mention?: boolean }) {
  const now = new Date(input.day ?? "2026-11-12T10:00:00Z");
  return buildSystemPrompt("You are Scout.", "Be brief.", [
    { id: "routine", label: "Routines", text: " Use list_routines." },
    { id: "today", label: "Today", text: todayPrompt("America/Los_Angeles", now) },
    { id: "recent", label: "Recent work", text: recentWorkPrompt([recentLine(input.said ?? "Finished the deploy check.", now.getTime() - 60_000)], now.getTime()) },
    { id: "memory", label: "Memory", text: memorySystemPrompt(BOT, { managedWrites: true, fileTools: true, readOnly: input.memoryReadOnly }) },
    { id: "mentions", label: "Mentions", text: input.mention ? " The user tagged @Fig (bot_id b2) in their message." : "" },
  ], "Jacob");
}

const turnOf = (built: ReturnType<typeof prompt>, mentionTurn = false) => ({
  systemVolatile: built.volatile,
  systemVolatileSections: built.volatileSections,
  mentionTurn,
});

const reminderBody = (note: string) => note.replace(/^<system-reminder>\n/, "").replace(/\n<\/system-reminder>$/, "");

describe("volatile sections", () => {
  it("cuts the volatile half into named sections whose text joins back to it exactly", () => {
    const built = prompt({});
    expect(built.volatileSections.map((section) => section.text).join("")).toBe(built.volatile);
    expect(built.volatileSections.map((section) => section.id)).toEqual([
      "today", "recent:standing", "recent", "memory:standing", "memory",
    ]);
    expect(built.volatileSections.find((section) => section.id === "memory:standing")?.text).not.toContain("Prefers pnpm");
    expect(built.volatileSections.find((section) => section.id === "memory")?.text).toContain("Prefers pnpm");
    expect(built.volatileSections.find((section) => section.id === "memory")?.text).toContain("deploys");
    expect(built.volatileSections.find((section) => section.id === "recent")?.text).toContain("Finished the deploy check.");
  });

  it("keeps the stable half byte-identical across turns, new work, memory mode and days", () => {
    const first = prompt({});
    for (const later of [
      prompt({}),
      prompt({ said: "Posted the summary." }),
      prompt({ day: "2026-11-13T10:00:00Z" }),
      prompt({ day: "2026-12-01T23:00:00Z", said: "Other." }),
      prompt({ memoryReadOnly: true }),
      prompt({ mention: true }),
    ]) {
      expect(later.stable).toBe(first.stable);
    }
  });

  it("sends nothing when no section changed", () => {
    const turn = turnOf(prompt({}));
    const first = claudeContextNote(turn, null);
    expect(first.note).not.toBe("");
    expect(claudeContextNote(turnOf(prompt({})), first.seen).note).toBe("");
  });

  it("sends only the section that changed, labelled as replacing its earlier copy", () => {
    const first = claudeContextNote(turnOf(prompt({})), null);
    const next = claudeContextNote(turnOf(prompt({ said: "Posted the summary." })), first.seen);
    const body = reminderBody(next.note);
    expect(body.startsWith(CHANGED_SECTIONS_HEADING)).toBe(true);
    expect(body).toContain("[Recent work]\n");
    expect(body).toContain("Posted the summary.");
    expect(body).not.toContain("Recent work, standing part");
    expect(body).not.toContain("Prefers pnpm");
    expect(body).not.toContain("Today");
  });

  it("sends every section again to a fresh or rebuilt session", () => {
    const built = prompt({});
    const fresh = reminderBody(claudeContextNote(turnOf(built), null).note);
    expect(fresh.startsWith(FULL_SECTIONS_HEADING)).toBe(true);
    for (const section of built.volatileSections) expect(fresh).toContain(`[${section.label}]\n${section.text.trim()}`);
  });

  it("sends every section again on a tagged turn, as before", () => {
    const first = claudeContextNote(turnOf(prompt({ mention: true })), null);
    const again = reminderBody(claudeContextNote(turnOf(prompt({ mention: true }), true), first.seen).note);
    expect(again.startsWith(FULL_SECTIONS_HEADING)).toBe(true);
    expect(again).toContain("@Fig");
    expect(again).toContain("Prefers pnpm");
  });

  it("says when a section has gone", () => {
    const first = claudeContextNote(turnOf(prompt({ mention: true })), null);
    const body = reminderBody(claudeContextNote(turnOf(prompt({})), first.seen).note);
    expect(body).toBe(`${CHANGED_SECTIONS_HEADING}\n\n[Mentions]\nNothing here any more.`);
  });

  it("resends memory guidance when the memory mode changes for a turn someone else started", () => {
    const first = claudeContextNote(turnOf(prompt({})), null);
    const foreign = reminderBody(claudeContextNote(turnOf(prompt({ memoryReadOnly: true })), first.seen).note);
    expect(foreign).toContain("[Memory, standing part]");
    expect(foreign).toContain("can't change your memory");
    expect(foreign).not.toContain("Prefers pnpm");
  });

  it("keeps the whole-block note when sections are missing or do not match the volatile half", () => {
    const built = prompt({});
    const legacy = claudeVolatileNote(built.volatile, null);
    expect(claudeContextNote({ systemVolatile: built.volatile }, null).note).toBe(legacy);
    const tampered = { systemVolatile: built.volatile + " extra", systemVolatileSections: built.volatileSections };
    expect(claudeContextNote(tampered, null).note).toBe(claudeVolatileNote(tampered.systemVolatile, null));
    const duplicate: VolatileSection[] = [{ id: "a", label: "A", text: "x" }, { id: "a", label: "A", text: "y" }];
    expect(matchingSections("xy", duplicate)).toBeNull();
    expect(claudeSeenVolatile({ systemVolatile: built.volatile })).toBe(built.volatile);
  });

  it("tells a session that had notes when every section is gone", () => {
    const first = claudeContextNote(turnOf(prompt({})), null);
    expect(reminderBody(claudeContextNote({ systemVolatile: "", systemVolatileSections: [] }, first.seen).note)).toContain("[Memory]\nNothing here any more.");
    expect(reminderBody(claudeContextNote({ systemVolatile: "", systemVolatileSections: [] }, "old whole note").note)).toBe(ALL_SECTIONS_CLEARED);
    expect(claudeContextNote({ systemVolatile: "", systemVolatileSections: [] }, null).note).toBe("");
  });

  it("leaves a section whole when it has no standing part", () => {
    expect(volatileSectionsOf([{ id: "today", label: "Today", text: " Today is Thursday." }])).toEqual([
      { id: "today", label: "Today", text: " Today is Thursday." },
    ]);
  });
});

describe("Codex volatile sections", () => {
  it("delivers all sections to a new thread, only changes on resume, and remembers them across restarts", async () => {
    const key = `codex-sections-${Date.now()}`;
    const request = vi.fn(async () => ({}));
    const send = async (built: ReturnType<typeof prompt>, resumed: boolean, mention = false) => {
      const result = await syncCodexInstructions(key, "native", "rules", built.volatile, resumed, request, mention, built.volatileSections);
      result.commitVolatile?.();
      return result;
    };
    const first = await send(prompt({}), false);
    expect(first.note.startsWith(FULL_SECTIONS_HEADING)).toBe(true);
    expect(first.deliverVolatile).toBe(true);
    const same = await send(prompt({}), true);
    expect(same).toMatchObject({ note: "", deliverVolatile: false, commitVolatile: null });
    const tick = await send(prompt({ said: "Twelve files moved." }), true);
    expect(tick.note.startsWith(CHANGED_SECTIONS_HEADING)).toBe(true);
    expect(tick.note).toContain("Twelve files moved.");
    expect(tick.note).not.toContain("Prefers pnpm");
    const mention = await send(prompt({ said: "Twelve files moved." }), true, true);
    expect(mention.note.startsWith(FULL_SECTIONS_HEADING)).toBe(true);
    const legacy = await syncCodexInstructions(key, "native", "rules", prompt({ said: "Twelve files moved." }).volatile, true, request);
    expect(legacy.note).toBe("");
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts a receipt written before sections existed without resending unchanged context", async () => {
    const key = `codex-sections-legacy-${Date.now()}`;
    const request = vi.fn(async () => ({}));
    const built = prompt({});
    const old = await syncCodexInstructions(key, "native", "rules", built.volatile, false, request);
    old.commitVolatile?.();
    const upgraded = await syncCodexInstructions(key, "native", "rules", built.volatile, true, request, false, built.volatileSections);
    expect(upgraded.note).toBe("");
    expect(upgraded.commitVolatile).not.toBeNull();
    upgraded.commitVolatile?.();
    const tick = await syncCodexInstructions(key, "native", "rules", prompt({ said: "Five tests fixed." }).volatile, true, request, false, prompt({ said: "Five tests fixed." }).volatileSections);
    expect(tick.note).toContain("Five tests fixed.");
    expect(tick.note).not.toContain("Prefers pnpm");
  });
});
