import { describe, expect, it } from "vitest";
import type { RoomHandoff } from "../room-handoffs.ts";
import { exchangeThreads, roomExchange, withExchange, type ExchangeLookup } from "./room-exchange.ts";

const node = (over: Partial<RoomHandoff>): RoomHandoff => ({
  id: "child", rootId: "root", parentId: "root", threadId: "scout-thread", botId: "scout", key: "scout",
  text: "Check the invoice totals", createdAt: 1, status: "running", result: "", reported: false, executions: 1,
  approvalGranted: false, kind: "work", ...over,
});
const root = node({ id: "root", rootId: "root", parentId: undefined, threadId: "clover-thread", botId: "clover", key: "root", status: "source", text: "Pay the bills", requestedBy: "p_person" });

const lookupOf = (nodes: RoomHandoff[]): ExchangeLookup => ({
  node: (id) => nodes.find((candidate) => candidate.id === id),
  batch: (of) => (of.requestBatchKey && of.parentId
    ? nodes.filter((candidate) => candidate.parentId === of.parentId && candidate.requestBatchKey === of.requestBatchKey)
    : [of]),
  children: (id) => nodes.filter((candidate) => candidate.parentId === id),
  name: (botId) => ({ clover: "Clover", scout: "Scout", patch: "Patch" } as Record<string, string>)[botId],
  redact: (text) => text.replace(/sk-[a-z0-9]+/g, "[redacted]"),
});

describe("a dog-to-dog exchange on the wire", () => {
  it("names the owner, both dogs, the request and the state", () => {
    const child = node({});
    expect(roomExchange(child, lookupOf([root, child]))).toEqual({
      id: "child", status: "running", to: "Scout", from: "Clover", parentId: "root",
      owner: { dog: "Clover", person: true }, request: "Check the invoice totals",
    });
  });

  it("carries the actual reply only when the work completed", () => {
    const child = node({ status: "completed", result: "Totals match: $4,210" });
    expect(roomExchange(child, lookupOf([root, child]))).toMatchObject({ status: "completed", reply: "Totals match: $4,210" });
  });

  it("does not call an acknowledgment without a result done", () => {
    const child = node({ status: "completed", result: "  " });
    const exchange = roomExchange(child, lookupOf([root, child]));
    expect(exchange?.status).toBe("running");
    expect(exchange?.reply).toBeUndefined();
  });

  it("a send that asks for no reply can finish without one", () => {
    const child = node({ status: "completed", result: "", reply: "none" });
    expect(roomExchange(child, lookupOf([root, child]))?.status).toBe("completed");
  });

  it("says who it is waiting on and why it ended", () => {
    const child = node({ status: "waiting" });
    const grandchild = node({ id: "grand", parentId: "child", botId: "patch", threadId: "patch-thread", status: "queued" });
    expect(roomExchange(child, lookupOf([root, child, grandchild]))).toMatchObject({ status: "waiting", waitingOn: ["Patch"] });
    const ended = node({ status: "failed", endedBy: "restart", result: "lost" });
    expect(roomExchange(ended, lookupOf([root, ended]))).toMatchObject({ status: "failed", endedBy: "restart" });
    expect(roomExchange(ended, lookupOf([root, ended]))?.reply).toBeUndefined();
  });

  it("redacts secrets and never maps the person's own source request", () => {
    const child = node({ text: "Use sk-abc123 to log in" });
    expect(roomExchange(child, lookupOf([root, child]))?.request).toBe("Use [redacted] to log in");
    expect(roomExchange(root, lookupOf([root]))).toBeUndefined();
  });

  it("attaches to a message that names the handoff and leaves others alone", () => {
    const child = node({});
    const lookup = lookupOf([root, child]);
    const sent = { id: "m", role: "bot" as const, kind: "activity" as const, at: 1, handoffId: "child" };
    expect(withExchange(sent, lookup).exchange?.id).toBe("child");
    const plain = { id: "n", role: "bot" as const, kind: "text" as const, at: 1 };
    expect(withExchange(plain, lookup)).toBe(plain);
  });

  it("finds both the asking and the answering chat when a handoff changes", () => {
    const child = node({});
    const touched = exchangeThreads([root, child], new Set(), new Set(["scout-thread"]), (id) => [root, child].find((n) => n.id === id));
    expect([...touched.keys()].sort()).toEqual(["clover-thread", "scout-thread"]);
  });
});

describe("a request sent to several dogs at once", () => {
  const first = node({ id: "first", botId: "scout", requestBatchKey: "batch", groupId: "room", status: "completed", result: "Done" });
  const second = node({ id: "second", botId: "patch", threadId: "scout-thread", requestBatchKey: "batch", groupId: "room", status: "running" });
  const lookup = lookupOf([root, first, second]);
  const request = { id: "m", role: "bot" as const, kind: "text" as const, at: 1, roomRequest: { id: "first", phase: "request" as const } };

  it("gives the shared request line one record per recipient, each from its own handoff", () => {
    const wired = withExchange(request, lookup);
    expect(wired.exchange).toBeUndefined();
    expect(wired.exchanges?.map((record) => [record.id, record.to, record.status])).toEqual([
      ["first", "Scout", "completed"], ["second", "Patch", "running"],
    ]);
  });

  it("keeps following each sibling when only the second one changes", () => {
    const later = { ...second, status: "completed" as const, result: "Ok" };
    const wired = withExchange(request, lookupOf([root, first, later]));
    expect(wired.exchanges?.map((record) => record.status)).toEqual(["completed", "completed"]);
  });

  it("still gives a lone request one record, and a sibling's own result line its own", () => {
    const alone = node({ id: "alone", requestBatchKey: undefined });
    expect(withExchange({ ...request, roomRequest: { id: "alone", phase: "request" as const } }, lookupOf([root, alone])).exchange?.id).toBe("alone");
    const result = { ...request, roomRequest: { id: "second", phase: "result" as const } };
    expect(withExchange(result, lookup).exchange?.id).toBe("second");
  });

  it("resends the shared request line when a later sibling changes", () => {
    const touched = exchangeThreads([root, second], new Set(["room"]), new Set(), (id) => [root, first, second].find((n) => n.id === id), () => "first");
    expect(touched.get("scout-thread")).toEqual(new Set(["second", "first"]));
  });
});
