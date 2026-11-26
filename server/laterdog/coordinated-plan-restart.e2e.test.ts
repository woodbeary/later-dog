import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  launchVerificationServer,
  runControlLaterDog,
  verificationServerEnvironment,
} from "../../scripts/control-laterdog.ts";
import { handleToolCall, request } from "../../scripts/mcp-server.ts";
import { waitForExit } from "../testing/cleanup.ts";

const unfinished = [{ text: "Repair and verify the delegated room output", status: "in_progress" }];
const finished = [{ ...unfinished[0], status: "done" }];
const setPlan = (items: typeof unfinished) => ({ tool: "set_plan", arguments: { items } });
const result = "VERIFIED_RECOVERED_ROOM_RESULT";

it("resumes the same coordinated unfinished room plan after a real server restart", async () => {
  const environment = { ...process.env, FAKE_CLAUDE_VERSION: "2.1.316" };
  const fixture = await launchVerificationServer(
    environment,
    undefined,
    undefined,
    undefined,
    undefined,
    { scripted: true },
  );
  const { dataDir, url, logPath } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const oldReady = join(dataDir, "old-successor.ready");
  const oldGate = join(dataDir, "old-successor.gate");
  const recoveredReady = join(dataDir, "recovered-speaker.ready");
  const recoveredGate = join(dataDir, "recovered-speaker.gate");
  const evidencePath = `${logPath}.coordinated-plan-restart.json`;
  const rows = (name: string): any[] =>
    existsSync(join(dataDir, name)) ? JSON.parse(readFileSync(join(dataDir, name), "utf8")) : [];
  const turns = (): any[] =>
    existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const cli = (...args: string[]) =>
    runControlLaterDog(args, { env: { LATERDOG_URL: url } }) as Promise<any>;
  const api = (path: string) => request(path, {}, url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) =>
    handleToolCall(name, args, (path, options) => request(path, options, url)) as Promise<any>;
  let restarted: ChildProcess | undefined;
  let helper: any;
  let lead: any;
  let room: any;
  let original: any;
  let continuation: any;
  let stage = "starting";
  const checkpoints: unknown[] = [];
  const roomState = async () =>
    (await api("/api/bots?messages=0")).groups.find((group: any) => group.id === room?.id);
  try {
    helper = (await cli("new-bot", "--name", "Room helper")).bot;
    lead = (await cli("new-bot", "--name", "Lead")).bot;
    room = (await tool("create_channel", { name: "Restart repair room", member_ids: [helper.id] }))
      .channel;
    writeFileSync(
      planPath,
      JSON.stringify({
        [lead.id]: {
          steps: [
            {
              arguments: {
                group_id: room.id,
                bot_ids: [helper.id],
                message: "Repair and verify the delegated room output.",
              },
            },
          ],
          reply: "Room repair assigned.",
          resumeReply: "Recovered room result checked.",
        },
        [helper.id]: {
          turns: [
            {
              steps: [setPlan(unfinished)],
              reply: "Delegated room checkpoint saved.",
              stopReason: "max_tokens",
              isError: true,
            },
            {
              steps: [setPlan(unfinished)],
              readyFile: oldReady,
              gateFile: oldGate,
              reply: "The interrupted successor must not finish the assignment.",
            },
            {
              steps: [setPlan(finished)],
              readyFile: recoveredReady,
              gateFile: recoveredGate,
              expectContextIncludes: [
                "Repair and verify the delegated room output",
                "Delegated room checkpoint saved.",
              ],
              reply: result,
            },
          ],
        },
      }),
    );
    await cli(
      "send",
      "--bot",
      lead.id,
      "--task",
      lead.activeTaskId,
      "--text",
      "Ask the room helper to repair the output and check the finished result.",
    );
    await expect.poll(() => existsSync(oldReady), { timeout: 30_000 }).toBe(true);
    original = rows("room-handoffs.json").find(
      (node: any) => node.parentId && node.botId === helper.id && node.groupId === room.id,
    );
    expect(original).toMatchObject({ status: "running", threadId: room.activeTaskId });
    continuation = rows("plan-continuations.json").find(
      (entry: any) => entry.threadId === room.activeTaskId,
    );
    expect(continuation).toMatchObject({
      botId: helper.id,
      groupId: room.id,
      sourceId: original.id,
      coordinationId: original.id,
      recover: true,
      attempts: 1,
    });
    expect(await roomState()).toMatchObject({
      busyBotId: helper.id,
      work: { kind: "running" },
    });
    checkpoints.push({ stage: "successor-running", original, continuation });
    stage = "crashing-original-server";
    await waitForExit(fixture.child, { signal: "SIGKILL" });
    expect(fixture.child.signalCode).toBe("SIGKILL");
    writeFileSync(oldGate, "release only after the original server has exited");
    await expect
      .poll(() => turns().filter((turn: any) => turn.botId === helper.id).length, {
        timeout: 10_000,
      })
      .toBe(2);
    const log = openSync(logPath, "a", 0o600);
    try {
      restarted = spawn(
        process.execPath,
        ["--experimental-strip-types", fileURLToPath(new URL("../index.ts", import.meta.url))],
        {
          cwd: fileURLToPath(new URL("../..", import.meta.url)),
          env: verificationServerEnvironment(environment, dataDir, Number(new URL(url).port)),
          stdio: ["ignore", log, log],
        },
      );
    } finally {
      closeSync(log);
    }
    await expect
      .poll(
        async () => {
          try {
            const response = await fetch(`${url}/api/health`, {
              signal: AbortSignal.timeout(1_000),
            });
            return response.ok && (await response.json()).app === "laterdog";
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    checkpoints.push({
      stage: "restarted-server-ready",
      pid: restarted.pid,
      ledger: rows("plan-continuations.json"),
      nodes: rows("room-handoffs.json"),
      room: await roomState(),
    });
    expect(await roomState()).toMatchObject({ work: { kind: "running" } });
    stage = "awaiting-recovered-speaker";
    await expect.poll(() => existsSync(recoveredReady), { timeout: 30_000 }).toBe(true);
    expect(rows("room-handoffs.json").filter((node: any) => node.parentId)).toHaveLength(1);
    expect(rows("room-handoffs.json").find((node: any) => node.id === original.id)).toMatchObject({
      parentId: original.parentId,
      botId: helper.id,
      groupId: room.id,
      threadId: room.activeTaskId,
      status: "running",
    });
    expect(
      rows("plan-continuations.json").find((entry: any) => entry.threadId === room.activeTaskId),
    ).toMatchObject({
      botId: helper.id,
      groupId: room.id,
      sourceId: continuation.sourceId,
      coordinationId: original.id,
      attempts: continuation.attempts,
      recover: true,
    });
    expect(await roomState()).toMatchObject({ busyBotId: helper.id, work: { kind: "running" } });
    stage = "finishing-recovered-assignment";
    writeFileSync(recoveredGate, "finish the original delegated request");
    expect(
      (await cli("wait", "--bot", lead.id, "--task", lead.activeTaskId, "--timeout", "40")).status,
    ).toBe("settled");
    const helperTurns = turns().filter((turn: any) => turn.botId === helper.id);
    expect(helperTurns).toHaveLength(3);
    expect(helperTurns.every((turn: any) => turn.threadId === room.activeTaskId)).toBe(true);
    expect(
      JSON.stringify(turns().find((turn: any) => turn.botId === lead.id && turn.resumed)?.prompt),
    ).toContain(result);
    const children = rows("room-handoffs.json").filter((node: any) => node.parentId);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      id: original.id,
      parentId: original.parentId,
      botId: helper.id,
      groupId: room.id,
      threadId: room.activeTaskId,
      status: "completed",
      result,
    });
    const messages = (await api(`/api/threads/${room.activeTaskId}/messages?limit=200`)).messages;
    expect(messages.filter((message: any) => message.text === result)).toHaveLength(1);
    expect(messages.find((message: any) => message.text === result).from.botId).toBe(helper.id);
    expect(rows("plan-continuations.json")).toEqual([]);
    expect((await roomState()).work.kind).not.toBe("running");
    stage = "completed";
  } finally {
    writeFileSync(
      evidencePath,
      JSON.stringify(
        {
          stage,
          original,
          continuation,
          helperId: helper?.id,
          leadId: lead?.id,
          roomId: room?.id,
          checkpoints,
          recoveredReady: existsSync(recoveredReady),
          ledger: rows("plan-continuations.json"),
          nodes: rows("room-handoffs.json"),
          turns: turns(),
          room: room ? await roomState().catch((error: unknown) => String(error)) : undefined,
        },
        null,
        2,
      ),
    );
    writeFileSync(oldGate, "fixture cleanup");
    writeFileSync(recoveredGate, "fixture cleanup");
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
    console.info(JSON.stringify({ logPath, evidencePath, fixtureRemoved: !existsSync(dataDir) }));
  }
}, 85_000);
