import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";
import { handleToolCall, request } from "../../scripts/mcp-server.ts";
import { openSse } from "../testing/sse.ts";

const unfinished = [{ text: "Repair and verify the room output", status: "in_progress" }];
const finished = [{ ...unfinished[0], status: "done" }];
const setPlan = (items: typeof unfinished) => ({ tool: "set_plan", arguments: { items } });

async function fixture(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer(
    { ...process.env, FAKE_CLAUDE_VERSION: "2.1.316" },
    undefined,
    undefined,
    undefined,
    undefined,
    { scripted: true },
  );
  const stream = await openSse(`${session.info.url}/api/events`);
  const cli = (...args: string[]) =>
    runControlLaterDog(args, { env: { LATERDOG_URL: session.info.url } }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") =>
    request(
      path,
      body === undefined ? {} : { method, body: JSON.stringify(body) },
      session.info.url,
    ) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) =>
    handleToolCall(name, args, (path, options) =>
      request(path, options, session.info.url),
    ) as Promise<any>;
  const planPath = join(session.info.dataDir, "room-plan.json");
  const turns = (): any[] =>
    existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const ledger = (): any[] =>
    existsSync(join(session.info.dataDir, "plan-continuations.json"))
      ? JSON.parse(readFileSync(join(session.info.dataDir, "plan-continuations.json"), "utf8"))
      : [];
  try {
    const dog = (await cli("new-bot", "--name", "Room dog")).bot;
    const room = (await tool("create_channel", { name: "Repair room", member_ids: [dog.id] }))
      .channel;
    const messages = async () =>
      (await api(`/api/threads/${room.activeTaskId}/messages?limit=200`)).messages;
    const readRoom = async () =>
      (await api("/api/bots?messages=0")).groups.find((group: any) => group.id === room.id);
    const save = (plan: any) => writeFileSync(planPath, JSON.stringify(plan));
    const send = (text: string) => cli("send-channel", "--channel", room.id, "--text", text);
    const wait = () => cli("wait", "--channel", room.id, "--timeout", "30");
    await test({
      session,
      stream,
      cli,
      api,
      tool,
      planPath,
      turns,
      ledger,
      dog,
      room,
      messages,
      readRoom,
      save,
      send,
      wait,
    });
  } finally {
    stream.close();
    await session.close();
  }
}

it.each(["max_turns", "context_length_exceeded", "tool_call_limit"])(
  "continues a group's %s ending in the same operation and keeps its speaker working",
  (reason) =>
    fixture(async (f) => {
      const ready = join(f.session.info.dataDir, "continued.ready");
      const gate = join(f.session.info.dataDir, "continued.gate");
      f.save({
        [f.dog.id]: {
          turns: [
            {
              steps: [setPlan(unfinished)],
              reply: "Room checkpoint saved.",
              stopReason: reason,
              isError: true,
            },
            {
              steps: [setPlan(finished)],
              readyFile: ready,
              gateFile: gate,
              expectContextIncludes: [
                "Room checkpoint saved.",
                "Repair and verify the room output",
                "later.dog continuation",
              ],
              reply: "Room output verified.",
            },
          ],
        },
      });
      await f.send("@Room dog Repair the room output and verify it.");
      await expect.poll(() => existsSync(ready), { timeout: 30_000 }).toBe(true);
      expect(await f.readRoom()).toMatchObject({ busyBotId: f.dog.id, work: { kind: "running" } });
      const limitAt = f.stream.frames.findIndex(
        (frame: any) =>
          frame.kind === "runtime" &&
          frame.event?.type === "turn.completed" &&
          frame.event.stopReason === reason,
      );
      expect(limitAt).toBeGreaterThanOrEqual(0);
      expect(
        f.stream.frames
          .slice(limitAt)
          .filter((frame: any) => frame.kind === "group" && frame.group?.id === f.room.id)
          .every((frame: any) => frame.group.work.kind === "running"),
      ).toBe(true);
      writeFileSync(gate, "finish the same room request");
      expect((await f.wait()).status).toBe("settled");
      const turns = f.turns().filter((turn: any) => turn.botId === f.dog.id);
      expect(turns).toHaveLength(2);
      expect(turns.every((turn: any) => turn.threadId === f.room.activeTaskId)).toBe(true);
      const messages = await f.messages();
      expect(messages.filter((message: any) => message.role === "user")).toHaveLength(1);
      expect(
        messages.find((message: any) => message.text === "Room output verified.").from.botId,
      ).toBe(f.dog.id);
      expect((await f.readRoom()).work.kind).not.toBe("running");
      expect(f.ledger()).toEqual([]);
    }),
  75_000,
);

it(
  "keeps a delegated room assignment open until its limited speaker verifies the result",
  () =>
    fixture(async (f) => {
      const lead = (await f.cli("new-bot", "--name", "Lead")).bot;
      f.save({
        [lead.id]: {
          steps: [
            {
              arguments: {
                group_id: f.room.id,
                bot_ids: [f.dog.id],
                message: "Repair and verify the room output.",
              },
            },
          ],
          reply: "Room work assigned.",
          resumeReply: "Room result checked.",
        },
        [f.dog.id]: {
          turns: [
            {
              steps: [setPlan(unfinished)],
              reply: "Delegated room checkpoint.",
              stopReason: "max_tokens",
              isError: true,
            },
            { steps: [setPlan(finished)], reply: "Verified delegated room output." },
          ],
        },
      });
      await f.cli(
        "send",
        "--bot",
        lead.id,
        "--task",
        lead.activeTaskId,
        "--text",
        "Ask the room dog to repair and verify the output.",
      );
      expect(
        (await f.cli("wait", "--bot", lead.id, "--task", lead.activeTaskId, "--timeout", "40"))
          .status,
      ).toBe("settled");
      const targetTurns = f.turns().filter((turn: any) => turn.botId === f.dog.id);
      expect(targetTurns).toHaveLength(2);
      expect(targetTurns.every((turn: any) => turn.threadId === f.room.activeTaskId)).toBe(true);
      const resumed = f.turns().find((turn: any) => turn.botId === lead.id && turn.resumed);
      expect(JSON.stringify(resumed?.prompt)).toContain("Verified delegated room output.");
      const nodes = JSON.parse(
        readFileSync(join(f.session.info.dataDir, "room-handoffs.json"), "utf8"),
      );
      expect(nodes.filter((node: any) => node.parentId && node.botId === f.dog.id)).toHaveLength(1);
      expect(nodes.find((node: any) => node.parentId && node.botId === f.dog.id)).toMatchObject({
        status: "completed",
        groupId: f.room.id,
        result: "Verified delegated room output.",
      });
    }),
  85_000,
);

it(
  "does not continue a limited group turn while a real device approval card waits",
  () =>
    fixture(async (f) => {
      f.save({
        [f.dog.id]: {
          turns: [
            {
              steps: [
                setPlan(unfinished),
                {
                  tool: "request_device_approval",
                  arguments: {
                    service: "Fixture sign-in",
                    url: "https://device.example.test/verify",
                    code: "FIXTURE",
                  },
                },
              ],
              reply: "The sign-in card needs you.",
              stopReason: "max_turns",
              isError: true,
            },
          ],
        },
      });
      await f.send("@Room dog Prepare the fixture sign-in.");
      await expect
        .poll(() => f.turns().filter((turn: any) => turn.botId === f.dog.id).length, {
          timeout: 25_000,
        })
        .toBe(1);
      await expect
        .poll(async () => (await f.readRoom()).busyBotId, { timeout: 15_000 })
        .toBeFalsy();
      expect(
        (await f.messages()).some(
          (message: any) => message.card?.deviceApproval?.status === "waiting",
        ),
      ).toBe(true);
      expect(f.ledger().some((entry: any) => entry.pending)).toBe(false);
      expect(f.turns().filter((turn: any) => turn.botId === f.dog.id)).toHaveLength(1);
    }),
  60_000,
);

it(
  "respects Stop during an unfinished native room turn and never starts its continuation",
  () =>
    fixture(async (f) => {
      const ready = join(f.session.info.dataDir, "first.ready");
      const gate = join(f.session.info.dataDir, "first.gate");
      const second = join(f.session.info.dataDir, "second.ready");
      f.save({
        [f.dog.id]: {
          turns: [
            {
              steps: [setPlan(unfinished)],
              readyFile: ready,
              gateFile: gate,
              reply: "Checkpoint.",
              stopReason: "max_turns",
              isError: true,
            },
            { readyFile: second, reply: "This continuation must not run." },
          ],
        },
      });
      await f.send("@Room dog Repair the output.");
      await expect.poll(() => existsSync(ready), { timeout: 25_000 }).toBe(true);
      await f.cli("interrupt", "--channel", f.room.id);
      writeFileSync(gate, "release the stopped fixture");
      await expect
        .poll(async () => (await f.readRoom()).busyBotId, { timeout: 15_000 })
        .toBeFalsy();
      expect(existsSync(second)).toBe(false);
      expect(f.ledger().some((entry: any) => entry.pending)).toBe(false);
      expect(
        (await f.messages()).some(
          (message: any) => message.text === "This continuation must not run.",
        ),
      ).toBe(false);
    }),
  60_000,
);

it(
  "gives queued human room work precedence over automatic continuation",
  () =>
    fixture(async (f) => {
      const ready = join(f.session.info.dataDir, "first.ready");
      const gate = join(f.session.info.dataDir, "first.gate");
      f.save({
        [f.dog.id]: {
          turns: [
            {
              steps: [setPlan(unfinished)],
              readyFile: ready,
              gateFile: gate,
              reply: "Old checkpoint.",
              stopReason: "context_length_exceeded",
              isError: true,
            },
            {
              steps: [setPlan(finished)],
              reply: "New human request handled.",
              expectContextIncludes: ["NEW_ROOM_REQUEST"],
            },
          ],
        },
      });
      await f.send("@Room dog Begin the old room request.");
      await expect.poll(() => existsSync(ready), { timeout: 25_000 }).toBe(true);
      await f.send("@Room dog NEW_ROOM_REQUEST");
      writeFileSync(gate, "finish the previous native turn");
      expect((await f.wait()).status).toBe("settled");
      const turns = f.turns().filter((turn: any) => turn.botId === f.dog.id);
      expect(turns).toHaveLength(2);
      expect(JSON.stringify(turns[1].prompt)).not.toContain("later.dog continuation");
      expect((await f.messages()).filter((message: any) => message.role === "user")).toHaveLength(
        2,
      );
      expect(f.ledger()).toEqual([]);
    }),
  75_000,
);

it(
  "continues a room step through repeated limits until its result is verified",
  () =>
    fixture(async (f) => {
      const limited = Array.from({ length: 6 }, (_, index) => ({
        steps: [setPlan(unfinished)],
        reply: `Unfinished room checkpoint ${index}.`,
        stopReason: "tool_call_limit",
        isError: true,
      }));
      f.save({
        [f.dog.id]: {
          turns: [
            ...limited,
            {
              steps: [setPlan(finished)],
              reply: "The room output is verified.",
              expectContextIncludes: [
                "Repair the output without repeating completed work.",
                "Repair and verify the room output",
                "later.dog continuation",
              ],
            },
          ],
        },
      });
      await f.send("@Room dog Repair the output without repeating completed work.");
      expect((await f.wait()).status).toBe("settled");
      expect(f.turns().filter((turn: any) => turn.botId === f.dog.id)).toHaveLength(7);
      const messages = await f.messages();
      expect(messages.filter((message: any) => message.role === "user")).toHaveLength(1);
      expect(
        messages.find((message: any) => message.text === "The room output is verified.").from.botId,
      ).toBe(f.dog.id);
      expect(
        messages.some((message: any) =>
          message.tool?.name.includes("Automatic continuation stopped"),
        ),
      ).toBe(false);
      expect((await f.readRoom()).work.kind).not.toBe("running");
      expect(f.ledger()).toEqual([]);
    }),
  90_000,
);
