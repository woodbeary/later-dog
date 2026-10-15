import { describe, expect, it } from "vitest";
import type { CloudMoveState } from "../../electron/cloud-move.mjs";
import { accountsSentences, moveLine } from "./cloud-move-line";

const automatic = { automatic: true as const };

describe("the quiet line about this Mac's dogs moving home", () => {
  it("says nothing unless the move is the automatic one", () => {
    expect(moveLine({}, { phase: "uploading" })).toBeNull();
    expect(moveLine(null, { phase: "failed", error: { code: "network", message: "" } })).toBeNull();
    expect(moveLine(automatic, { phase: "idle" })).toBeNull();
  });

  it("shows a percentage only while the upload has a size, and never claims 100 before the home has it", () => {
    expect(moveLine(automatic, { phase: "preparing" })).toEqual({ kind: "moving", percent: null });
    expect(moveLine(automatic, { phase: "exporting", progress: { bytesTransferred: 5, totalBytes: 10 } })).toEqual({ kind: "moving", percent: null });
    expect(moveLine(automatic, { phase: "uploading", progress: { bytesTransferred: 421, totalBytes: 1000 } })).toEqual({ kind: "moving", percent: 42 });
    expect(moveLine(automatic, { phase: "uploading", progress: { bytesTransferred: 1000, totalBytes: 1000 } })).toEqual({ kind: "moving", percent: 99 });
    expect(moveLine(automatic, { phase: "uploading", progress: { bytesTransferred: 1, totalBytes: 0 } })).toEqual({ kind: "moving", percent: null });
  });

  it("tells the person the home restarts while it opens the dogs", () => {
    for (const phase of ["replacing", "restarting"] as const) expect(moveLine(automatic, { phase })).toEqual({ kind: "finishing" });
  });

  it("says done, keeping the Mac's copy, and says plainly when the home already had dogs", () => {
    expect(moveLine(automatic, { phase: "done", action: "move", moved: { bots: 3, rooms: 0, chats: 4 } })).toEqual({ kind: "done" });
    expect(moveLine(automatic, { phase: "failed", error: { code: "not_empty", message: "" } })).toEqual({ kind: "kept" });
  });

  it("says the dogs are still on the Mac and offers a retry, except where a retry cannot help", () => {
    for (const code of ["network", "busy", "not_verified", "local_full", "upload_failed", "cloud_full"]) {
      expect(moveLine(automatic, { phase: "failed", error: { code, message: "" } } as CloudMoveState)).toEqual({ kind: "failed", retry: true });
    }
    for (const code of ["too_large", "shared_workspace", "busy_elsewhere"]) {
      expect(moveLine(automatic, { phase: "failed", error: { code, message: "" } } as CloudMoveState)).toEqual({ kind: "failed", retry: false });
    }
    expect(moveLine(automatic, { phase: "failed", error: { code: "cancelled", message: "" } })).toBeNull();
  });

  it("never describes a swap back to the earlier workspace as a move", () => {
    expect(moveLine(automatic, { phase: "done", action: "restore" })).toBeNull();
  });

  it("adds that the Claude and ChatGPT accounts came along, and names any that stayed", () => {
    const both = { moved: { claude: 2, chatgpt: 1 }, stayed: [] };
    expect(moveLine(automatic, { phase: "done", action: "move", accounts: both })).toEqual({ kind: "done", accounts: both });
    expect(moveLine(automatic, { phase: "idle", accounts: both })).toEqual({ kind: "accounts", accounts: both });
    expect(moveLine(automatic, { phase: "idle", accounts: { moved: { claude: 0, chatgpt: 0 }, stayed: [] } })).toBeNull();
    expect(moveLine({}, { phase: "idle", accounts: both })).toBeNull();
    expect(accountsSentences(both)).toEqual([{ key: "cloudMoveLine.accountsBoth" }]);
    expect(accountsSentences({ moved: { claude: 1, chatgpt: 0 }, stayed: [] })).toEqual([{ key: "cloudMoveLine.accountsClaude" }]);
    expect(accountsSentences({ moved: { claude: 3, chatgpt: 0 }, stayed: [] })).toEqual([{ key: "cloudMoveLine.accountsClaudeMany" }]);
    expect(accountsSentences({ moved: { claude: 0, chatgpt: 1 }, stayed: ["Work Claude", "Work Claude", ""] })).toEqual([
      { key: "cloudMoveLine.accountsChatgpt" }, { key: "cloudMoveLine.accountsStayed", names: "Work Claude" },
    ]);
    expect(accountsSentences({ moved: { claude: 0, chatgpt: 0 }, stayed: ["Claude", "ChatGPT plan"] })).toEqual([
      { key: "cloudMoveLine.accountsStayed", names: "Claude and ChatGPT plan" },
    ]);
  });
});
