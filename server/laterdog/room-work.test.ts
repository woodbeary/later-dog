import { describe, expect, it } from "vitest";
import type { WorkDog, WorkState } from "../../shared/work-state.ts";
import type { RoomHandoff } from "../room-handoffs.ts";
import { roomMemberFacts, roomWork, roomWorkFor, type RoomMemberFacts, type RoomWorkDeps } from "./room-work.ts";

const scout: WorkDog = { id: "scout", name: "Scout" };
const biscuit: WorkDog = { id: "biscuit", name: "Biscuit" };
const member = (dog: WorkDog, over: Partial<RoomMemberFacts> = {}): RoomMemberFacts => ({ dog, running: false, waitingOn: [], ...over });

describe("what a room is doing, as one state", () => {
  const cases: Array<[string, Parameters<typeof roomWork>[0], WorkState]> = [
    ["nobody working", { members: [member(scout), member(biscuit)] }, { kind: "idle" }],
    ["one working", { members: [member(scout, { running: true }), member(biscuit)] }, { kind: "running", dogs: [scout] }],
    ["two working", { members: [member(scout, { running: true }), member(biscuit, { running: true })] }, { kind: "running", dogs: [scout, biscuit] }],
    ["one waiting on another", { members: [member(scout, { waitingOn: [biscuit] }), member(biscuit, { running: true })] },
      { kind: "waiting-on-dog", dogs: [{ id: "biscuit", name: "Biscuit" }] }],
    ["something needing the person beats everything", {
      members: [member(scout, { running: true }), member(biscuit, { waitingOn: [scout] })],
      needsYou: { what: "Allow the deploy?" }, usageHold: { until: 5 },
    }, { kind: "needs-you", what: "Allow the deploy?" }],
    ["a usage hold beats working and waiting", {
      members: [member(scout, { running: true }), member(biscuit, { waitingOn: [scout] })],
      usageHold: { account: "Codex", until: 9 },
    }, { kind: "waiting-for-usage", account: "Codex", until: 9 }],
  ];
  it.each(cases)("%s", (_name, facts, expected) => {
    expect(roomWork(facts)).toEqual(expected);
  });

  it("names a dog once however many wait on it", () => {
    const state = roomWork({ members: [member(scout, { waitingOn: [biscuit] }), member(biscuit, { waitingOn: [biscuit] })] });
    expect(state).toEqual({ kind: "waiting-on-dog", dogs: [{ id: "biscuit", name: "Biscuit" }] });
  });
});

const handoff = (over: Partial<RoomHandoff>): RoomHandoff => ({
  id: "n", rootId: "root", threadId: "room-thread", botId: "scout", key: "k", text: "t", createdAt: 1, status: "running", result: "",
  reported: false, executions: 0, approvalGranted: false, kind: "work", groupId: "room", ...over,
});
const view = (nodes: RoomHandoff[]) => ({
  nodes: () => nodes,
  awaited: (id: string) => nodes.filter((n) => n.parentId === id),
  name: (botId: string) => ({ scout: "Scout", biscuit: "Biscuit" } as Record<string, string>)[botId],
});

describe("a room's members from what the home knows", () => {
  const group = { id: "room", memberIds: ["scout", "biscuit"] };

  it("counts a dog in a running turn or a running handoff as working", () => {
    const { members } = roomMemberFacts(group, new Set(["biscuit"]), view([handoff({ botId: "scout" })]));
    expect(members.map((m) => [m.dog.name, m.running])).toEqual([["Scout", true], ["Biscuit", true]]);
  });

  it("says who a waiting dog waits on, only while that work is open, and ignores other rooms", () => {
    const nodes = [
      handoff({ id: "w", botId: "scout", status: "waiting" }),
      handoff({ id: "c1", parentId: "w", botId: "biscuit", status: "queued" }),
      handoff({ id: "c2", parentId: "w", botId: "scout", status: "completed" }),
      handoff({ id: "x", botId: "biscuit", groupId: "other", status: "running" }),
    ];
    const { members } = roomMemberFacts(group, new Set(), view(nodes));
    expect(members[0]!.waitingOn.map((dog) => dog.name)).toEqual(["Biscuit"]);
    expect(members[1]!.running).toBe(false);
  });

  it("notes a handoff that needs the person", () => {
    expect(roomMemberFacts(group, new Set(), view([handoff({ status: "needs-you" })])).needsYouFromHandoff).toBe(true);
  });
});

describe("a room's work from its chats", () => {
  const deps = (over: Partial<RoomWorkDeps> = {}, nodes: RoomHandoff[] = []): RoomWorkDeps => ({
    ...view(nodes), turnBotIds: () => new Set(), threadIds: () => ["room-thread", "side"], tail: () => [],
    heldUntil: () => undefined, holdAccount: () => undefined, ...over,
  });
  const group = { id: "room", memberIds: ["scout", "biscuit"] };

  it("is idle with nothing going on", () => {
    expect(roomWorkFor(group, deps())).toEqual({ kind: "idle" });
  });

  it("asks for the person when a request card is open in any of the room's chats", () => {
    const open = { role: "bot", kind: "options", card: { requestId: "r", title: "Allow git push?" } };
    const answered = { role: "bot", kind: "options", card: { requestId: "r2", title: "Old", answered: "allow" } };
    const plain = { role: "bot", kind: "options", card: { title: "Pick a colour" } };
    expect(roomWorkFor(group, deps({ tail: (id) => (id === "side" ? [open] : [answered, plain]) }))).toEqual({ kind: "needs-you", what: "Allow git push?" });
    expect(roomWorkFor(group, deps({ tail: () => [answered, plain] }))).toEqual({ kind: "idle" });
  });

  it("asks for the person when a teammate's question was forwarded", () => {
    const line = { role: "bot", kind: "text", needsYou: { label: "Which branch?", status: "waiting" } };
    expect(roomWorkFor(group, deps({ tail: () => [line] }))).toEqual({ kind: "needs-you", what: "Which branch?" });
  });

  it("holds for usage until the earliest reset, naming the account", () => {
    const state = roomWorkFor(group, deps({ heldUntil: (id) => (id === "side" ? 50 : 80), holdAccount: () => "Codex" }, [handoff({})]));
    expect(state).toEqual({ kind: "waiting-for-usage", account: "Codex", until: 50 });
  });

  it("is running while a member's helpers or a computer job it started are still going after the turns end", () => {
    expect(roomWorkFor(group, deps({ helpers: (id) => (id === "side" ? 2 : 0) }))).toEqual({ kind: "running", helpers: 2 });
    expect(roomWorkFor(group, deps({ computerJobs: (id) => (id === "room-thread" ? [{ botId: "biscuit" }] : []) })))
      .toEqual({ kind: "running", computerJobs: 1, dogs: [{ id: "biscuit", name: "Biscuit" }] });
  });

  it("names who is working", () => {
    expect(roomWorkFor(group, deps({ turnBotIds: () => new Set(["scout", "biscuit"]) }))).toEqual({ kind: "running", dogs: [{ id: "scout", name: "Scout" }, { id: "biscuit", name: "Biscuit" }] });
  });
});
