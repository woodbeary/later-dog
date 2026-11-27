import { mkdir, readFile, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";

const USAGE = `usage: node scripts/swarm-load.mjs --session <test home session.json> --model <stand-in model URL> [options]
  --stages 25,50,100,200      dogs per stage, run in order; a stage that breaks stops the run
  --minutes 6                 length of each stage
  --engine pool|computer|home where the dogs' engines run
  --pool-api URL --pool-key-file FILE   read the pool's hosts and memory
  --mix quick=30,memory=0    change the weights of the turn kinds
  --switch "<shell command>"  run halfway through each stage to switch the home's server code
  --out DIR                   where the results go`;

const TEST_ORIGIN = /^https:\/\/h[0-9a-f]{24}-hometest\.later\.dog$/;
const FIRST = /swarm (\S+?)[\s.]/;
const DONE = /swarm (\S+) (?:done after|exec done)/;
const MODEL = { instanceId: "claude", model: "claude-haiku-5-5" };
const MIX = [["quick", 30], ["tools", 22], ["message", 8], ["fanout", 6], ["memory", 12], ["search", 4], ["long", 8], ["burst", 6]];
const TURN_LIMIT_MS = 5 * 60_000;
const DRAIN_MS = 3 * 60_000;

export function parseArgs(argv) {
  const args = { stages: [25, 50, 100, 200], minutes: 6, engine: "pool" };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    const name = flag.replace(/^--/, "").replace(/-(\w)/g, (_, letter) => letter.toUpperCase());
    args[name] = name === "stages" ? value.split(",").map(Number) : name === "minutes" ? Number(value) : value;
  }
  if (!args.session || !args.model) throw new Error(USAGE);
  if (!["pool", "computer", "home"].includes(args.engine)) throw new Error("--engine is pool, computer or home");
  return args;
}

export function percentile(values, share) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
}

export function spread(values) {
  return { n: values.length, p50: percentile(values, 0.5), p99: percentile(values, 0.99), max: values.length ? Math.max(...values) : null };
}

export function mixFrom(text) {
  if (!text) return MIX;
  const weights = new Map(MIX);
  for (const pair of text.split(",")) {
    const [kind, weight] = pair.split("=");
    if (!weights.has(kind) || !Number.isFinite(Number(weight))) throw new Error(`--mix takes kind=weight pairs from ${MIX.map(([kind]) => kind).join(", ")}`);
    weights.set(kind, Number(weight));
  }
  return [...weights.entries()];
}

export function pick(random, mix = MIX) {
  const total = mix.reduce((sum, [, weight]) => sum + weight, 0);
  let left = random * total;
  for (const [kind, weight] of mix) if ((left -= weight) < 0) return kind;
  return "quick";
}

export function marker(kind, id, peers, random) {
  const peer = peers[0];
  const think = 400 + Math.round(random * 1200);
  switch (kind) {
    case "tools": return `[swarm kind=tools id=${id} n=${3 + Math.round(random * 3)} sleep=1 think=${think}]`;
    case "long": return `[swarm kind=tools id=${id} n=${8 + Math.round(random * 6)} sleep=3 lines=4000 think=${think}]`;
    case "burst": return `[swarm kind=tools id=${id} n=12 sleep=0 lines=20000 think=150]`;
    case "fanout": return peers.length > 1 ? `[swarm kind=fanout id=${id} peers=${peers.slice(0, 4).join(",")} think=${think}]` : `[swarm kind=quick id=${id} think=${think}]`;
    case "message": return peer ? `[swarm kind=message id=${id} peer=${peer} think=${think}]` : `[swarm kind=quick id=${id} think=${think}]`;
    default: return `[swarm kind=${kind} id=${id} think=${think}]`;
  }
}

export function homeLogFacts(text, from, to) {
  const facts = { held: [], heldContext: {}, replies: [], pool: { opened: [], fallbacks: 0, fallbackReasons: {} }, rss: [], container: [], errors: 0 };
  for (const line of text.split("\n")) {
    const at = Date.parse(line.slice(0, 24));
    if (!Number.isFinite(at) || at < from || at > to) continue;
    const held = /event loop held (\d+) ms(?: \((.*)\))?/.exec(line);
    if (held) {
      facts.held.push(Number(held[1]));
      const context = (held[2] ?? "").replace(/[0-9a-f]{8}/g, "").replace(/\s+/g, " ").trim() || "none";
      facts.heldContext[context] = Math.max(facts.heldContext[context] ?? 0, Number(held[1]));
    }
    const reply = /reply timing .*started ([\d.]+) s, first words ([\d.]+) s, done ([\d.]+) s/.exec(line);
    if (reply) facts.replies.push({ started: Number(reply[1]), first: Number(reply[2]), done: Number(reply[3]) });
    const opened = /\[pool\] .* opened on pool slot \d+ in (\d+) ms/.exec(line);
    if (opened) facts.pool.opened.push(Number(opened[1]));
    const fallback = /\[pool\] .* falls back to the dog's computer after \d+ ms: (.*)$/.exec(line);
    if (fallback) {
      facts.pool.fallbacks += 1;
      const reason = fallback[1].slice(0, 80);
      facts.pool.fallbackReasons[reason] = (facts.pool.fallbackReasons[reason] ?? 0) + 1;
    }
    const rss = /rss (\d+) MB/.exec(line);
    if (rss) facts.rss.push(Number(rss[1]));
    const whole = /whole container (\d+) MB/.exec(line);
    if (whole) facts.container.push(Number(whole[1]));
    if (/\b(Error|error:|failed|crash)/.test(line) && !/reply timing|event loop held/.test(line)) facts.errors += 1;
  }
  return facts;
}

class Home {
  constructor(session) {
    this.origin = session.url;
    this.token = session.token;
  }

  async call(path, method = "GET", body, timeoutMs = 60_000) {
    const started = performance.now();
    try {
      const response = await fetch(this.origin + path, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      let data = text;
      try { data = JSON.parse(text); } catch {}
      return { status: response.status, data, ms: performance.now() - started };
    } catch (error) {
      return { status: 0, data: { error: error.name === "TimeoutError" ? "timeout" : error.message }, ms: performance.now() - started };
    }
  }

  async must(path, method, body) {
    const answer = await this.call(path, method, body);
    if (answer.status < 200 || answer.status >= 300) throw new Error(`${method ?? "GET"} ${path} answered ${answer.status}: ${JSON.stringify(answer.data).slice(0, 300)}`);
    return answer.data;
  }
}

class Events {
  constructor(home, onMessage) {
    this.home = home;
    this.onMessage = onMessage;
    this.cursor = null;
    this.frames = 0;
    this.reconnects = 0;
    this.stopped = false;
    this.controller = null;
  }

  start() {
    this.loop = this.run();
  }

  async run() {
    while (!this.stopped) {
      this.controller = new AbortController();
      try {
        const query = this.cursor ? `?since=${encodeURIComponent(this.cursor)}` : "";
        const response = await fetch(`${this.home.origin}/api/events${query}`, {
          headers: { authorization: `Bearer ${this.home.token}`, accept: "text/event-stream" },
          signal: this.controller.signal,
        });
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("");
            if (!data) continue;
            this.frames += 1;
            let event;
            try { event = JSON.parse(data); } catch { continue; }
            if (event.kind === "hello" && event.cursor) this.cursor = event.cursor;
            if (event.message && event.threadId) this.onMessage(event.threadId, event.message, Date.now());
            if (event.kind === "notify" && event.notification?.kind === "turn-failed") this.onMessage(event.notification.threadId, { role: "bot", kind: "failed", text: "" }, Date.now());
          }
        }
      } catch {}
      if (this.stopped) return;
      this.reconnects += 1;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.loop;
  }
}

class Turns {
  constructor() {
    this.byId = new Map();
    this.byThread = new Map();
  }

  sent(turn) {
    this.byId.set(turn.id, turn);
    this.byThread.set(turn.threadId, turn);
  }

  seen(threadId, message, at) {
    if (message.role === "user") return;
    const text = String(message.text ?? "");
    const first = FIRST.exec(text);
    const done = DONE.exec(text);
    const turn = (done && this.byId.get(done[1])) || (first && this.byId.get(first[1])) || this.byThread.get(threadId);
    if (!turn || turn.doneAt) {
      if (done && done[1].endsWith("-peer")) this.peerDone = (this.peerDone ?? 0) + 1;
      if (done && done[1].startsWith("rt-")) this.routinesDone = (this.routinesDone ?? 0) + 1;
      return;
    }
    if (message.kind === "text" && first && first[1] === turn.id && !turn.firstAt) turn.firstAt = at;
    if (done && done[1] === turn.id) turn.doneAt = at;
    if ((message.kind === "failed" || message.kind === "error" || message.turnSucceeded === false) && threadId === turn.threadId && !turn.failedAt) {
      turn.failedAt = at;
      turn.failure = String(message.tool?.name ?? message.text ?? message.kind).slice(0, 120);
    }
  }
}

async function ensureDogs(home, count, log) {
  const listed = await home.must("/api/bots?messages=0");
  const dogs = listed.bots.filter((bot) => /^swarm-\d{3}$/.test(bot.name)).sort((a, b) => a.name.localeCompare(b.name));
  const started = Date.now();
  const createMs = [];
  for (let index = dogs.length; index < count; index += 1) {
    const name = `swarm-${String(index + 1).padStart(3, "0")}`;
    const made = await home.call("/api/bots", "POST", { name, modelSelection: MODEL, approvalMode: "auto", createId: `swarm-load-${name}` });
    if (made.status !== 201 && made.status !== 200) throw new Error(`creating ${name} answered ${made.status}: ${JSON.stringify(made.data).slice(0, 200)}`);
    createMs.push(made.ms);
    const bot = made.data.bot;
    const chat = await home.must(`/api/bots/${bot.id}/tasks`, "POST", { title: "swarm load" });
    const tasks = chat.bot?.tasks ?? [];
    const thread = tasks.filter((task) => task.title === "swarm load").sort((a, b) => b.createdAt - a.createdAt)[0]?.threadId;
    if (!thread) throw new Error(`no swarm chat for ${name}`);
    if (index % 3 === 0) {
      for (let file = 0; file < 3; file += 1) {
        await home.call(`/api/bots/${bot.id}/memory/file`, "PUT", { path: `notes/swarm-${file}.md`, text: `# Notes ${file}\n${Array.from({ length: 300 }, (_, line) => `- swarm fact ${line} about project ${line % 17} and customer ${line % 29}`).join("\n")}\n` });
      }
    }
    dogs.push({ ...bot, swarmThread: thread });
  }
  const resolved = [];
  for (const dog of dogs.slice(0, count)) {
    if (dog.swarmThread) { resolved.push(dog); continue; }
    const tasks = dog.tasks ?? [];
    const thread = tasks.filter((task) => task.title === "swarm load").sort((a, b) => b.createdAt - a.createdAt)[0]?.threadId;
    resolved.push({ ...dog, swarmThread: thread ?? dog.threadId });
  }
  log(`dogs ready: ${resolved.length} (${createMs.length} created in ${Math.round((Date.now() - started) / 1000)} s, create ${JSON.stringify(spread(createMs.map(Math.round)))} ms)`);
  return { dogs: resolved, created: createMs.length, createMs: spread(createMs.map(Math.round)) };
}

async function poolView(args) {
  if (!args.poolApi || !args.poolKeyFile) return null;
  try {
    const key = (await readFile(args.poolKeyFile, "utf8")).trim();
    const response = await fetch(`${args.poolApi.replace(/\/$/, "")}/pool`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const pool = (await response.json()).pool;
    const hosts = pool.hosts.map((host) => ({ state: host.state, used: host.load?.usedBytes ?? 0, limit: host.load?.limitBytes ?? 0, engines: host.load?.engines ?? 0, busy: host.load?.busy ?? 0 }));
    return { at: Date.now(), hosts, chats: pool.chats, hourlyUsd: pool.hourlyUsd };
  } catch (error) {
    return { at: Date.now(), error: error.message };
  }
}

function runShell(command, log) {
  return new Promise((resolve) => {
    const started = Date.now();
    exec(command, { timeout: 5 * 60_000 }, (error, stdout, stderr) => {
      log(`switch command ${error ? "failed" : "finished"} in ${Math.round((Date.now() - started) / 1000)} s ${(stdout + stderr).trim().split("\n").at(-1) ?? ""}`);
      resolve(!error);
    });
  });
}

async function runStage(home, args, stageDogs, out, log) {
  const turns = new Turns();
  const events = new Events(home, (threadId, message, at) => turns.seen(threadId, message, at));
  events.start();
  const stageStart = Date.now();
  const deadline = stageStart + args.minutes * 60_000;
  const health = [];
  const healthFailures = [];
  const storage = [];
  const pools = [];
  const bundles = [];
  const acks = [];
  let stop = false;
  let switchAt = null;
  let switchedAt = null;
  const peers = stageDogs.map((dog) => dog.id);
  const mix = mixFrom(args.mix);

  const routines = [];
  const firesAt = Math.ceil((Date.now() + 90_000) / 60_000) * 60_000;
  for (const dog of stageDogs.filter((_, index) => index % 4 === 1)) {
    const made = await home.call("/api/routines", "POST", {
      name: `swarm routine ${dog.name}`, botId: dog.id, prompt: `[swarm kind=tools id=rt-${dog.name} n=3 sleep=1 think=600]`,
      schedule: { type: "interval", everyMinutes: 5, anchorAt: firesAt }, overlap: "skip",
    });
    if (made.status === 201) routines.push(made.data.routine.id);
  }
  log(`stage ${stageDogs.length}: ${routines.length} routines all firing at ${new Date(firesAt).toISOString()} and every 5 minutes after`);

  const healthLoop = (async () => {
    while (!stop) {
      const answer = await home.call("/api/health", "GET", undefined, 15_000);
      if (answer.status === 200) {
        health.push(Math.round(answer.ms));
        const prefix = answer.data?.cloudHomeBuild?.bundlePrefix;
        if (prefix && bundles.at(-1)?.prefix !== prefix) bundles.push({ at: Date.now() - stageStart, prefix });
        if (switchAt && !switchedAt && bundles.length > 1) switchedAt = Date.now();
      } else healthFailures.push({ at: Date.now() - stageStart, status: answer.status, ms: Math.round(answer.ms) });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();

  const sideLoop = (async () => {
    while (!stop) {
      const disk = await home.call("/api/storage", "GET", undefined, 30_000);
      if (disk.status === 200) storage.push({ at: Date.now() - stageStart, ms: Math.round(disk.ms), freeDisk: disk.data.disk?.freeBytes, availableMemory: disk.data.memory?.availableBytes });
      const pool = await poolView(args);
      if (pool) pools.push({ ...pool, at: pool.at - stageStart });
      if (args.switch && !switchAt && Date.now() - stageStart > (deadline - stageStart) / 2) {
        switchAt = Date.now();
        log(`switching the home's server code at ${Math.round((switchAt - stageStart) / 1000)} s`);
        await runShell(args.switch, log);
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  })();

  const dogLoop = async (dog, index) => {
    let random = Math.random();
    await new Promise((resolve) => setTimeout(resolve, random * 20_000));
    for (let n = 0; Date.now() < deadline; n += 1) {
      random = Math.random();
      const kind = pick(random, mix);
      const id = `s${stageDogs.length}-${index}-${n}`;
      const others = peers.filter((_, other) => other !== index);
      const offset = Math.floor(Math.random() * Math.max(1, others.length));
      const chosen = Array.from({ length: Math.min(4, others.length) }, (_, step) => others[(offset + step) % others.length]);
      const turn = { id, kind, dog: dog.name, threadId: dog.swarmThread, sentAt: Date.now() };
      turns.sent(turn);
      const answer = await home.call(`/api/bots/${dog.id}/messages`, "POST", { text: `load ${kind} ${marker(kind, id, chosen, Math.random())}`, threadId: dog.swarmThread, sendId: randomUUID().replaceAll("-", "") }, 60_000);
      turn.ack = { status: answer.status, ms: Math.round(answer.ms), queued: Boolean(answer.data?.queued), steered: Boolean(answer.data?.steered) };
      acks.push(turn.ack.ms);
      if (answer.status !== 200 && answer.status !== 202) {
        turn.failedAt = Date.now();
        turn.failure = `send ${answer.status} ${JSON.stringify(answer.data).slice(0, 100)}`;
      }
      while (!turn.doneAt && !turn.failedAt && Date.now() - turn.sentAt < TURN_LIMIT_MS && (Date.now() < deadline + DRAIN_MS)) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!turn.doneAt && !turn.failedAt) return;
      await new Promise((resolve) => setTimeout(resolve, 4_000 + Math.random() * 16_000));
    }
  };

  const busy = [];
  const busyLoop = (async () => {
    while (!stop) {
      const open = [...turns.byId.values()].filter((turn) => !turn.doneAt && !turn.failedAt).length;
      busy.push({ at: Date.now() - stageStart, open });
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  })();

  await Promise.all(stageDogs.map(dogLoop));
  const sweepStart = Date.now();
  for (const turn of turns.byId.values()) {
    if (turn.doneAt || turn.failedAt) continue;
    const rows = await home.call(`/api/threads/${turn.threadId}/messages?limit=20`);
    for (const message of rows.data?.messages ?? []) turns.seen(turn.threadId, message, message.at);
  }
  stop = true;
  await Promise.all([healthLoop, sideLoop, busyLoop]);
  await events.stop();
  for (const routine of routines) await home.call(`/api/routines/${routine}`, "DELETE");
  const stageEnd = Date.now();

  const logText = await home.call("/api/home-log?lines=2000", "GET", undefined, 60_000);
  const facts = homeLogFacts(typeof logText.data === "string" ? logText.data : "", stageStart, stageEnd);
  const all = [...turns.byId.values()];
  const done = all.filter((turn) => turn.doneAt);
  const failed = all.filter((turn) => turn.failedAt && !turn.doneAt);
  const lost = all.filter((turn) => !turn.doneAt && !turn.failedAt);
  const byKind = {};
  for (const turn of done) (byKind[turn.kind] ??= []).push((turn.doneAt - turn.sentAt) / 1000);
  const failures = {};
  for (const turn of failed) failures[turn.failure] = (failures[turn.failure] ?? 0) + 1;
  const poolHosts = pools.filter((pool) => pool.hosts);
  const engineMb = poolHosts.flatMap((pool) => pool.hosts.filter((host) => host.engines).map((host) => host.used / host.engines / 1048576));
  const hostHours = poolHosts.length ? poolHosts.reduce((sum, pool) => sum + pool.hosts.length, 0) / poolHosts.length : 0;
  const result = {
    dogs: stageDogs.length, engine: args.engine, startedAt: new Date(stageStart).toISOString(), minutes: (stageEnd - stageStart) / 60_000, sweepSeconds: Math.round((stageEnd - sweepStart) / 1000),
    turns: { sent: all.length, done: done.length, failed: failed.length, lost: lost.length, lostIds: lost.slice(0, 20).map((turn) => `${turn.id}:${turn.kind}`), failures, peerDelivered: turns.peerDone ?? 0, routineRuns: turns.routinesDone ?? 0,
      maxOpen: Math.max(0, ...busy.map((point) => point.open)) },
    replySeconds: {
      first: spread(done.filter((turn) => turn.firstAt).map((turn) => (turn.firstAt - turn.sentAt) / 1000)),
      done: spread(done.map((turn) => (turn.doneAt - turn.sentAt) / 1000)),
      byKind: Object.fromEntries(Object.entries(byKind).map(([kind, values]) => [kind, spread(values)])),
    },
    sendAckMs: spread(acks),
    healthMs: { ...spread(health), failures: healthFailures.length, longestOutageSeconds: longestRun(healthFailures) },
    eventLoopHeldMs: { ...spread(facts.held), total: facts.held.reduce((sum, value) => sum + value, 0), worstByContext: topContexts(facts.heldContext) },
    homeReplyTiming: { started: spread(facts.replies.map((reply) => reply.started)), first: spread(facts.replies.map((reply) => reply.first)), done: spread(facts.replies.map((reply) => reply.done)) },
    home: { rssMb: spread(facts.rss), containerMb: spread(facts.container), minFreeDiskMb: mb(Math.min(...storage.map((row) => row.freeDisk ?? Infinity))), minAvailableMemoryMb: mb(Math.min(...storage.map((row) => row.availableMemory ?? Infinity))), storageMs: spread(storage.map((row) => row.ms)), logErrors: facts.errors },
    pool: { maxHosts: Math.max(0, ...poolHosts.map((pool) => pool.hosts.length)), averageHosts: Math.round(hostHours * 10) / 10, maxEngines: Math.max(0, ...poolHosts.map((pool) => pool.hosts.reduce((sum, host) => sum + host.engines, 0))),
      engineMb: spread(engineMb.map(Math.round)), maxHostMemoryShare: Math.max(0, ...poolHosts.flatMap((pool) => pool.hosts.map((host) => host.limit ? Math.round(host.used / host.limit * 100) : 0))),
      hourlyUsd: Math.max(0, ...poolHosts.map((pool) => pool.hourlyUsd ?? 0)), opens: spread(facts.pool.opened), fallbacks: facts.pool.fallbacks, fallbackReasons: facts.pool.fallbackReasons, timeline: poolHosts.map((pool) => [Math.round(pool.at / 1000), pool.hosts.length, pool.hosts.reduce((sum, host) => sum + host.engines, 0)]) },
    switch: switchAt ? { at: Math.round((switchAt - stageStart) / 1000), servedNewCodeAfterSeconds: switchedAt ? Math.round((switchedAt - switchAt) / 1000) : null, bundles } : null,
    events: { frames: events.frames, reconnects: events.reconnects },
  };
  await writeFile(join(out, `stage-${stageDogs.length}.json`), `${JSON.stringify({ result, turns: all, health, healthFailures, storage, pools, busy }, null, 1)}\n`);
  return result;
}

const mb = (bytes) => Number.isFinite(bytes) ? Math.round(bytes / 1048576) : null;

function longestRun(failures) {
  let longest = 0;
  let start = null;
  let last = null;
  for (const failure of failures) {
    if (last === null || failure.at - last > 5_000) start = failure.at;
    last = failure.at;
    longest = Math.max(longest, (last - start) / 1000 + 1);
  }
  return Math.round(longest);
}

function topContexts(contexts) {
  return Object.fromEntries(Object.entries(contexts).sort((a, b) => b[1] - a[1]).slice(0, 6));
}

export function broke(result) {
  const reasons = [];
  if (result.turns.sent && (result.turns.failed + result.turns.lost) / result.turns.sent > 0.2) reasons.push("over 20% of turns failed or were lost");
  if ((result.healthMs.p99 ?? 0) > 10_000 || result.healthMs.longestOutageSeconds > 120) reasons.push("the home stopped answering");
  if ((result.replySeconds.first.p50 ?? 0) > 60) reasons.push("half the replies took over a minute to start");
  return reasons;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const session = JSON.parse(await readFile(args.session, "utf8"));
  if (!TEST_ORIGIN.test(session.url)) throw new Error("swarm-load runs only against a later.dog test home (*-hometest.later.dog)");
  if (!basename(args.session).includes("-claude-")) throw new Error("the test home's account name must contain -claude-");
  const out = args.out ?? join("swarm-load", new Date().toISOString().replace(/[:.]/g, "-"));
  await mkdir(out, { recursive: true });
  const lines = [];
  const log = (line) => { const stamped = `${new Date().toISOString()} ${line}`; lines.push(stamped); console.log(stamped); };
  const home = new Home(session);
  await home.must("/api/config", "PUT", { anthropic: { key: "swarm-load-stand-in", url: args.model, everyClaudeBot: true } });
  await home.must("/api/engine-placement", "PUT", { placement: args.engine === "home" ? "home" : "computer" });
  const pool = await home.call("/api/engine-pool", "PUT", { enabled: args.engine === "pool" });
  log(`engine ${args.engine}; pool setting ${pool.status} ${JSON.stringify(pool.data)}`);
  const results = [];
  for (const count of args.stages) {
    const ready = await ensureDogs(home, count, log);
    log(`stage ${count} dogs for ${args.minutes} minutes`);
    const result = await runStage(home, args, ready.dogs, out, log);
    result.setup = { created: ready.created, createMs: ready.createMs };
    results.push(result);
    log(`stage ${count}: ${JSON.stringify({ turns: result.turns, first: result.replySeconds.first, done: result.replySeconds.done, health: result.healthMs, held: result.eventLoopHeldMs, pool: { maxHosts: result.pool.maxHosts, maxEngines: result.pool.maxEngines, engineMb: result.pool.engineMb, fallbacks: result.pool.fallbacks } })}`);
    await writeFile(join(out, "results.json"), `${JSON.stringify(results, null, 1)}\n`);
    const reasons = broke(result);
    if (reasons.length) { log(`stage ${count} broke: ${reasons.join("; ")}; stopping`); break; }
  }
  await writeFile(join(out, "run.log"), `${lines.join("\n")}\n`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
