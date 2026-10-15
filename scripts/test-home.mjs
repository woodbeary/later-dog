import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const DRIVER_URL = process.env.LATERDOG_TEST_DRIVER_URL ?? "https://laterdog-home-test-driver.lopez731.workers.dev";
const STATE_DIR = process.env.LATERDOG_TEST_HOME_DIR ?? "/Volumes/laterdog-phone/tmp/test-home";
const SESSION = /^laterdog_sess_[A-Za-z0-9_-]+$/;
const READY_TIMEOUT_MS = 6 * 60_000;

async function driverToken() {
  return (await readFile(join(STATE_DIR, "driver-token"), "utf8")).trim();
}

async function drive(action, accountId) {
  const response = await fetch(`${DRIVER_URL}/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${await driverToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${action} answered ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function ready(accountId) {
  const started = Date.now();
  let summary = await drive("open", accountId);
  while (summary?.state !== "ready") {
    if (Date.now() - started > READY_TIMEOUT_MS) throw new Error(`home not ready: ${JSON.stringify(summary)}`);
    process.stderr.write(`${Math.round((Date.now() - started) / 1000)}s ${JSON.stringify(summary)}\n`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    summary = await drive("summary", accountId);
  }
  process.stderr.write(`ready after ${Math.round((Date.now() - started) / 1000)}s\n`);
  return summary;
}

async function signIn(accountId) {
  const summary = await ready(accountId);
  let grant = await drive("pair", accountId);
  for (let attempt = 0; !grant.ok && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    grant = await drive("pair", accountId);
  }
  if (!grant.ok) throw new Error(`pairing refused: ${JSON.stringify(grant)}`);
  const response = await fetch(`${grant.origin}/api/auth/pair`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ code: grant.code, label: "later.dog test client" }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.token !== "string" || !SESSION.test(body.token)) throw new Error(`no session (${response.status})`);
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const file = join(STATE_DIR, `${accountId}.session.json`);
  await writeFile(file, `${JSON.stringify({ url: summary.origin, token: body.token })}\n`, { mode: 0o600 });
  return { origin: summary.origin, file };
}

const [action, accountId] = process.argv.slice(2);
if (!accountId || !/^test-[a-z0-9-]{1,60}$/.test(accountId)) {
  process.stderr.write("usage: node scripts/test-home.mjs <open|summary|sign-in|remove> test-<name>\n");
  process.exit(2);
}
const result = action === "sign-in" ? await signIn(accountId) : action === "open" ? await ready(accountId) : await drive(action, accountId);
process.stdout.write(`${JSON.stringify(result)}\n`);
