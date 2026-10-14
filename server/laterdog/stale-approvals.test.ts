import { describe, expect, it, vi } from "vitest";
import type { Message } from "../store.ts";
import { RESTART_UNANSWERED_NOTE, expireStaleApprovals } from "./stale-approvals.ts";

const card = (extra: Partial<NonNullable<Message["card"]>> = {}): Message => ({
  id: `m-${Math.random()}`, at: 1, role: "bot", kind: "options",
  card: { title: "Approval needed", subtitle: "rm -rf build", options: ["Allow", "Deny"], requestType: "permission", requestId: "r", tool: "Bash", ...extra },
});

describe("approval cards left open by a restart", () => {
  it("close the ones nothing can answer any more, and leave every other card alone", () => {
    const open = card();
    const answered = card({ answered: "allow" });
    const dismissed = card({ dismissed: true });
    const already = card({ expired: true });
    const question = card({ requestType: "question" });
    const stranger = card();
    const patch = vi.fn();
    const count = expireStaleApprovals({
      cards: () => [
        { threadId: "t1", message: open }, { threadId: "t1", message: answered }, { threadId: "t1", message: dismissed },
        { threadId: "t1", message: already }, { threadId: "t1", message: question }, { threadId: "gone", message: stranger },
      ],
      owns: (threadId) => threadId === "t1",
      patch,
    });
    expect(count).toBe(1);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("t1", open.id, {
      card: expect.objectContaining({ expired: true, options: [], held: RESTART_UNANSWERED_NOTE, requestId: "r", tool: "Bash" }),
    });
  });

  it("says in plain words that the action did not run", () => {
    expect(RESTART_UNANSWERED_NOTE).toBe("later.dog restarted before this was answered, so the action was not run.");
    expect(RESTART_UNANSWERED_NOTE).not.toMatch(/\bthe user\b/i);
  });
});
