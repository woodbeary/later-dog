import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlLaterDog } from "../scripts/control-laterdog.ts";
import { RoutineManager, type RoutineRun } from "./routines.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("recovers queued/due work without resurrecting an interrupted routine after restart", async () => {
  const fixture = await launchVerificationServer();
  const { url, dataDir, logPath } = fixture.info;
  let restarted: ChildProcess | undefined;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(2_000),
    });
    expect(response.ok, `${method} ${path}`).toBe(true);
    return await response.json() as any;
  };
  try {
    const scheduledBot = (await api("POST", "/api/bots", { name: "Restart scheduled" })).bot;
    const cronBot = (await api("POST", "/api/bots", { name: "Restart cron" })).bot;
    const queuedBot = (await api("POST", "/api/bots", { name: "Restart queued" })).bot;
    const interruptedBot = (await api("POST", "/api/bots", { name: "Interrupted routine" })).bot;
    const orphanPeer = (await api("POST", "/api/bots", { name: "Orphan peer" })).bot;
    const reusedBot = (await api("POST", "/api/bots", { name: "Reused routine conversation" })).bot;
    const reusedPeer = (await api("POST", "/api/bots", { name: "New user handoff peer" })).bot;
    await api("POST", `/api/bots/${reusedBot.id}/messages`, { text: "A later user request that owns its own pending handoff." });
    await runControlLaterDog(["wait", "--bot", reusedBot.id, "--task", reusedBot.threadId, "--url", url]);
    const scheduled = (await api("POST", "/api/routines", {
      name: "Due at startup", prompt: "Report after the restart", botId: scheduledBot.id,
      schedule: { type: "once", at: Date.now() + 60 * 60_000 },
    })).routine;
    const cron = (await api("POST", "/api/routines", {
      name: "Cron due at startup", prompt: "Recover one cron run, not every missed minute", botId: cronBot.id,
      enabled: false,
      schedule: { type: "cron", expression: "* * * * *", timeZone: "UTC" },
    })).routine;
    const manual = (await api("POST", "/api/routines", {
      name: "Queued before restart", prompt: "Finish the queued request", botId: queuedBot.id,
      enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] },
    })).routine;
    const interrupted = (await api("POST", "/api/routines", {
      name: "Interrupted peer work", prompt: "Do not resume after recovery", botId: interruptedBot.id,
      enabled: false, schedule: { type: "daily", time: "09:00", weekdays: [1] },
    })).routine;
    await waitForExit(fixture.child, { signal: "SIGTERM" });

    const file = join(dataDir, "routines.json");
    const scheduler = new RoutineManager({
      file, botState: () => "busy", conversationFor: () => null, startTurn: async () => {},
    });
    const queued = scheduler.runNow(manual.id)!;
    await scheduler.tick();
    expect(scheduler.listRuns().find((run) => run.id === queued.id)?.status).toBe("queued");
    const disk = JSON.parse(readFileSync(file, "utf8"));
    const dueAt = Date.now() - 1_000;
    const cronDueAt = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
    disk.routines.find((routine: { id: string }) => routine.id === cron.id).enabled = true;
    disk.routines.find((routine: { id: string }) => routine.id === cron.id).nextRunAt = cronDueAt;
    disk.routines.find((routine: { id: string }) => routine.id === scheduled.id).schedule.at = dueAt;
    disk.routines.find((routine: { id: string }) => routine.id === scheduled.id).nextRunAt = dueAt;
    disk.runs.push({
      id: "interrupted-run", routineId: interrupted.id, routineName: interrupted.name,
      prompt: interrupted.prompt, target: "bot", botId: interruptedBot.id, runOn: "dog",
      scheduledFor: dueAt, createdAt: dueAt, startedAt: dueAt, manual: true,
      status: "waiting", threadId: interruptedBot.threadId,
    });
    disk.runs.push({
      id: "historical-run", routineId: "historical-routine", routineName: "Previously completed work",
      prompt: "Already finished", target: "bot", botId: reusedBot.id, runOn: "dog",
      scheduledFor: dueAt - 60_000, createdAt: dueAt - 60_000, startedAt: dueAt - 60_000,
      finishedAt: dueAt - 60_000, manual: true, status: "completed", threadId: reusedBot.threadId,
    });
    writeFileSync(file, JSON.stringify(disk));
    const handoff = (id: string, owner: { id: string; threadId: string }, peer: { id: string; threadId: string }, text: string, routineRunId?: string) => [
      { id: `${id}-root`, rootId: `${id}-root`, threadId: owner.threadId, botId: owner.id, key: "root", text: "Ask a teammate", createdAt: dueAt, status: "waiting", executions: 1, ...(routineRunId ? { routineRunId } : {}) },
      { id, rootId: `${id}-root`, parentId: `${id}-root`, threadId: peer.threadId, botId: peer.id, key: id, text, createdAt: dueAt, status: "queued" },
    ];
    const botsFile = join(dataDir, "bots.json");
    const savedBots = JSON.parse(readFileSync(botsFile, "utf8"));
    for (const saved of savedBots.filter((b: { id: string }) => [orphanPeer.id, reusedPeer.id].includes(b.id))) {
      saved.approvalMode = "full"; saved.autoApprove = false;
      for (const task of saved.tasks ?? []) { task.approvalMode = "full"; task.autoApprove = false; }
    }
    writeFileSync(botsFile, JSON.stringify(savedBots));
    writeFileSync(join(dataDir, "room-handoffs.json"), JSON.stringify([
      ...handoff("orphan-handoff", interruptedBot, orphanPeer, "This stopped routine must not launch peer work", "interrupted-run"),
      ...handoff("later-user-handoff", reusedBot, reusedPeer, "This later user request must survive the restart"),
    ]));

    const env: NodeJS.ProcessEnv = {};
    for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "TZ"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    Object.assign(env, {
      HOME: dataDir, USERPROFILE: dataDir, LATERDOG_HOME: dataDir,
      APPDATA: join(dataDir, "AppData", "Roaming"), LOCALAPPDATA: join(dataDir, "AppData", "Local"),
      XDG_CONFIG_HOME: join(dataDir, ".config"), XDG_CACHE_HOME: join(dataDir, ".cache"),
      XDG_DATA_HOME: join(dataDir, ".local", "share"), HERMES_HOME: join(dataDir, ".hermes"),
      TEMP: join(dataDir, "tmp"), TMP: join(dataDir, "tmp"), TMPDIR: join(dataDir, "tmp"),
      LATERDOG_SERVER_PORT: new URL(url).port, LATERDOG_WEBHOOK_PORT: String(Number(new URL(url).port) + 1),
      PATH: dirname(process.execPath), FAKE_CLAUDE_MODE: "happy",
    });
    const log = openSync(logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), env, stdio: ["ignore", log, log],
    });
    closeSync(log);
    const deadline = Date.now() + 20_000;
    let runs: RoutineRun[] = [];
    while (Date.now() < deadline) {
      expect(restarted.exitCode, `restarted server exited; see ${logPath}`).toBeNull();
      try {
        runs = (await api("GET", "/api/routines")).runs;
        if ([scheduled.id, manual.id, cron.id].every((id) => runs.some((run) => run.routineId === id && run.status === "completed"))) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(runs, readFileSync(logPath, "utf8").slice(-4_000)).toEqual(expect.arrayContaining([
      expect.objectContaining({ routineId: scheduled.id, scheduledFor: dueAt, status: "completed" }),
      expect.objectContaining({ routineId: cron.id, scheduledFor: cronDueAt, status: "completed" }),
      expect.objectContaining({ id: queued.id, routineId: manual.id, status: "completed" }),
      expect.objectContaining({ id: "interrupted-run", status: "failed", error: expect.stringContaining("restarted") }),
    ]));
    expect(runs.filter(run => run.routineId === cron.id && run.scheduledFor < Math.floor(Date.now() / 60_000) * 60_000)).toHaveLength(1);
    const restoredCron = (await api("GET", "/api/routines")).routines.find((routine: { id: string }) => routine.id === cron.id);
    expect(restoredCron.schedule).toEqual(cron.schedule);
    expect(restoredCron.nextRunAt).toBeGreaterThan(Date.now());
    const peerMessages = async (peerId: string) =>
      ((await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === peerId).messages as Array<{ text?: string }>);
    await expect.poll(async () => (await peerMessages(reusedPeer.id)).some((message) =>
      message.text?.includes("This later user request must survive the restart")), { timeout: 15_000 }).toBe(true);
    const handoffs = () => JSON.parse(readFileSync(join(dataDir, "room-handoffs.json"), "utf8")) as Array<{ id: string; status: string; endedBy?: string }>;
    await expect.poll(() => handoffs().find((node) => node.id === "later-user-handoff")?.status, { timeout: 10_000 }).toBe("completed");
    expect(handoffs().filter((node) => node.id.startsWith("orphan-handoff"))).toEqual([
      expect.objectContaining({ id: "orphan-handoff-root", status: "failed", endedBy: "restart" }),
      expect.objectContaining({ id: "orphan-handoff", status: "failed", endedBy: "restart" }),
    ]);
    expect((await peerMessages(orphanPeer.id)).some((message) => message.text?.includes("This stopped routine must not launch peer work"))).toBe(false);
    expect(Boolean((await api("GET", "/api/bots")).bots.find((bot: { id: string }) => bot.id === orphanPeer.id).busy)).toBe(false);
    const scheduledRun = runs.find((run) => run.routineId === scheduled.id)!;
    const wait = await runControlLaterDog(["wait", "--bot", scheduledBot.id, "--task", scheduledRun.threadId!, "--url", url]);
    const messages = await runControlLaterDog(["messages", "--bot", scheduledBot.id, "--task", scheduledRun.threadId!, "--url", url]);
    expect(wait).toMatchObject({ status: "settled" });
    const evidence = { fixture: fixture.info, restartPid: restarted.pid, runs, wait, messages };
    writeFileSync(`${logPath}.routines-restart.json`, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ logPath, evidencePath: `${logPath}.routines-restart.json` }));
  } finally {
    await waitForExit(restarted, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 45_000);
