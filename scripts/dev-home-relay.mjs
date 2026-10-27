import { readSession } from "./dev-home-proxy.mjs";

const POLL_INTERVAL_MS = 2000;
const LOCAL_POLL_INTERVAL_MS = 500;
const LOCAL_POLL_TIMEOUT_MS = 10 * 60_000;

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error ?? `${url} answered ${res.status}`), { status: res.status });
  return body;
}

export async function waitForLocalReply({ localUrl, localToken, botId, threadId, text, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), deadline = Date.now() + LOCAL_POLL_TIMEOUT_MS }) {
  const headers = { "content-type": "application/json", ...(localToken ? { authorization: `Bearer ${localToken}` } : {}) };
  const waited = deadline - Date.now();
  await fetchJson(`${localUrl}/api/bots/${botId}/messages`, { method: "POST", headers, body: JSON.stringify({ text, threadId }) });
  while (Date.now() < deadline) {
    const { bots } = await fetchJson(`${localUrl}/api/bots`, { headers });
    const bot = bots?.find((candidate) => candidate.id === botId);
    if (bot && !bot.busy) {
      const { messages } = await fetchJson(`${localUrl}/api/threads/${threadId}/messages?limit=1`, { headers });
      const last = messages?.[messages.length - 1];
      if (last?.role === "bot" && typeof last.text === "string") return last.text;
    }
    await sleep(LOCAL_POLL_INTERVAL_MS);
  }
  throw new Error(`this Mac's local dog did not answer within ${Math.max(1, Math.round(waited / 60_000))} minute(s)`);
}

export async function relayOneJob({ home, localUrl, localToken, localBotId, log = () => {}, localPoll = {} }) {
  const { job } = await fetchJson(`${home.url.origin}/api/internal/mac-relay/jobs`, { headers: { authorization: `Bearer ${home.token}` } });
  if (!job) return false;
  log(`relaying job ${job.id} to the local dog`);
  try {
    const text = await waitForLocalReply({ localUrl, localToken, botId: localBotId, threadId: job.threadId, text: job.text, ...localPoll });
    await fetchJson(`${home.url.origin}/api/internal/mac-relay/jobs/${job.id}/result`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${home.token}` }, body: JSON.stringify({ text }),
    });
    log(`job ${job.id} relayed back to the home`);
  } catch (error) {
    await fetchJson(`${home.url.origin}/api/internal/mac-relay/jobs/${job.id}/fail`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${home.token}` }, body: JSON.stringify({ message: error.message }),
    }).catch(() => {});
    log(`job ${job.id} failed: ${error.message}`);
  }
  return true;
}

export async function runRelayLoop({ session, localUrl, localToken, localBotId, log = () => {}, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), signal, localPoll = {} }) {
  const home = readSession(session);
  while (!signal?.aborted) {
    const picked = await relayOneJob({ home, localUrl, localToken, localBotId, log, localPoll });
    if (!picked) await sleep(POLL_INTERVAL_MS);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const session = process.env.LATERDOG_DEV_HOME_SESSION ?? `${process.env.HOME}/.laterdog-dev-tools/my-home.session.json`;
  const localUrl = process.env.LATERDOG_DEV_LOCAL_URL ?? "http://127.0.0.1:8999";
  const localToken = process.env.LATERDOG_DEV_LOCAL_TOKEN;
  const localBotId = process.env.LATERDOG_DEV_RELAY_BOT_ID;
  if (!localBotId) {
    console.error("set LATERDOG_DEV_RELAY_BOT_ID to the local bot's id (see pnpm dev:desktop's bot list) before running this relay");
    process.exit(1);
  }
  runRelayLoop({ session, localUrl, localToken, localBotId, log: (line) => console.log(`dev-home-relay | ${line}`) }).catch((error) => {
    console.error(`dev-home-relay: ${error.message}`);
    process.exit(1);
  });
}
