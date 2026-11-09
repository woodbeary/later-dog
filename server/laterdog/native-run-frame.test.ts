import { describe, expect, it } from "vitest";
import { frameForMember, VisibleSet, type FrameContext, type StreamSeen, type Viewer } from "../bot-visibility.ts";
import type { NativeRun } from "../../shared/native-runs.ts";
import type { ServerFrame } from "../../shared/wire.ts";

const BOB: Viewer = { kind: "member", email: "bob@example.test" };
const bots = [
  { id: "pub", threadId: "t-pub", tasks: [{ threadId: "t-pub" }] },
  { id: "hr", threadId: "t-hr", visibility: { people: ["ada@example.test"] }, tasks: [{ threadId: "t-hr" }] },
];
const context = (visible: VisibleSet): FrameContext => ({ visible, webhookBot: () => undefined, freshBot: id => ({ id }), freshGroup: id => ({ id }) });
const seen = (): StreamSeen => ({ bots: new Set(["pub"]), groups: new Set() });
const run = (threadId: string): NativeRun => ({ id: `run-${threadId}`, threadId, turnId: "turn", provider: "codex", revision: 1, startedAt: 1, state: "running", observation: "live", actors: [], activityCount: 0, failureCount: 0, limitations: [] });
const frame = (threadId: string): ServerFrame => ({ kind: "native.run.updated", threadId, run: run(threadId) });

describe("native run frames", () => {
  it("reach only members who can see the conversation", () => {
    const ctx = context(new VisibleSet(bots, [], BOB));
    expect(frameForMember({ ...frame("t-hr") }, ctx, seen())).toBeUndefined();
    const visible = frame("t-pub");
    expect(frameForMember({ ...visible }, ctx, seen())).toMatchObject({ kind: "native.run.updated", run: { id: "run-t-pub" } });
  });

  it("carry the conversation at the top level so the generic visibility filter can apply", () => {
    expect(frame("t-x")).toHaveProperty("threadId", "t-x");
  });
});
