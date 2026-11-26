import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlLaterDog } from "../../scripts/control-laterdog.ts";

const SETTLED_LINE = "Your downstream room requests have settled";

async function twoDogs(test: (f: Awaited<ReturnType<typeof setUp>>) => Promise<void>) {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, {
    scripted: true,
  });
  try {
    await test(await setUp(fixture));
  } finally {
    await fixture.close();
  }
}

async function setUp(fixture: Awaited<ReturnType<typeof launchVerificationServer>>) {
  const { url, dataDir } = fixture.info;
  const planPath = join(dataDir, "room-plan.json");
  const gate = (name: string) => join(dataDir, `${name}.gate`);
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json()) as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    return result;
  };
  const cli = (...args: string[]) => runControlLaterDog([...args, "--url", url]) as Promise<any>;
  const chief = (await cli("new-bot", "--name", "Clive", "--section", "Operations")).bot;
  await api("PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
  const lead = (await cli("new-bot", "--name", "Lena", "--section", "Operations")).bot;
  const ask = {
    includes: "Have Lena check the report",
    reply: "Asked Lena.",
    steps: [
      {
        tool: "coordinate_bots",
        arguments: {
          bot_ids: [lead.id],
          request_key: "check-report",
          message: "Check the fixture report and say what you found.",
        },
      },
    ],
  };
  const tell = {
    includes: "Tell Lena to ship the report",
    reply: "Told Lena; no reply needed.",
    steps: [
      {
        tool: "coordinate_bots",
        arguments: {
          bot_ids: [lead.id],
          request_key: "ship-report",
          message: "Ship the fixture report. No need to reply.",
          reply: "none",
        },
      },
    ],
  };
  writeFileSync(
    planPath,
    JSON.stringify({
      [lead.id]: { reply: "LENA_RESULT_BACK", gateFile: gate("lena") },
      [chief.id]: {
        when: [
          { includes: SETTLED_LINE, reply: "Lena's check came back." },
          { includes: "Meanwhile, tidy the notes", reply: "Tidied.", gateFile: gate("meanwhile") },
          { includes: "Anything else for today", reply: "Nothing else.", gateFile: gate("again") },
          ask,
          tell,
        ],
      },
    }),
  );
  const turns = (): any[] =>
    existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const task = async (threadId: string) =>
    (await api("GET", "/api/bots")).bots
      .find((bot: any) => bot.id === chief.id)
      .tasks.find((stored: any) => stored.threadId === threadId);
  const messages = async (threadId: string) =>
    (await api("GET", `/api/threads/${threadId}/messages?limit=100`)).messages as any[];
  const wait = async (threadId: string, seconds: number) =>
    (await cli("wait", "--bot", chief.id, "--task", threadId, "--timeout", String(seconds)))
      .status as string;
  const waitsOnLena = async (threadId: string, text: string) => {
    await cli("send", "--bot", chief.id, "--task", threadId, "--text", text);
    await expect
      .poll(
        async () => {
          const now = await task(threadId);
          return Boolean(
            now && !now.busy && now.waitingForTeammates && now.work?.kind === "waiting-on-dog",
          );
        },
        { timeout: 25_000 },
      )
      .toBe(true);
  };
  const lenaWork = async () =>
    (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === lead.id)?.work?.kind;
  return {
    api,
    cli,
    chief,
    lead,
    gate,
    turns,
    task,
    messages,
    wait,
    lenaWork,
    asked: (threadId: string) => waitsOnLena(threadId, "Have Lena check the report."),
    told: (threadId: string) =>
      cli("send", "--bot", chief.id, "--task", threadId, "--text", "Tell Lena to ship the report."),
    open: (name: string) => writeFileSync(gate(name), "go"),
  };
}

it(
  "does not call a dog settled while its teammate's result is back but not yet handed to it",
  () =>
    twoDogs(async (f) => {
      await f.api("PUT", "/api/config", { threads: { maxConcurrentPerBot: 1 } });
      const first = f.chief.activeTaskId;
      await f.asked(first);

      const other = (await f.api("POST", `/api/bots/${f.chief.id}/tasks`, { title: "Notes" }, 201))
        .task.threadId;
      await f.cli(
        "send",
        "--bot",
        f.chief.id,
        "--task",
        other,
        "--text",
        "Meanwhile, tidy the notes.",
      );
      await expect.poll(async () => (await f.task(other))?.busy, { timeout: 15_000 }).toBe(true);

      f.open("lena");
      await expect
        .poll(
          async () =>
            (await f.messages(first)).some(
              (message) =>
                message.roomRequest?.phase === "result" && message.from?.botId === f.lead.id,
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
      const handedBackLater = await f.task(first);
      expect(handedBackLater).toMatchObject({ busy: false, waitingForTeammates: true });
      expect(await f.wait(first, 2)).toBe("timed-out");
      expect(
        f.turns().filter((turn) => turn.botId === f.chief.id && turn.threadId === first),
      ).toHaveLength(1);

      f.open("meanwhile");
      expect(await f.wait(first, 30)).toBe("settled");
      const back = f
        .turns()
        .filter((turn) => turn.botId === f.chief.id && turn.threadId === first)
        .at(-1);
      expect(back.resumed).toBe(true);
      expect(JSON.stringify(back.prompt)).toContain("LENA_RESULT_BACK");
      expect(await f.task(first)).toMatchObject({ busy: false, waitingForTeammates: false });
    }),
  120_000,
);

it(
  "settles a dog the person stopped while its teammate still works, and does not show it waiting on that teammate",
  () =>
    twoDogs(async (f) => {
      const first = f.chief.activeTaskId;
      await f.asked(first);
      await expect.poll(f.lenaWork, { timeout: 15_000 }).toBe("running");

      await f.api("POST", `/api/bots/${f.chief.id}/interrupt`, { threadId: first });
      expect(await f.wait(first, 15)).toBe("settled");
      const stopped = await f.task(first);
      expect(stopped.waitingForTeammates).toBe(false);
      expect(stopped).not.toHaveProperty("waitingOn");
      expect(stopped.work?.kind).not.toBe("waiting-on-dog");
      expect(await f.lenaWork()).toBe("running");

      f.open("lena");
      await expect
        .poll(
          async () =>
            (await f.api("GET", "/api/bots")).bots.find((bot: any) => bot.id === f.lead.id)?.busy,
          { timeout: 20_000 },
        )
        .toBe(false);
    }),
  120_000,
);

it(
  "settles after saving passive context, leaves the recipient idle and accepts the person's next request",
  () =>
    twoDogs(async (f) => {
      await f.api("PATCH", `/api/bots/${f.chief.id}`, { parkDirectMessages: true });
      const first = f.chief.activeTaskId;
      await f.told(first);
      expect(await f.wait(first, 20)).toBe("settled");
      expect(await f.task(first)).toMatchObject({
        busy: false,
        waitingForTeammates: false,
        work: { kind: "idle" },
      });
      expect(await f.lenaWork()).toBe("idle");
      expect(f.turns().filter((turn) => turn.botId === f.lead.id)).toEqual([]);

      await f.cli(
        "send",
        "--bot",
        f.chief.id,
        "--task",
        first,
        "--text",
        "Anything else for today?",
      );
      await expect.poll(async () => (await f.task(first))?.busy, { timeout: 10_000 }).toBe(true);
      expect(f.turns().filter((turn) => turn.botId === f.lead.id)).toEqual([]);
      f.open("again");
      expect(await f.wait(first, 20)).toBe("settled");
      expect(await f.task(first)).toMatchObject({
        busy: false,
        waitingForTeammates: false,
        work: { kind: "idle" },
      });
      const chiefTurns = f
        .turns()
        .filter((turn) => turn.botId === f.chief.id && turn.threadId === first);
      expect(chiefTurns).toHaveLength(2);
      expect(chiefTurns.some((turn) => turn.resumed)).toBe(false);
    }),
  120_000,
);

it(
  "does not call the sender working for a passive note while the recipient finishes independent work",
  () =>
    twoDogs(async (f) => {
      await f.cli(
        "send",
        "--bot",
        f.lead.id,
        "--task",
        f.lead.activeTaskId,
        "--text",
        "Finish the existing report.",
      );
      await expect.poll(f.lenaWork, { timeout: 15_000 }).toBe("running");
      const first = f.chief.activeTaskId;
      await f.told(first);
      expect(await f.wait(first, 20)).toBe("settled");
      expect(await f.task(first)).toMatchObject({
        busy: false,
        waitingForTeammates: false,
        work: { kind: "idle" },
      });
      expect(await f.lenaWork()).toBe("running");
      await f.api("POST", `/api/bots/${f.chief.id}/interrupt`, { threadId: first });
      expect(await f.lenaWork()).toBe("running");
      f.open("lena");
      await expect.poll(f.lenaWork, { timeout: 20_000 }).toBe("idle");
      expect(f.turns().filter((turn) => turn.botId === f.lead.id)).toHaveLength(1);
      expect(f.turns().filter((turn) => turn.botId === f.chief.id)).toHaveLength(1);
    }),
  120_000,
);
