import { readSession } from "./dev-home-proxy.mjs";

const POLL_INTERVAL_MS = 2000;
const MIRROR_SYNC_MS = 30_000;
const LOCAL_POLL_INTERVAL_MS = 500;
const LOCAL_POLL_TIMEOUT_MS = 10 * 60_000;
const RECENT_MESSAGES = 50;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function jsonAsker(base, { token, origin, fetchImpl = fetch } = {}) {
  return async (method, path, body) => {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        accept: "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin ? { origin } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const parsed = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(parsed?.error ?? `${method} ${path} answered ${response.status}`), { status: response.status });
    return parsed;
  };
}

export function mirrorProfile(bot) {
  return {
    name: String(bot.name ?? "").trim().slice(0, 80) || "Mac dog",
    ...(typeof bot.title === "string" ? { title: bot.title.slice(0, 200) } : {}),
    ...(typeof bot.description === "string" ? { description: bot.description.slice(0, 4000) } : {}),
    ...(typeof bot.color === "string" && bot.color.length <= 32 ? { color: bot.color } : {}),
  };
}

export async function syncMirrors({ home, local }) {
  const { bots } = await local("GET", "/api/bots");
  const mirrors = new Map();
  for (const bot of bots ?? []) {
    if (typeof bot?.id !== "string" || typeof bot.threadId !== "string") continue;
    const { botId } = await home("PUT", `/api/mac-relay/mirrors/${bot.id}`, mirrorProfile(bot));
    mirrors.set(botId, { id: bot.id, threadId: bot.threadId });
  }
  return mirrors;
}

const botTextIds = (messages) => new Set((messages ?? []).map((message) => message.id));

export async function askLocalDog({ local, bot, text, sleep = pause, deadline = Date.now() + LOCAL_POLL_TIMEOUT_MS }) {
  const waited = deadline - Date.now();
  const path = `/api/threads/${bot.threadId}/messages?limit=${RECENT_MESSAGES}`;
  const seen = botTextIds((await local("GET", path)).messages);
  await local("POST", `/api/bots/${bot.id}/messages`, { text, threadId: bot.threadId });
  while (Date.now() < deadline) {
    const { bots } = await local("GET", "/api/bots");
    const current = bots?.find((candidate) => candidate.id === bot.id);
    if (current && !current.busy) {
      const { messages } = await local("GET", path);
      const reply = (messages ?? []).filter((message) => !seen.has(message.id) && message.role === "bot" && message.kind === "text" && typeof message.text === "string" && message.text.trim()).at(-1);
      if (reply) return reply.text;
    }
    await sleep(LOCAL_POLL_INTERVAL_MS);
  }
  throw new Error(`this Mac's dog did not answer within ${Math.max(1, Math.round(waited / 60_000))} minute(s)`);
}

export async function relayJob({ home, local, bot, job, log = () => {}, localPoll = {} }) {
  log(`relaying job ${job.id} to ${bot.id}`);
  try {
    const text = await askLocalDog({ local, bot, text: job.text, ...localPoll });
    await home("POST", `/api/mac-relay/jobs/${job.id}/result`, { text });
    log(`job ${job.id} relayed back to the home`);
  } catch (error) {
    await home("POST", `/api/mac-relay/jobs/${job.id}/fail`, { message: String(error?.message ?? error).slice(0, 2000) }).catch(() => {});
    log(`job ${job.id} failed: ${error?.message ?? error}`);
  }
}

export function createRelay({ home, local, log = () => {}, localPoll = {} }) {
  let mirrors = new Map();
  const running = new Map();
  return {
    mirrors: () => mirrors,
    async sync() {
      mirrors = await syncMirrors({ home, local });
      return mirrors;
    },
    async poll() {
      let started = 0;
      for (const [homeBotId, bot] of mirrors) {
        if (running.has(homeBotId)) continue;
        const { job } = await home("GET", `/api/mac-relay/bots/${homeBotId}/job`);
        if (!job) continue;
        started += 1;
        running.set(homeBotId, relayJob({ home, local, bot, job, log, localPoll }).finally(() => running.delete(homeBotId)));
      }
      return started;
    },
    idle: () => Promise.all(running.values()),
  };
}

export async function runRelayLoop({ home, local, log = () => {}, sleep = pause, signal, localPoll = {} }) {
  const relay = createRelay({ home, local, log, localPoll });
  let syncedAt = 0;
  while (!signal?.aborted) {
    try {
      if (Date.now() - syncedAt >= MIRROR_SYNC_MS) {
        await relay.sync();
        syncedAt = Date.now();
        log(`relaying ${relay.mirrors().size} dog(s) from this Mac`);
      }
      await relay.poll();
    } catch (error) {
      log(`waiting: ${error?.message ?? error}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  await relay.idle();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const session = process.argv[2] ?? process.env.LATERDOG_DEV_HOME_SESSION ?? `${process.env.HOME}/.laterdog-dev-tools/my-home.session.json`;
  const localUrl = process.argv[3] ?? process.env.LATERDOG_DEV_LOCAL_URL ?? "http://127.0.0.1:18999";
  const saved = readSession(session);
  const home = jsonAsker(saved.url.origin, { token: saved.token });
  const local = jsonAsker(localUrl, { origin: localUrl });
  runRelayLoop({ home, local, log: (line) => console.log(`dev-home-relay | ${line}`) }).catch((error) => {
    console.error(`dev-home-relay: ${error.message}`);
    process.exit(1);
  });
}
