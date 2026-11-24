import { describe, expect, it } from "vitest";
import type { Notification } from "../../shared/notification.ts";
import { plainAction } from "./plain-action.ts";
import { pushWorthy } from "./push-gate.ts";
import { buildNotification } from "../notify.ts";

const bot = { id: "b1", name: "Leash", threadId: "t1" };
const note = (kind: Notification["kind"], extra: Partial<Notification> = {}): Notification => ({ kind, botId: "b1", botName: "Leash", threadId: "t1", title: "x", body: "y", ...extra });

describe("which notifications reach the phone", () => {
  it("never pushes an approval for a dog on Full access, unless a rule says always ask", () => {
    expect(pushWorthy(note("approval"), { fullAccess: true, helper: false })).toBe(false);
    expect(pushWorthy(note("approval", { mustAsk: true }), { fullAccess: true, helper: false })).toBe(true);
    expect(pushWorthy(note("approval"), { fullAccess: false, helper: false })).toBe(true);
  });

  it("keeps routine updates from helper dogs off the phone, but not what only the person can do", () => {
    const helper = { fullAccess: false, helper: true };
    for (const kind of ["done", "delegation-settled", "turn-failed", "incident", "routine-failed"] as const) {
      expect(pushWorthy(note(kind), helper)).toBe(false);
    }
    for (const kind of ["approval", "question", "takeover", "phone"] as const) {
      expect(pushWorthy(note(kind), helper)).toBe(true);
    }
    expect(pushWorthy(note("done"), { fullAccess: false, helper: false })).toBe(true);
  });
});

describe("plain words for a command", () => {
  it.each([
    ["rm -rf ~/laterdog-wt/tmp/scratch", "delete files or a scratch folder"],
    ["git worktree remove --force ~/laterdog-wt/tmp/x", "remove a scratch copy of the code"],
    ["cd /repo && git push --no-verify origin ping/x", "send code to GitHub"],
    ["pnpm install", "install software"],
  ])("%s", (command, words) => {
    expect(plainAction(command)).toBe(words);
  });

  it("leaves ordinary sentences alone", () => {
    expect(plainAction("Send the quarterly email to Sam?")).toBeNull();
  });

  it("puts the words in the title and keeps the raw command out of the notification", () => {
    const built = buildNotification("approval", bot, "t1", "rm -rf ~/laterdog-wt/tmp/scratch")!;
    expect(built.title).toBe("Leash wants to delete files or a scratch folder");
    expect(built.body).not.toContain("rm");
  });
});
