import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Message } from "../store.ts";
import { EngineForks, forkPointFor, forkSeesMessage } from "./engine-forks.ts";

let at = 0;
const msg = (id: string, fields: Partial<Message>): Message =>
  ({ id, role: "bot", kind: "text", at: ++at, ...fields }) as Message;
const ask = (id: string, text: string) => msg(id, { role: "user", text });
const reply = (id: string, text: string) => msg(id, { text });
const digest = (id: string) =>
  msg(id, { kind: "digest", digest: { tools: [] } as unknown as Message["digest"] });
const activity = (id: string) => msg(id, { kind: "activity", tool: { name: "Bash", ok: true } });

describe("forkPointFor", () => {
  const anchors = [
    { instanceId: "claude", session: "s1", at: "u1", lastMessageId: "r1" },
    { instanceId: "claude", session: "s1", at: "u2", lastMessageId: "r2" },
  ];

  it("forks at the turn whose last message ends the kept path, looking past activity and digests", () => {
    const kept = [
      ask("a1", "first"),
      reply("r1", "one"),
      ask("a2", "second"),
      reply("r2", "two"),
      activity("x"),
      digest("d"),
    ];
    expect(forkPointFor(anchors, "claude", kept)).toEqual({ session: "s1", at: "u2" });
    expect(forkPointFor(anchors, "claude", kept.slice(0, 2))).toEqual({ session: "s1", at: "u1" });
  });

  it("does not fork when the kept path ends partway through a turn, as when a message steered in mid-turn is edited", () => {
    const kept = [
      ask("a1", "first"),
      reply("r1", "one"),
      ask("a2", "second"),
      reply("mid", "half of two"),
    ];
    expect(forkPointFor(anchors, "claude", kept)).toBeUndefined();
  });

  it("does not fork when something the engine never saw follows the last anchored turn", () => {
    const kept = [
      ask("a1", "first"),
      reply("r1", "one"),
      msg("peer", { role: "user", text: "a note from another dog" }),
    ];
    expect(forkPointFor(anchors, "claude", kept)).toBeUndefined();
    expect(
      forkPointFor(anchors, "codex", [ask("a1", "first"), reply("r1", "one")]),
    ).toBeUndefined();
    expect(forkPointFor(anchors, "claude", [])).toBeUndefined();
  });

  it("treats text, compaction and room results as seen by the engine, and digests and activity as not", () => {
    expect(forkSeesMessage(reply("t", "hi"))).toBe(true);
    expect(forkSeesMessage(msg("c", { kind: "compaction" }))).toBe(true);
    expect(forkSeesMessage(digest("d"))).toBe(false);
    expect(forkSeesMessage(activity("a"))).toBe(false);
    expect(forkSeesMessage(reply("e", ""))).toBe(false);
  });
});

describe("EngineForks", () => {
  it("does not anchor an unseen steer or teammate result that arrived before the reply", () => {
    const forks = new EngineForks();
    const point = { session: "s1", at: "native-reply" };
    for (const unseen of [
      ask("steer", "unread steer"),
      msg("peer", {
        kind: "activity",
        roomRequest: { id: "child", phase: "result" } as Message["roomRequest"],
      }),
    ]) {
      const path = [ask("a1", "first"), unseen, reply("r1", "one")];
      const handed = { session: "s1", through: "a1", ids: ["r1"] };
      expect(forks.record("t1", "claude", point, path, handed)).toBeNull();
      expect(forks.pointFor("t1", "claude", path)).toBeUndefined();
    }
  });

  it("does not anchor a path under a different session's delivery receipt", () => {
    const forks = new EngineForks();
    const path = [ask("a1", "first"), reply("r1", "one")];
    expect(
      forks.record("t1", "claude", { session: "s1", at: "native-reply" }, path, {
        session: "other-session",
        through: "r1",
        ids: [],
      }),
    ).toBeNull();
  });

  it("records each turn against the last message the engine saw, keeps the newest per message, and survives a restart", () => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "engine-forks-"));
    try {
      const file = join(dir, "engine-forks.json");
      const forks = new EngineForks(file);
      const path = [ask("a1", "first"), reply("r1", "one"), activity("x")];
      expect(
        forks.record("t1", "claude", { session: "s1", at: "u1" }, path, {
          session: "s1",
          through: "r1",
          ids: [],
        })?.lastMessageId,
      ).toBe("r1");
      forks.record("t1", "claude", { session: "s1", at: "u1b" }, path, {
        session: "s1",
        through: "r1",
        ids: [],
      });
      expect(
        forks.record("t1", "claude", { session: "s1", at: "u" }, [activity("only")], {
          session: "s1",
          ids: [],
        }),
      ).toBeNull();
      const reloaded = new EngineForks(file);
      expect(reloaded.pointFor("t1", "claude", path)).toEqual({ session: "s1", at: "u1b" });
      expect(JSON.parse(readFileSync(file, "utf8")).t1).toHaveLength(1);
      reloaded.forget("t1");
      expect(new EngineForks(file).pointFor("t1", "claude", path)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
