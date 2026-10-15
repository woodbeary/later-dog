import { describe, expect, it } from "vitest";

import { describeRun, groupActivityRuns, groupTranscript, isRecoveryActivity, planTranscript, statusActivity } from "./activity-runs";
import type { Message } from "@/state/store";

let seq = 0;
const tool = (name: string, ok = true): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name, ok } });
const running = (name: string): Message =>
  ({ id: `t${++seq}`, at: seq, role: "bot", kind: "activity", tool: { name } });
const text = (body: string): Message => ({ id: `m${++seq}`, at: seq, role: "bot", kind: "text", text: body });

describe("groupActivityRuns", () => {
  it("folds consecutive tool steps into one run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Bash"), tool("Edit")]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("run");
    expect(items[0].kind === "run" && items[0].messages).toHaveLength(3);
  });

  it("keeps text between runs, so a run never swallows what the bot said", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), text("Now the sitemap:"), tool("Write"), tool("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("never folds an opened-thread chip into a run — it is navigation, not work", () => {
    const opened: Message = { ...tool("Opened thread #QA PR 245 on Scout"),
      threadRef: { botId: "scout", threadId: "qa-245", title: "QA PR 245" } };
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), opened, tool("Write"), tool("Write")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("leaves a lone tool step as an ordinary message", () => {
    const items = groupActivityRuns([text("hi"), tool("Edit"), text("done")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message", "message"]);
  });

  it("keeps a step that is still running out of the run, so live progress stays visible", () => {
    const items = groupActivityRuns([tool("Edit"), tool("Edit"), running("Bash")]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message"]);
    expect(items[1].kind === "message" && items[1].message.tool?.name).toBe("Bash");
  });

  it("never folds a failed turn, which renders as an error not a tool run", () => {
    const items = groupActivityRuns([tool("Edit"), tool("error: the CLI exited")]);
    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
  });

  it("keeps recovery visible between successful tool runs", () => {
    const recovery = tool("recovery: Automatic recovery: trying a backup once.");
    const messages = [tool("Read"), tool("Edit"), recovery, tool("Bash"), tool("Write")];
    expect(isRecoveryActivity(recovery)).toBe(true);
    expect(isRecoveryActivity(text("recovery: ordinary text"))).toBe(false);
    for (const group of [groupActivityRuns, groupTranscript]) {
      const items = group(messages);
      expect(items.map(item => item.kind)).toEqual(["run", "message", "run"]);
      expect(items[1]).toEqual({ kind: "message", message: recovery });
    }
  });

  it("keeps a model notice visible between successful tool runs", () => {
    const notice = tool("notice: OpenCode no longer offers opencode/x, so this conversation uses opencode/big-pickle.");
    const messages = [tool("Read"), tool("Edit"), notice, tool("Bash"), tool("Write")];
    expect(statusActivity(notice)).toEqual({
      kind: "notice", text: "OpenCode no longer offers opencode/x, so this conversation uses opencode/big-pickle.",
    });
    expect(isRecoveryActivity(notice)).toBe(false);
    expect(statusActivity(text("notice: ordinary text"))).toBeNull();
    for (const group of [groupActivityRuns, groupTranscript]) {
      const items = group(messages);
      expect(items.map(item => item.kind)).toEqual(["run", "message", "run"]);
      expect(items[1]).toEqual({ kind: "message", message: notice });
    }
  });

  it("keeps ordinary failed tools visible between successful runs", () => {
    const items = groupActivityRuns([
      tool("Read"),
      tool("Edit"),
      tool("Bash", false),
      tool("Write"),
      tool("Write"),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["run", "message", "run"]);
  });

  it("gives a run a stable id taken from its first step", () => {
    const steps = [tool("Edit"), tool("Edit")];
    const items = groupActivityRuns(steps);
    expect(items[0].kind === "run" && items[0].id).toBe(`run:${steps[0].id}`);
  });

  it("does not attribute consecutive room steps from different bots to one sender", () => {
    const roomTool = (name: string, botId: string): Message => ({
      ...tool(name),
      from: { botId, name: botId, color: "blue" },
    });

    expect(
      groupActivityRuns([
        roomTool("Read", "alice"),
        roomTool("Edit", "alice"),
        roomTool("Write", "bob"),
        roomTool("Bash", "bob"),
      ]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });

  it("keeps local calendar-day boundaries between activity runs", () => {
    const beforeMidnight = new Date(2026, 0, 1, 23, 59).getTime();
    const afterMidnight = new Date(2026, 0, 2, 0, 1).getTime();
    const stepAt = (name: string, at: number): Message => ({ ...tool(name), at });

    expect(
      groupActivityRuns([
        stepAt("Read", beforeMidnight),
        stepAt("Edit", beforeMidnight),
        stepAt("Write", afterMidnight),
        stepAt("Bash", afterMidnight),
      ]).map((item) => item.kind),
    ).toEqual(["run", "run"]);
  });
});

describe("describeRun", () => {
  it("counts repeats and names the tools in order of first use", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Edit"), tool("Edit")])).toBe("4 steps · Edit ×3, Bash");
  });

  it("names a single repeat without a multiplier", () => {
    expect(describeRun([tool("Edit"), tool("Bash")])).toBe("2 steps · Edit, Bash");
  });

  it("trims a long tail of tool names rather than running off the row", () => {
    expect(describeRun([tool("Edit"), tool("Bash"), tool("Write"), tool("Grep"), tool("Read")])).toBe(
      "5 steps · Edit, Bash, Write +2 more",
    );
  });
});

describe("groupTranscript", () => {
  const assistant = (
    body: string,
    turnId: string,
    turnTerminal = false,
    at = ++seq * 1_000,
  ): Message => ({
    id: `m${++seq}`,
    at,
    role: "bot",
    kind: "text",
    text: body,
    turnId,
    turnTerminal,
  });
  const step = (name: string, turnId: string): Message => ({ ...tool(name), turnId });
  const picture = (turnId: string, at: number): Message => ({
    ...assistant("", turnId, false, at),
    attachments: [{ kind: "image", path: `/attachments/${at}.png`, mime: "image/png" }],
  });

  it("keeps the first thing a dog says, folds the rest of its progress talk and leaves the answer", () => {
    const user: Message = { id: "u1", at: 1_000, role: "user", kind: "text", text: "check todoist" };
    const first = assistant("I'm checking connected apps.", "turn-1", false, 2_000);
    const apps = step("list_apps", "turn-1");
    const second = assistant("I'm reading your tasks.", "turn-1", false, 3_000);
    const tasks = step("read_tasks", "turn-1");
    const final = assistant("You have three tasks.", "turn-1", true, 5_000);

    const items = groupTranscript([user, first, apps, second, tasks, final]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "run", "turn", "message"]);
    expect(items[1].kind === "message" && items[1].message).toBe(first);
    expect(items[2]).toMatchObject({ kind: "run", messages: [apps, tasks] });
    expect(items[3]).toMatchObject({
      kind: "turn",
      id: "turn:turn-1",
      label: "Worked for 4s",
      messages: [second],
    });
    expect(items[4].kind === "message" && items[4].message).toBe(final);
  });

  it("keeps an update that comes after a minute of quiet work", () => {
    const user: Message = { id: "u9", at: 0, role: "user", kind: "text", text: "tidy my inbox" };
    const first = assistant("Opening your inbox.", "turn-long", false, 1_000);
    const reading = step("read_mail", "turn-long");
    const chatter = assistant("Reading the newest mail.", "turn-long", false, 20_000);
    const sorting = step("move_mail", "turn-long");
    const update = assistant("Halfway there, 40 left.", "turn-long", false, 90_000);
    const more = step("move_mail", "turn-long");
    const final = assistant("Your inbox is tidy.", "turn-long", true, 120_000);

    const plan = planTranscript([user, first, reading, chatter, sorting, update, more, final]);
    expect([...plan.hiddenIds]).toEqual([chatter.id]);
    expect([...plan.byAnchorId.keys()]).toEqual([final.id]);
    expect(plan.byAnchorId.get(final.id)).toMatchObject({ label: "Worked for 2m 00s", messages: [chatter] });
  });

  it("keeps an answer no step follows, so a message sent mid-turn never hides it", () => {
    const user: Message = { id: "u3", at: 1_000, role: "user", kind: "text", text: "write 80 dog facts" };
    const steer: Message = { id: "u4", at: 2_000, role: "user", kind: "text", text: "end with DONE", steered: true };
    const list = assistant("1. Dogs sweat through their paws.\n\nDONE", "turn-steer", false, 3_000);
    const done = assistant("DONE", "turn-steer", true, 4_000);

    expect(groupTranscript([user, steer, list, done])).toEqual(
      [user, steer, list, done].map((message) => ({ kind: "message", message })),
    );
  });

  it("keeps the answer when the mid-turn message lands after it", () => {
    const user: Message = { id: "u5", at: 1_000, role: "user", kind: "text", text: "write 80 dog facts" };
    const list = assistant("1. Dogs sweat through their paws.", "turn-late", false, 2_000);
    const steer: Message = { id: "u6", at: 3_000, role: "user", kind: "text", text: "end with DONE", steered: true };
    const done = assistant("DONE", "turn-late", true, 4_000);

    expect(groupTranscript([user, list, steer, done]).map((item) => item.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
  });

  it("folds only the talk a step follows and puts the fold where the work ended", () => {
    const user: Message = { id: "u7", at: 1_000, role: "user", kind: "text", text: "list the files" };
    const opening = assistant("Listing the folder.", "turn-mixed", false, 2_000);
    const listing = step("Bash", "turn-mixed");
    const narration = assistant("Reading the notes too.", "turn-mixed", false, 2_500);
    const reading = step("Read", "turn-mixed");
    const answer = assistant("The folder holds haiku.md.", "turn-mixed", false, 3_000);
    const steer: Message = { id: "u8", at: 3_500, role: "user", kind: "text", text: "now say DONE", steered: true };
    const done = assistant("DONE", "turn-mixed", true, 4_000);

    const items = groupTranscript([user, opening, listing, narration, reading, answer, steer, done]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "run", "turn", "message", "message", "message"]);
    expect(items[3]).toMatchObject({ kind: "turn", messages: [narration] });
    expect(items[4].kind === "message" && items[4].message).toBe(answer);
  });

  it("folds talk before a question card, which carries no turn of its own", () => {
    const opening = assistant("Looking at your calendar.", "turn-ask", false, 1_000);
    const ask = assistant("One question first.", "turn-ask", false, 2_000);
    const card: Message = { id: "c1", at: 2_500, role: "bot", kind: "options" };
    const final = assistant("Noted.", "turn-ask", true, 3_000);

    const items = groupTranscript([opening, ask, card, final]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "turn", "message"]);
    expect(items[1].kind === "message" && items[1].message).toBe(card);
    expect(items[2]).toMatchObject({ kind: "turn", messages: [ask] });
  });

  it("does not count another turn's step as this turn's work", () => {
    const progress = assistant("Checking.", "turn-mine");
    const more = assistant("Still checking.", "turn-mine");
    const elsewhere = step("Bash", "turn-theirs");
    const final = assistant("Done.", "turn-mine", true);
    expect(groupTranscript([progress, more, elsewhere, final]).map((item) => item.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
  });

  it("keeps every message visible while the turn is running unless the chat is quiet", () => {
    const user: Message = { id: "u10", at: 10_000, role: "user", kind: "text", text: "book it" };
    const first = assistant("Opening the booking page.", "turn-live", false, 11_000);
    const clicking = step("mcp__computer__click", "turn-live");
    const second = assistant("Picking a time.", "turn-live", false, 15_000);
    const typing = step("mcp__computer__type_text", "turn-live");
    const update = assistant("Still waiting on the confirmation page.", "turn-live", false, 80_000);
    const later = assistant("Almost there.", "turn-live", false, 85_000);
    const transcript = [user, first, clicking, second, typing, update, later];

    expect(planTranscript(transcript).hiddenIds.size).toBe(0);
    expect(planTranscript(transcript, { runningSince: 10_500 }).hiddenIds.size).toBe(0);
    const quiet = planTranscript(transcript, { runningSince: 10_500, quiet: true });
    expect([...quiet.hiddenIds]).toEqual([second.id, later.id]);
    expect(quiet.byAnchorId.size).toBe(0);
    expect(planTranscript(transcript, { runningSince: 90_000, quiet: true }).hiddenIds.size).toBe(0);
  });

  it("folds every spoken update while the turn runs when asked to, keeping only the first thing said", () => {
    const user: Message = { id: "u20", at: 10_000, role: "user", kind: "text", text: "book it" };
    const first = assistant("Opening the booking page.", "turn-fold", false, 11_000);
    const second = assistant("Picking a time.", "turn-fold", false, 15_000);
    const update = assistant("Still waiting on the confirmation page.", "turn-fold", false, 80_000);
    const transcript = [user, first, second, update];

    const folded = planTranscript(transcript, { runningSince: 10_500, foldAll: true });
    expect([...folded.hiddenIds]).toEqual([second.id, update.id]);
    expect(planTranscript(transcript, { runningSince: 10_500 }).hiddenIds.size).toBe(0);
    expect(planTranscript(transcript, { runningSince: 90_000, foldAll: true }).hiddenIds.size).toBe(0);
  });

  it("folds a long run's spoken updates into the worked line afterwards when asked to", () => {
    const user: Message = { id: "u21", at: 1_000, role: "user", kind: "text", text: "go" };
    const first = assistant("On it.", "turn-long", false, 2_000);
    const a = step("Read", "turn-long");
    const update = assistant("Halfway through the notes.", "turn-long", false, 120_000);
    const b = step("Bash", "turn-long");
    const final = assistant("All done.", "turn-long", true, 200_000);
    const transcript = [user, first, a, update, b, final];

    expect(planTranscript(transcript).hiddenIds.has(update.id)).toBe(false);
    const plan = planTranscript(transcript, { foldAll: true });
    expect(plan.hiddenIds.has(update.id)).toBe(true);
    expect([...plan.byAnchorId.values()][0]).toMatchObject({ kind: "turn", messages: [update] });
  });

  describe("a reply to a message sent mid-turn", () => {
    const ask = (id: string, at: number): Message => ({ id, at, role: "user", kind: "text", text: "well?", steered: true });
    const scene = () => {
      const user: Message = { id: "r0", at: 10_000, role: "user", kind: "text", text: "book it" };
      const first = assistant("Opening the booking page.", "turn-reply", false, 11_000);
      const chatter = assistant("Picking a time.", "turn-reply", false, 15_000);
      const hello = ask("r1", 20_000);
      const reply = assistant("Still working, on the last step.", "turn-reply", false, 21_000);
      const after = assistant("Almost there.", "turn-reply", false, 25_000);
      return { user, first, chatter, hello, reply, after };
    };

    it("stays visible while the turn runs", () => {
      const { user, first, chatter, hello, reply, after } = scene();
      const transcript = [user, first, chatter, hello, reply, after];
      const quiet = planTranscript(transcript, { runningSince: 10_500, quiet: true });
      expect([...quiet.hiddenIds]).toEqual([chatter.id, after.id]);
      const folded = planTranscript(transcript, { runningSince: 10_500, foldAll: true });
      expect([...folded.hiddenIds]).toEqual([chatter.id, after.id]);
    });

    it("stays visible after the turn ends instead of folding into the worked line", () => {
      const { user, first, chatter, hello, reply, after } = scene();
      const work = step("Read", "turn-reply");
      const final = assistant("Booked.", "turn-reply", true, 40_000);
      const plan = planTranscript([user, first, chatter, hello, reply, after, work, final]);
      expect(plan.hiddenIds.has(reply.id)).toBe(false);
      expect([...plan.hiddenIds]).toEqual([chatter.id, after.id]);
    });

    it("changes nothing without a message sent mid-turn", () => {
      const { user, first, chatter, reply, after } = scene();
      const quiet = planTranscript([user, first, chatter, reply, after], { runningSince: 10_500, quiet: true });
      expect([...quiet.hiddenIds]).toEqual([chatter.id, reply.id, after.id]);
    });

    it("forces only the first spoken message after several user messages", () => {
      const { user, first, chatter, reply, after } = scene();
      const transcript = [user, first, chatter, ask("r2", 18_000), ask("r3", 19_000), reply, after];
      const quiet = planTranscript(transcript, { runningSince: 10_500, quiet: true });
      expect([...quiet.hiddenIds]).toEqual([chatter.id, after.id]);
    });
  });

  it("keeps a lone terminal message as the answer", () => {
    const only = assistant("I could not finish, but here is what I found.", "turn-short", true);
    expect(groupTranscript([only])).toEqual([{ kind: "message", message: only }]);
  });

  it("keeps a picture a tool made where it was made", () => {
    const user: Message = { id: "u2", at: 1_000, role: "user", kind: "text", text: "chart my week" };
    const opening = assistant("Drawing the chart.", "turn-img", false, 2_000);
    const charting = step("mcp__charts__render_chart", "turn-img");
    const chart = picture("turn-img", 3_000);
    const final = assistant("Here it is.", "turn-img", true, 4_000);

    const transcript = [user, opening, charting, chart, final];
    expect(planTranscript(transcript, { quiet: true }).hiddenIds.size).toBe(0);
    const items = groupTranscript(transcript, planTranscript(transcript, { quiet: true }));
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "message", "message", "message"]);
    expect(items[3].kind === "message" && items[3].message).toBe(chart);
  });

  it("leaves old screenshots of the screen out of a quiet chat", () => {
    const user: Message = { id: "u11", at: 1_000, role: "user", kind: "text", text: "log in" };
    const opening = assistant("Opening the sign-in page.", "turn-shots", false, 2_000);
    const looking = step("mcp__computer__screenshot", "turn-shots");
    const shot = picture("turn-shots", 3_000);
    const browsing = step("mcp__browser__agent_browser_screenshot", "turn-shots");
    const browserShot = picture("turn-shots", 3_500);
    const final = assistant("Signed in.", "turn-shots", true, 4_000);

    const transcript = [user, opening, looking, shot, browsing, browserShot, final];
    expect(planTranscript(transcript).hiddenIds.size).toBe(0);
    expect([...planTranscript(transcript, { quiet: true }).hiddenIds]).toEqual([shot.id, browserShot.id]);
  });

  it("does not fold talk from a different turn", () => {
    const older = assistant("Previous answer.", "turn-old");
    const progress = assistant("Checking.", "turn-new");
    const checking = step("Bash", "turn-new");
    const more = assistant("Still checking.", "turn-new");
    const reading = step("Read", "turn-new");
    const final = assistant("Done.", "turn-new", true);
    const items = groupTranscript([older, progress, checking, more, reading, final]);
    expect(items.map((item) => item.kind)).toEqual(["message", "message", "run", "turn", "message"]);
    expect(items[3]).toMatchObject({ kind: "turn", messages: [more] });
  });

  it("measures a resumed turn from its own first message rather than an older question", () => {
    const user: Message = { id: "u12", at: 1_000, role: "user", kind: "text", text: "sign in" };
    const asked = assistant("Fill in the form when you're ready.", "turn-ask-first", true, 2_000);
    const resumedLook = { ...step("mcp__computer__screenshot", "turn-resumed"), at: 600_000 };
    const resumed = assistant("Filling the email in.", "turn-resumed", false, 601_000);
    const typing = { ...step("mcp__computer__fill_secure_field", "turn-resumed"), at: 602_000 };
    const more = assistant("Now the password.", "turn-resumed", false, 603_000);
    const submitting = { ...step("mcp__computer__click", "turn-resumed"), at: 604_000 };
    const final = assistant("You're signed in.", "turn-resumed", true, 610_000);

    const plan = planTranscript([user, asked, resumedLook, resumed, typing, more, submitting, final]);
    expect(plan.byAnchorId.get(final.id)).toMatchObject({ label: "Worked for 10s", messages: [more] });
  });
});
