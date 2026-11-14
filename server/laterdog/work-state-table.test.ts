import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkKind } from "../../shared/work-state.ts";
import { RoomHandoffs, type RoomHandoffHooks } from "../room-handoffs.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { handoffRunningIn, handoffWait, olderWorkFields } from "./chat-work.ts";
import { ComputerJobs } from "./computer-jobs.ts";
import { HelperBoard } from "./helper-board.ts";
import { waitingOn } from "./waiting-on.ts";
import { workState } from "./work-state.ts";

const DIMENSIONS = ["turn", "helpers", "job", "awaits", "sentNoReply", "doingHandoff", "needsYou", "usage", "restart"] as const;
type Dimension = typeof DIMENSIONS[number];
type Row = Partial<Record<Dimension | "handedBack" | "askerStopped", boolean>>;

const CHAT = "chief-chat";
const NAMES: Record<string, string> = { scout: "Scout", patch: "Patch", boss: "Boss", chief: "Chief" };
const dir = mkdtempSync(join(tmpdir(), "work-state-table-"));
afterAll(() => removeTempDir(dir));
let made = 0;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const handoffsFor = new Map<string, Promise<RoomHandoffs>>();
const jobsFor = new Map<string, ComputerJobs>();

async function handoffRecord(row: Row): Promise<RoomHandoffs> {
  const at = join(dir, String(made += 1));
  const hooks: RoomHandoffHooks = {
    validate: () => undefined,
    busy: (node) => Boolean(row.handedBack) && node.botId === "chief",
    run: (node) => row.handedBack && node.botId === "scout" ? Promise.resolve({ ok: true, text: "Totals match." }) : new Promise(() => {}),
    report: () => {},
    changed: () => {},
  };
  const handoffs = new RoomHandoffs(`${at}-handoffs.json`, hooks);
  const chief = { botId: "chief", threadId: CHAT };
  if (row.awaits || row.handedBack || row.askerStopped) handoffs.enqueue(chief, "turn", undefined, { botId: "scout", threadId: "scout-chat" }, "check", "Check the totals");
  if (row.sentNoReply) handoffs.enqueue(chief, "turn", undefined, { botId: "patch", threadId: "patch-chat" }, "fyi", "Ship it", false, false, "", undefined, undefined, undefined, undefined, false, "none");
  if (row.awaits || row.sentNoReply || row.handedBack || row.askerStopped) handoffs.sourceSettled("turn", true);
  if (row.doingHandoff) handoffs.enqueue({ botId: "boss", threadId: "boss-chat" }, "boss-turn", undefined, chief, "audit", "Audit the books");
  handoffs.tick(); await flush();
  if (row.handedBack) for (let round = 0; round < 2; round += 1) { handoffs.tick(); await flush(); }
  if (row.askerStopped) handoffs.stopAwaitingDirect(CHAT, "person");
  return handoffs;
}

function jobLedger(row: Row): ComputerJobs {
  const ledger = join(dir, `${made += 1}-jobs.json`);
  const jobs = new ComputerJobs(ledger);
  if (row.job) jobs.started({ id: "abcd1234", botId: "chief", threadId: CHAT, command: "pnpm test", startedAt: Date.now() });
  return row.restart ? new ComputerJobs(ledger) : jobs;
}

async function project(row: Row) {
  const handoffKey = `${row.awaits}|${row.sentNoReply}|${row.doingHandoff}|${row.handedBack}|${row.askerStopped}`;
  if (!handoffsFor.has(handoffKey)) handoffsFor.set(handoffKey, handoffRecord(row));
  const handoffs = await handoffsFor.get(handoffKey)!;
  const jobKey = `${row.job}|${row.restart}`;
  if (!jobsFor.has(jobKey)) jobsFor.set(jobKey, jobLedger(row));
  const jobs = jobsFor.get(jobKey)!;
  let board = new HelperBoard();
  if (row.helpers) board.update(CHAT, { id: "h1", kind: "agent", label: "Check", state: "running", background: true, startedAt: 0 });
  if (row.restart) board = new HelperBoard();

  const busy = Boolean(row.turn);
  const handoff = handoffWait(busy, handoffs.activeDirect(CHAT), () => waitingOn(handoffs.outstandingDirect(CHAT), (botId) => NAMES[botId]));
  const work = workState({
    busy,
    helpers: busy ? 0 : board.runningCount(CHAT),
    computerJobs: busy ? 0 : jobs.count(CHAT),
    handoffRunning: handoffRunningIn(CHAT, handoffs.nodes.values()),
    ...(handoff.waitingOn ? { waitingOn: handoff.waitingOn } : {}),
    ...(row.needsYou ? { needsYou: { what: "Allow sending?" } } : {}),
    ...(row.usage ? { usageHold: { account: "Work" } } : {}),
  });
  const activity = row.needsYou ? "waiting-on-you" as const : busy ? "working" as const : "idle" as const;
  const alive = { helpers: busy ? 0 : board.runningCount(CHAT), computerJobs: busy ? 0 : jobs.count(CHAT) };
  return { work, older: olderWorkFields(work, busy, activity, handoff, alive) };
}

const TABLE: Array<[string, Row, WorkKind]> = [
  ["nothing at all", {}, "idle"],
  ["a turn running", { turn: true }, "running"],
  ["helpers left working after the turn", { helpers: true }, "running"],
  ["a computer job that outlived its turn", { job: true }, "running"],
  ["a computer job alive across a restart", { job: true, restart: true }, "running"],
  ["helpers when the home restarts end with their engine", { helpers: true, restart: true }, "idle"],
  ["helpers and a job across a restart: the job survives", { helpers: true, job: true, restart: true }, "running"],
  ["waiting for a teammate's reply", { awaits: true }, "waiting-on-dog"],
  ["waiting for a reply while its own turn still runs", { awaits: true, turn: true }, "running"],
  ["a reply awaited while a computer job runs", { awaits: true, job: true }, "waiting-on-dog"],
  ["sent work with no reply wanted", { sentNoReply: true }, "idle"],
  ["sent work with no reply wanted, turn still running", { sentNoReply: true, turn: true }, "running"],
  ["sent work with no reply wanted, a job still running", { sentNoReply: true, job: true }, "running"],
  ["doing a handoff for another dog", { doingHandoff: true }, "running"],
  ["doing a handoff and waiting on its own teammate", { doingHandoff: true, awaits: true }, "waiting-on-dog"],
  ["a question for the person outranks everything", { needsYou: true, turn: true, job: true, awaits: true, usage: true }, "needs-you"],
  ["a question with a job still running", { needsYou: true, job: true }, "needs-you"],
  ["a usage hold outranks a reply awaited", { usage: true, awaits: true }, "waiting-for-usage"],
  ["a usage hold with a job still running", { usage: true, job: true }, "waiting-for-usage"],
  ["a usage hold across a restart", { usage: true, restart: true }, "waiting-for-usage"],
  ["a reply awaited across a restart", { awaits: true, restart: true }, "waiting-on-dog"],
  ["a teammate's reply is back but not yet handed to the dog", { handedBack: true }, "idle"],
  ["the person stopped the dog while its teammate still works", { askerStopped: true }, "idle"],
];

const HANDOFF: Array<[string, Row, boolean]> = [
  ["waiting for a teammate's reply", { awaits: true }, true],
  ["a teammate's reply is back but not yet handed to the dog", { handedBack: true }, true],
  ["the turn that takes the reply runs", { handedBack: true, turn: true }, false],
  ["the person stopped the dog while its teammate still works", { askerStopped: true }, false],
  ["sent work with no reply wanted", { sentNoReply: true }, false],
  ["nothing sent", {}, false],
];

describe("one work state per chat, from every fact the home knows", () => {
  it.each(TABLE)("%s", async (_name, row, kind) => {
    expect((await project(row)).work.kind).toBe(kind);
  });

  it.each(HANDOFF)("the handoff says whether the dog still waits for its teammates: %s", async (_name, row, waiting) => {
    const { work, older } = await project(row);
    expect(older.waitingForTeammates).toBe(waiting);
    expect(Boolean(older.waitingOn)).toBe(waiting);
    if (work.kind === "waiting-on-dog") expect(older.waitingForTeammates).toBe(true);
  });

  const every = Array.from({ length: 2 ** DIMENSIONS.length }, (_, mask) =>
    Object.fromEntries(DIMENSIONS.map((dimension, bit) => [dimension, Boolean(mask & (1 << bit))])) as Required<Row>);

  it("holds across all combinations: nothing alive is idle only when nothing runs, and older fields say the same", async () => {
    for (const row of every) {
      const { work, older } = await project(row);
      const alive = row.turn || row.job || row.doingHandoff || (row.helpers && !row.restart);
      const label = JSON.stringify(row);
      if (alive) expect(work.kind, label).not.toBe("idle");
      if (work.kind === "running") expect(alive, label).toBe(true);
      if (work.kind === "waiting-on-dog") expect(row.awaits && !row.turn, label).toBe(true);
      if (row.sentNoReply && !row.awaits) expect(work.kind, label).not.toBe("waiting-on-dog");
      expect(older.waitingForTeammates, label).toBe(Boolean(!row.turn && (row.awaits || row.doingHandoff)));
      if (work.kind === "waiting-on-dog") expect(older.waitingForTeammates && older.waitingOn!.length > 0, label).toBe(true);
      expect(Boolean(older.waitingOn?.length), label).toBe(Boolean(row.awaits && !row.turn));
      expect(older.activity === "waiting-on-you", label).toBe(work.kind === "needs-you");
      expect(Boolean(older.helpersWorking), label).toBe(Boolean(!row.turn && (row.job || (row.helpers && !row.restart))));
    }
  }, 60_000);
});
