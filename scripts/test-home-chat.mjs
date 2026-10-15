import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const [sessionFile, command, ...rest] = process.argv.slice(2);
const session = JSON.parse(await readFile(sessionFile, "utf8"));

async function api(path, init = {}) {
  const response = await fetch(`${session.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${session.token}`, accept: "application/json", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function bot(name) {
  const { bots } = await api("/api/bots?messages=40");
  const found = bots.find((candidate) => candidate.name === name) ?? bots[0];
  if (!found) throw new Error("no dogs in this home");
  return found;
}

function line(message) {
  const at = new Date(message.at).toISOString().slice(11, 19);
  return `${at} ${message.role}/${message.kind}: ${String(message.text ?? "").replace(/\s+/g, " ").slice(0, 300)}`;
}

async function watch(name, seconds, since) {
  const deadline = Date.now() + seconds * 1000;
  const seen = new Set();
  let current = await bot(name);
  while (Date.now() < deadline) {
    current = await bot(name);
    for (const message of current.messages) {
      if (message.at < since || seen.has(message.id)) continue;
      seen.add(message.id);
      if (message.kind !== "activity") process.stdout.write(`${line(message)}\n`);
    }
    if (!current.busy && Date.now() - since > 4000) break;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  process.stdout.write(`busy=${Boolean(current.busy)} after ${Math.round((Date.now() - since) / 1000)}s\n`);
  return current;
}

if (command === "send") {
  const [name, text, waitSeconds = "120"] = rest;
  const target = await bot(name);
  const since = Date.now();
  await api(`/api/bots/${target.id}/messages`, { method: "POST", body: JSON.stringify({ text, sendId: randomUUID() }) });
  await watch(name, Number(waitSeconds), since);
} else if (command === "stop-after") {
  const [name, text, delaySeconds = "15", waitSeconds = "60"] = rest;
  const target = await bot(name);
  const since = Date.now();
  await api(`/api/bots/${target.id}/messages`, { method: "POST", body: JSON.stringify({ text, sendId: randomUUID() }) });
  await new Promise((resolve) => setTimeout(resolve, Number(delaySeconds) * 1000));
  const before = await bot(name);
  process.stdout.write(`stopping; busy=${Boolean(before.busy)}\n`);
  const stoppedAt = Date.now();
  await api(`/api/bots/${target.id}/interrupt`, { method: "POST", body: JSON.stringify({}) });
  const after = await watch(name, Number(waitSeconds), since);
  process.stdout.write(`stop settled=${!after.busy} in ${Math.round((Date.now() - stoppedAt) / 1000)}s\n`);
} else if (command === "show") {
  const [name, count = "20"] = rest;
  const target = await bot(name);
  for (const message of target.messages.slice(-Number(count))) if (message.kind !== "activity") process.stdout.write(`${line(message)}\n`);
  process.stdout.write(`busy=${Boolean(target.busy)}\n`);
} else {
  process.stderr.write("usage: node scripts/test-home-chat.mjs <session.json> <send|stop-after|show> <dog> ...\n");
  process.exit(2);
}
