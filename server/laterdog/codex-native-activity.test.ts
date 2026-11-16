import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { NativeActor, NativeActivity, NativeObservation } from "../../shared/native-runs.ts";
import type { RuntimeEvent } from "../../shared/runtime-events.ts";
import { CodexNativeActivity } from "./codex-native-activity.ts";
import { NativeRunProjector } from "./native-run-projector.ts";
import { ensureNativeRuns, NativeRunStore } from "./native-run-store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function recorded() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  ensureNativeRuns(database);
  const store = new NativeRunStore({ read: <T>(fn: (database: DatabaseSync) => T): T => fn(database), write: <T>(fn: (database: DatabaseSync) => T): T => fn(database) });
  const projector = new NativeRunProjector(store, () => undefined);
  let clock = 1_000;
  let sequence = 0;
  const native = new CodexNativeActivity(observation => {
    projector.observe({ eventId: `native-${++sequence}`, threadId: "chat", provider: "codex", providerInstanceId: "account-a", turnId: "turn-1", createdAt: new Date(clock).toISOString(), type: "native.observed", observation } as RuntimeEvent);
  }, () => clock);
  const send = (method: string, params: Record<string, unknown> = {}) => native.receive({ method, params: { threadId: "root", turnId: "root-turn", ...params } });
  native.start("root", "root-turn");
  const helper = (threadId: string) => store.list("chat").runs[0]!.actors.find(actor => actor.nativeThreadId === threadId)!;
  return { native, send, helper, at: (ms: number) => { clock = ms; } };
}

function fixture() {
  const observations: NativeObservation[] = [];
  const native = new CodexNativeActivity(value => observations.push(value), () => 100);
  const send = (method: string, params: Record<string, unknown> = {}) => native.receive({ method, params: { threadId: "root", turnId: "root-turn", ...params } });
  const spawn = (id = "child", parent = "root", turnId = "root-turn") => send("item/completed", { threadId: parent, turnId, item: { type: "collabAgentToolCall", id: `spawn-${id}`, senderThreadId: parent, tool: "spawnAgent", status: "completed", receiverThreadIds: [id], prompt: "Check the search results", agentsStates: { [id]: { status: "running" } } } });
  const actors = () => observations.flatMap(value => value.kind === "actor" ? [value.actor] : []);
  const activities = () => observations.flatMap(value => value.kind === "activity" ? [value.activity] : []);
  const latestActor = (id: string): NativeActor | undefined => actors().filter(value => value.nativeThreadId === id).at(-1);
  const latestActivity = (id: string): NativeActivity | undefined => activities().filter(value => value.id.endsWith(`:${id}`)).at(-1);
  native.start("root", "root-turn");
  return { native, send, spawn, observations, actors, activities, latestActor, latestActivity };
}

describe("Codex native activity ownership", () => {
  it("keeps descendants distinct while rejecting unrelated threads, stale root turns and unscoped items", () => {
    const f = fixture();
    f.spawn();
    f.send("turn/started", { threadId: "child", turn: { id: "child-turn" } });
    f.spawn("grandchild", "child", "child-turn");
    f.send("item/agentMessage/delta", { threadId: "child", turnId: "child-turn", itemId: "answer", delta: "Child text" });
    f.send("item/completed", { threadId: "grandchild", turnId: "grandchild-turn", item: { id: "answer", type: "agentMessage", text: "Nested answer" } });
    for (const scope of [{ threadId: "stranger", turnId: "their-turn" }, { threadId: "root", turnId: "stale" }, { threadId: "root", turnId: null }]) {
      f.send("item/completed", { ...scope, item: { id: "foreign", type: "agentMessage", text: "FOREIGN" } });
    }
    expect(f.latestActor("child")).toMatchObject({ id: "codex:child:0", parentId: "parent", nativeTurnId: "child-turn", task: "Check the search results", canStop: true });
    expect(f.latestActor("grandchild")).toMatchObject({ parentId: "codex:child:0" });
    expect(f.activities()).toContainEqual(expect.objectContaining({ actorId: "codex:child:0", text: "Child text" }));
    expect(JSON.stringify(f.observations)).not.toContain("FOREIGN");
  });

  it("requires a proven parent for thread-started ownership and never treats listAgents as ownership", () => {
    const f = fixture();
    f.native.receive({ method: "thread/started", params: { thread: { id: "source-child", source: { subAgent: { thread_spawn: { parent_thread_id: "root", agent_nickname: "Scout" } } } } } });
    f.native.receive({ method: "thread/started", params: { thread: { id: "foreign", parentThreadId: "elsewhere" } } });
    f.send("item/completed", { item: { id: "list", type: "collabAgentToolCall", tool: "listAgents", status: "completed", receiverThreadIds: ["listed"], agentsStates: { listed: { status: "running" } } } });
    expect(f.latestActor("source-child")).toMatchObject({ label: "Scout", parentId: "parent" });
    expect(f.latestActor("foreign")).toBeUndefined();
    expect(f.latestActor("listed")).toBeUndefined();
  });

  it("binds child stops to the latest owned native turn and rejects stale generations and parent controls", () => {
    const f = fixture();
    f.spawn();
    expect(() => f.native.stopTarget({ id: "codex:child:0" })).toThrow("no longer running");
    f.send("turn/started", { threadId: "child", turn: { id: "one" } });
    const old = f.latestActor("child")!;
    expect(f.native.stopTarget(old)).toEqual({ threadId: "child", turnId: "one" });
    f.send("turn/completed", { threadId: "child", turn: { id: "one", status: "completed" } });
    f.send("turn/started", { threadId: "child", turn: { id: "two" } });
    expect(f.latestActor("child")).toMatchObject({ id: "codex:child:1", generation: "1", nativeTurnId: "two", canStop: true });
    expect(() => f.native.stopTarget(old)).toThrow("no longer running");
    expect(() => f.native.stopTarget({ ...f.latestActor("child")!, nativeThreadId: "root" })).toThrow();
    f.send("turn/completed", { threadId: "child", turn: { id: "one", status: "failed" } });
    expect(f.latestActor("child")?.state).toBe("running");
    expect(f.native.stopTarget(f.latestActor("child")!)).toEqual({ threadId: "child", turnId: "two" });
    f.native.finish(true);
    expect(f.latestActor("child")).toMatchObject({ state: "stopped", canStop: false });
    expect(() => f.native.stopTarget(f.latestActor("child")!)).toThrow();
  });

  it("retains early owned notifications once native scope is established", () => {
    const seen: NativeObservation[] = [];
    const native = new CodexNativeActivity(value => seen.push(value));
    native.receive({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { type: "agentMessage", id: "early", text: "Early answer" } } });
    expect(seen).toHaveLength(0);
    native.start("root", "root-turn");
    expect(seen).toContainEqual(expect.objectContaining({ kind: "activity", activity: expect.objectContaining({ text: "Early answer" }) }));
  });
});

describe("Codex native activity details", () => {
  it("captures incremental commands, authoritative output, searches, plans, hooks, compaction and unknown notices", () => {
    const f = fixture();
    f.send("item/started", { item: { id: "cmd", type: "commandExecution", command: "pnpm test", status: "inProgress" } });
    f.send("item/commandExecution/outputDelta", { itemId: "cmd", delta: "First\n" });
    f.send("item/commandExecution/outputDelta", { itemId: "cmd", delta: "Second\n" });
    expect(f.latestActivity("cmd")).toMatchObject({ label: "pnpm test", output: "First\nSecond\n", state: "running" });
    f.send("item/completed", { item: { id: "cmd", type: "commandExecution", command: "pnpm test", status: "completed", aggregatedOutput: "First\nSecond\nDone" } });
    f.send("item/completed", { item: { id: "search", type: "webSearch", query: "native events", action: { type: "openPage", url: "https://example.test/docs" }, results: [{ title: "Docs", url: "https://example.test/docs" }, { url: "javascript:bad" }] } });
    f.send("turn/plan/updated", { plan: [{ step: "Inspect", status: "completed" }, { step: "Verify", status: "inProgress" }] });
    f.send("hook/started", { turnId: null, run: { id: "hook", eventName: "sessionStart", status: "running" } });
    f.send("hook/completed", { turnId: null, run: { id: "hook", eventName: "sessionStart", status: "completed", entries: [{ kind: "feedback", text: "Hook finished" }] } });
    f.send("item/completed", { item: { id: "compact", type: "contextCompaction" } });
    f.send("item/newFeature/progress", { itemId: "unknown" });
    expect(f.latestActivity("cmd")).toMatchObject({ output: "First\nSecond\nDone", state: "done" });
    expect(f.latestActivity("search")).toMatchObject({ kind: "search", label: "native events", links: [{ title: "https://example.test/docs", url: "https://example.test/docs" }, { title: "Docs", url: "https://example.test/docs" }] });
    expect(f.latestActivity("turn-plan")?.text).toContain("inProgress: Verify");
    expect(f.latestActivity("hook")).toMatchObject({ kind: "hook", output: "Hook finished", state: "done" });
    expect(f.latestActivity("compact")?.kind).toBe("compaction");
    expect(f.activities()).toContainEqual(expect.objectContaining({ label: "Native event: item/newFeature/progress", kind: "notice" }));
  });

  it("attributes child questions and resolutions and handles thread-only waiting states", () => {
    const f = fixture();
    f.spawn();
    const params = { threadId: "child", turnId: "child-turn" };
    expect(f.native.request(params, "req", "Allow command?")).toBe("codex:child:0");
    f.send("thread/status/changed", { threadId: "child", turnId: undefined, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    expect(f.latestActor("child")).toMatchObject({ state: "waiting", canStop: true, nativeTurnId: "child-turn" });
    f.native.request(params, "req", "Allow command?", "deny (user)");
    expect(f.latestActivity("req")).toMatchObject({ actorId: "codex:child:0", kind: "request", requestId: "req", output: "deny (user)", state: "stopped" });
    expect(f.native.request({ threadId: "foreign" }, "bad", "No")).toBeUndefined();
  });

  it("captures 0.163 resolved child models and incremental file patches without crossing native scopes", () => {
    const f = fixture();
    f.send("item/completed", { item: { id: "child-started", type: "subAgentActivity", agentPath: "/root/scout", agentThreadId: "child", kind: "started", model: "gpt-6.1-sol", reasoningEffort: "high" } });
    f.send("item/fileChange/patchUpdated", { threadId: "child", turnId: "child-turn", itemId: "edit", changes: [{ path: "/workspace/example.ts", kind: { type: "update" }, diff: "-before\n+after" }] });
    f.send("item/fileChange/patchUpdated", { threadId: "foreign", turnId: "foreign-turn", itemId: "edit", changes: [{ diff: "FOREIGN" }] });
    expect(f.latestActor("child")).toMatchObject({ label: "scout", model: "gpt-6.1-sol" });
    expect(f.latestActivity("edit")).toMatchObject({ actorId: "codex:child:0", kind: "tool", label: "File changes", state: "running", output: expect.stringContaining("-before\\n+after") });
    f.send("item/completed", { threadId: "child", turnId: "child-turn", item: { id: "edit", type: "fileChange", status: "completed", changes: [{ path: "/workspace/example.ts", diff: "Final patch" }] } });
    expect(f.latestActivity("edit")).toMatchObject({ state: "done", output: expect.stringContaining("Final patch") });
    expect(JSON.stringify(f.observations)).not.toContain("FOREIGN");
  });

  it("bounds accumulated output and explicitly marks truncation", () => {
    const f = fixture();
    f.send("item/commandExecution/outputDelta", { itemId: "large", delta: "x".repeat(20_000) });
    f.send("item/commandExecution/outputDelta", { itemId: "large", delta: "y".repeat(20_000) });
    expect(f.latestActivity("large")?.output).toHaveLength(24_000);
    expect(f.latestActivity("large")?.truncated).toBe(true);
    f.native.capabilities("0.154.0");
    expect(f.observations.at(-1)).toMatchObject({ kind: "capabilities", version: "0.154.0", limitations: expect.arrayContaining(["Native helpers stop when the parent turn ends.", "Conversation branches replay later.dog history; native Codex forks, projects and worktrees are not managed from this activity view."]) });
  });
});

describe("when a Codex helper last moved", () => {
  it("moves when the parent hears what a helper is doing", () => {
    let clock = 100;
    const observations: NativeObservation[] = [];
    const native = new CodexNativeActivity(value => observations.push(value), () => clock);
    native.start("root", "root-turn");
    const latest = () => observations.flatMap(value => value.kind === "actor" && value.actor.nativeThreadId === "child" ? [value.actor] : []).at(-1);
    clock = 400;
    native.receive({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "child-started", type: "subAgentActivity", agentPath: "/root/scout", agentThreadId: "child", kind: "started" } } });
    expect(latest()?.lastActivityAt).toBe(400);
    clock = 900;
    native.receive({ method: "item/completed", params: { threadId: "root", turnId: "root-turn", item: { id: "child-done", type: "subAgentActivity", agentPath: "/root/scout", agentThreadId: "child", kind: "completed" } } });
    expect(latest()).toMatchObject({ state: "done", lastActivityAt: 900 });
  });

  it("moves when the helper's own step starts, gets output or ends, and not on the parent's work", () => {
    const f = recorded();
    f.send("item/completed", { item: { type: "collabAgentToolCall", id: "spawn-child", senderThreadId: "root", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], prompt: "Check the spring menu", agentsStates: { child: { status: "running" } } } });
    f.at(2_000);
    f.send("turn/started", { threadId: "child", turn: { id: "child-turn" } });
    expect(f.helper("child").lastActivityAt).toBeUndefined();
    f.at(5_000);
    f.send("item/started", { threadId: "child", turnId: "child-turn", item: { id: "cmd", type: "commandExecution", command: "npm test", status: "inProgress" } });
    expect(f.helper("child").lastActivityAt).toBe(5_000);
    f.at(7_000);
    f.send("item/commandExecution/outputDelta", { threadId: "child", turnId: "child-turn", itemId: "cmd", delta: "ok" });
    expect(f.helper("child").lastActivityAt).toBe(7_000);
    f.at(9_000);
    f.send("item/completed", { threadId: "child", turnId: "child-turn", item: { id: "cmd", type: "commandExecution", command: "npm test", status: "completed", exitCode: 0, aggregatedOutput: "ok" } });
    expect(f.helper("child").lastActivityAt).toBe(9_000);
    f.at(12_000);
    f.send("item/agentMessage/delta", { itemId: "answer", delta: "Waiting on the helper" });
    f.send("item/completed", { item: { type: "collabAgentToolCall", id: "wait-child", senderThreadId: "root", tool: "wait", status: "completed", receiverThreadIds: ["child"], agentsStates: { child: { status: "running", message: "Still checking" } } } });
    expect(f.helper("child").lastActivityAt).toBe(9_000);
  });
});
