import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { cloudLendingVerdict, computerName, createComputerSharing } from "./computer-sharing.mjs";
import { createLendingIndicator } from "./lending-indicator.mjs";

const ORIGIN = "https://laterdog-u-fixture.fly.dev";
const OTHER = "https://laterdog-u-other.fly.dev";
const MAC = "Jo's MacBook Air";
const binding = { accountId: "acct_1", origin: ORIGIN };
const env = { id: "my-cloud", name: "My Cloud", origin: ORIGIN };
const signedIn = (accountId = "acct_1", origin = ORIGIN) => ({ status: "connected", accountId, origin });
const signedOut = { status: "signed-out", accountId: null, origin: null };

test("the Cloud verdict: same account and machine run, anything else ends or pauses", () => {
  const connected = signedIn();
  assert.deepEqual(cloudLendingVerdict(binding, connected, env), { allow: true });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "unavailable", accountId: "acct_1", origin: null }, env), { allow: true });
  assert.deepEqual(cloudLendingVerdict(binding, signedOut, env), { stop: "signed-out" });
  assert.deepEqual(cloudLendingVerdict(binding, null, env), { pause: "unverified" });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "unavailable", accountId: null, origin: null }, env), { pause: "unverified" });
  assert.deepEqual(cloudLendingVerdict(binding, { ...connected, accountId: "acct_2" }, env), { stop: "account-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, { ...connected, origin: OTHER }, env), { stop: "machine-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, connected, { origin: "https://evil.example" }), { stop: "machine-changed" });
  assert.deepEqual(cloudLendingVerdict(binding, { status: "reauth-required", accountId: "acct_1", origin: null }, env), { pause: "reauth-required" });
  assert.deepEqual(cloudLendingVerdict(undefined, connected, env), { stop: "signed-out" });
});

test("the computer is named the way the person named it, and never left blank", async () => {
  assert.equal(await computerName({ platform: "linux", hostname: () => "jo-laptop.local" }), "jo-laptop");
  assert.equal(await computerName({ platform: "linux", hostname: () => "\u0000\n" }), "This computer");
  assert.equal(await computerName({ platform: "win32", hostname: () => "" }), "This computer");
});

async function scratch(t) {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), "laterdog-cloud-lending-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function cloudHome({ cloudHome = true, scopes = ["admin", "client"], paired = true, asleep = null } = {}) {
  const reply = (value, status = 200, headers = {}) => ({
    ok: status < 400, status, headers: { get: name => headers[name.toLowerCase()] ?? null },
    body: (async function* () { yield Buffer.from(JSON.stringify(value)); })(),
  });
  const state = {
    paired, asleep, environmentId: randomUUID(), sessionId: randomUUID(), pollStatus: 200, restingHits: 0,
    connects: [], secrets: [], pairs: [], codes: new Set(), routes: new Set(), disconnects: 0, results: [], queue: [], waiting: null, unmarked: [],
  };
  const nextJob = () => new Promise(resolve => {
    const timer = setTimeout(() => { if (state.waiting === wake) state.waiting = null; resolve(null); }, 200);
    const wake = job => { clearTimeout(timer); resolve(job); };
    state.waiting = wake;
  });
  state.push = operation => {
    const job = { id: randomUUID(), operation: { computer_id: state.connects.at(-1).id, ...operation } };
    if (state.waiting) { const wake = state.waiting; state.waiting = null; wake(job); } else state.queue.push(job);
  };
  state.mint = () => { const code = randomUUID(); state.codes.add(code); return code; };
  state.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    state.routes.add(route.replace(/\/api\/shared-computers\/[^/]+\//, "/api/shared-computers/:id/"));
    if (init?.headers?.["x-laterdog-lending"] !== "1") state.unmarked.push(route);
    if (state.asleep) {
      state.restingHits++;
      return reply({ error: "asleep", retryAfter: state.asleep }, 503, { "x-laterdog-home": "asleep", "retry-after": String(state.asleep) });
    }
    const body = init?.body ? JSON.parse(init.body) : {};
    if (route === "/api/auth/pair") {
      state.pairs.push(body);
      if (!state.codes.delete(body.code)) return reply({ error: "Invalid code" }, 400);
      state.paired = true;
      state.sessionId = randomUUID();
      return reply({ ok: true });
    }
    if (route === "/api/auth/session") return state.paired ? reply({ kind: "session", id: state.sessionId, scopes, ...(cloudHome ? { cloudHome: true } : {}) }) : reply({ error: "unauthorized" }, 401);
    if (route === "/.well-known/laterdog/environment") return reply({ environmentId: state.environmentId, capabilities: { sharedComputers: true } });
    if (route === "/api/shared-computers/connect") { state.connects.push(body); state.secrets.push(init.headers["x-laterdog-computer-secret"]); return reply({ ok: true }); }
    if (route.endsWith("/poll")) {
      if (state.pollStatus !== 200) return reply({ error: "Forbidden" }, state.pollStatus);
      const job = state.queue.shift() ?? await nextJob();
      init?.signal?.throwIfAborted();
      return reply({ job });
    }
    if (route.endsWith("/lease")) return reply({ active: true });
    if (route.endsWith("/result")) { state.results.push(body.result); return reply({ ok: true }); }
    if (route.endsWith("/disconnect")) { state.disconnects++; return reply({ ok: true }); }
    throw new Error(`no route ${route}`);
  };
  return state;
}

async function hangingDriver(dir) {
  const calls = path.join(dir, "driver-calls.log");
  const pid = path.join(dir, "driver.pid");
  const script = path.join(dir, "driver.mjs");
  await writeFile(script, `import readline from 'node:readline'; import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid));
readline.createInterface({input:process.stdin}).on('line', line => { const m=JSON.parse(line); if(!m.id)return;
if(m.method==='tools/call'){ fs.appendFileSync(${JSON.stringify(calls)}, m.params.name+'\\n'); if(m.params.name==='drag') return; }
const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'drag'},{name:'click'}]}:{content:[{type:'text',text:'ok'}]};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });`);
  return { connection: { mcpCommand: process.execPath, mcpArgs: [script] }, calls, pid };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wakeAndPair = server => { server.asleep = null; return { origin: ORIGIN, code: server.mint(), expiresAt: Date.now() + 60_000 }; };

async function lendingFixture(t, options = {}) {
  const dir = await scratch(t);
  const homeDir = path.join(dir, "home");
  await mkdir(homeDir);
  await writeFile(path.join(homeDir, "plan.md"), "from the Mac");
  const server = cloudHome(options.server);
  const file = path.join(dir, "profile", "computer-sharing.json");
  let cloud = "cloud" in options ? options.cloud : signedIn();
  let maintainerChecks = 0, primes = 0, pairings = 0;
  const summaries = [];
  const leases = [];
  const driver = await hangingDriver(dir);
  const pair = options.pair ?? wakeAndPair;
  const make = () => {
    const sharing = createComputerSharing({
      file, fetch: (...args) => server.fetch(...args), environments: options.environments ?? (() => [env]),
      enabled: async () => { maintainerChecks++; return false; },
      cloud: () => cloud, home: homeDir, computerName: () => MAC, retryMs: 50,
      primeAccess: () => { primes++; },
      pairCloud: async () => { pairings++; return pair(server); },
      cuaConnection: async () => driver.connection,
      hostControl: async id => { leases.push(`acquire:${id}`); return { renew: async () => {}, release: async () => { leases.push(`release:${id}`); } }; },
      onChange: summary => summaries.push(summary),
    });
    t.after(() => sharing.close());
    return sharing;
  };
  const sharing = make();
  sharing.start({ maintainer: false });
  return {
    dir, file, homeDir, server, sharing, make, driver, summaries, leases,
    saved: async () => JSON.parse(await readFile(file, "utf8")),
    maintainerChecks: () => maintainerChecks, primes: () => primes, pairings: () => pairings, setCloud: next => { cloud = next; },
  };
}
const connected = async (sharing, count, server, target = env) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (sharing.cloudState(target).connected && server.connects.length >= count) return;
    await delay(20);
  }
  assert.fail(`never connected: ${JSON.stringify(sharing.cloudState(target))}`);
};
const until = async (check, what, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.fail(`timed out waiting for ${what}`);
};
const output = result => JSON.parse(result.content[0].text);
const dragging = driver => until(async () => (await readFile(driver.calls, "utf8").catch(() => "")).includes("drag"), "the drag to start");

test("a Mac signed in to later.dog Cloud connects to My Cloud by itself: its home, apps and a terminal, nothing to pick", async t => {
  const { homeDir, server, sharing, maintainerChecks, primes, pairings, summaries, saved } = await lendingFixture(t);
  await connected(sharing, 1, server);
  const [connect] = server.connects;
  assert.equal(connect.name, MAC);
  assert.equal(connect.home, true);
  assert.equal(connect.environmentId, server.environmentId);
  assert.deepEqual(connect.folders.map(({ name, write }) => ({ name, write })), [{ name: "Home", write: true }]);
  assert.deepEqual([connect.terminal, connect.computer], [true, true]);
  assert.deepEqual(sharing.cloudState(env), { on: true, name: MAC, enabled: true, busy: false, connected: true });
  const folder_id = connect.folders[0].id;
  server.push({ action: "read_file", folder_id, path: "~/plan.md" });
  server.push({ action: "read_file", folder_id, path: path.join(homeDir, "plan.md") });
  server.push({ action: "run_command", command: "cat plan.md" });
  await until(() => server.results.length === 3, "three results");
  assert.equal(output(server.results[0]).content, "from the Mac");
  assert.equal(output(server.results[1]).content, "from the Mac");
  assert.deepEqual(output(server.results[2]), { exitCode: 0, output: "from the Mac" });
  assert.equal(maintainerChecks(), 0, "My Cloud never depends on the maintainer flag");
  assert.equal(pairings(), 0);
  assert.equal(primes(), 1, "macOS asks about Downloads, Desktop and Documents once, up front");
  assert.ok(summaries.some(summary => summary.lending.includes(env.id)));
  assert.deepEqual(sharing.activity(env.id).map(entry => [entry.action, entry.ok]), [["run_command", true], ["read_file", true], ["read_file", true]]);
  const record = (await saved()).records[env.id];
  assert.equal(record.home, true);
  assert.deepEqual(record.cloud, binding);
  assert.deepEqual([record.sessionId, record.environmentId], [server.sessionId, server.environmentId]);
  assert.equal(record.folders[0].path, await realpath(homeDir));
  assert.equal((await saved()).homeOff, undefined);
});

test("the whole home is shared, but never its keys and secrets, and nothing outside it", async t => {
  const { homeDir, server, sharing } = await lendingFixture(t);
  await mkdir(path.join(homeDir, ".ssh"));
  await writeFile(path.join(homeDir, ".ssh", "id_ed25519"), "private key");
  await connected(sharing, 1, server);
  const folder_id = server.connects[0].folders[0].id;
  server.push({ action: "read_file", folder_id, path: "~/.ssh/id_ed25519" });
  server.push({ action: "read_file", folder_id, path: "/etc/hosts" });
  server.push({ action: "list_files", folder_id, path: "~" });
  await until(() => server.results.length === 3, "three results");
  assert.equal(server.results[0].isError, true);
  assert.match(server.results[0].content[0].text, /cannot be accessed/);
  assert.equal(server.results[1].isError, true);
  assert.equal(server.results[1].content[0].text, "later.dog can only use files in this computer's home folder.");
  assert.deepEqual(output(server.results[2]).entries.find(entry => entry.name === ".ssh"), { name: ".ssh", type: "protected" });
});

test("nothing connects without a verified later.dog Cloud sign-in for this exact machine; signing in connects by itself", async t => {
  for (const cloud of [null, signedOut, { status: "unavailable", accountId: "acct_1", origin: null }, signedIn("acct_1", OTHER)]) {
    const { server, sharing } = await lendingFixture(t, { cloud });
    await delay(100);
    assert.equal(server.connects.length, 0);
    assert.deepEqual([sharing.cloudState(env).on, sharing.cloudState(env).enabled], [true, false]);
  }
  const { server, sharing, setCloud } = await lendingFixture(t, { cloud: signedOut });
  setCloud(signedIn());
  sharing.cloudChanged();
  await connected(sharing, 1, server);
});

test("never connects to a server that is not the person's own Cloud home", async t => {
  for (const options of [{ cloudHome: false }, { scopes: ["client"] }]) {
    const { server, sharing, pairings } = await lendingFixture(t, { server: options });
    await until(() => sharing.cloudState(env).problem === "not-cloud", "not-cloud");
    assert.equal(server.connects.length, 0);
    assert.equal(pairings(), 0);
  }
});

test("a Mac that was never paired pairs itself with the person's Cloud sign-in; a refused request later never re-pairs", async t => {
  const { server, sharing, pairings } = await lendingFixture(t, { server: { paired: false } });
  await connected(sharing, 1, server);
  assert.equal(pairings(), 1);
  assert.deepEqual(server.pairs.map(({ label, cookie }) => ({ label, cookie })), [{ label: MAC, cookie: true }]);
  assert.equal(server.codes.size, 0, "the code it was given is the code it used");
  server.pollStatus = 403;
  await until(() => sharing.cloudState(env).problem === "waiting", "the refusal");
  await delay(300);
  assert.equal(pairings(), 1);
  assert.equal(server.pairs.length, 1);
  server.pollStatus = 200;
  await until(() => sharing.cloudState(env).connected, "reconnect");
});

test("pairing that can't happen is not retried in a loop, and a code for another machine is never used", async t => {
  {
    const { server, sharing, pairings } = await lendingFixture(t, { server: { paired: false }, pair: () => null });
    await until(() => sharing.cloudState(env).problem === "connect-first", "connect-first");
    await delay(400);
    assert.equal(pairings(), 1);
    assert.equal(server.connects.length, 0);
  }
  {
    const { server, sharing, pairings } = await lendingFixture(t, { server: { paired: false }, pair: server => ({ origin: OTHER, code: server.mint() }) });
    await until(() => pairings() === 1 && sharing.cloudState(env).problem === "connect-first", "connect-first");
    assert.equal(server.pairs.length, 0);
    assert.equal(server.connects.length, 0);
  }
});

test("the first connect while My Cloud rests pairs right away, which wakes it", async t => {
  const { server, sharing, pairings } = await lendingFixture(t, { server: { asleep: 1 } });
  await connected(sharing, 1, server);
  assert.equal(pairings(), 1);
  assert.equal(server.pairs.length, 1);
});

test("once paired, a resting Cloud is left to rest: the Mac waits as long as it's told, then reconnects", async t => {
  const { server, sharing, pairings } = await lendingFixture(t);
  await connected(sharing, 1, server);
  server.asleep = 1;
  await until(() => sharing.cloudState(env).problem === "asleep", "asleep");
  assert.equal(sharing.cloudState(env).error, "My Cloud is resting.");
  assert.equal(sharing.cloudState(env).enabled, true);
  const hits = server.restingHits;
  await delay(500);
  assert.equal(server.restingHits, hits, "no request before My Cloud said to come back");
  server.asleep = null;
  await connected(sharing, 2, server);
  assert.equal(pairings(), 0);
  assert.equal(server.connects[1].id, server.connects[0].id);
});

test("turning it off is instant and remembered; turning it on again reconnects with the same connection", async t => {
  const { server, sharing, make, driver, summaries, leases, primes, setCloud, saved } = await lendingFixture(t);
  await connected(sharing, 1, server);
  server.push({ action: "computer_call", tool_name: "drag", arguments: {} });
  await dragging(driver);
  assert.equal(sharing.cloudState(env).busy, true);
  assert.ok(summaries.some(summary => summary.busy?.env === env.id), "the indicator heard that My Cloud is using the Mac");
  const pid = Number(await readFile(driver.pid, "utf8"));
  const off = sharing.setHome(false);
  assert.deepEqual([sharing.cloudState(env).on, sharing.cloudState(env).enabled], [false, false]);
  await off;
  await until(() => !alive(pid), "the driver transport to be closed");
  await until(() => leases.some(entry => entry.startsWith("release:")), "the screen lease to be released");
  await until(() => server.disconnects >= 1, "My Cloud to be told");
  server.push({ action: "computer_call", tool_name: "click", arguments: {} });
  await delay(300);
  assert.equal((await readFile(driver.calls, "utf8")).trim(), "drag");
  await until(() => isDeepStrictEqual(summaries.at(-1), { lending: [], busy: null }), "the indicator to show the Mac is no longer lent");
  assert.equal((await saved()).homeOff, true);
  setCloud(signedOut);
  sharing.cloudChanged();
  setCloud(signedIn());
  sharing.cloudChanged();
  await delay(200);
  assert.equal(server.connects.length, 1, "signing in again doesn't turn it back on");
  sharing.close();
  const next = make();
  next.start({ maintainer: false });
  await delay(200);
  assert.equal(server.connects.length, 1, "the next launch remembers it's off");
  assert.equal(next.cloudState(env).on, false);
  await next.setHome(true);
  await connected(next, 2, server);
  assert.equal(server.connects[1].id, server.connects[0].id);
  assert.equal(server.secrets[1], server.secrets[0]);
  assert.equal(primes(), 1, "macOS isn't asked again");
  assert.equal((await saved()).homeOff, undefined);
});

test("signing out ends it at once and cancels what's running; signing back in to the same account reconnects by itself", async t => {
  const { server, sharing, driver, leases, setCloud, primes } = await lendingFixture(t);
  await connected(sharing, 1, server);
  server.push({ action: "computer_call", tool_name: "drag", arguments: {} });
  await dragging(driver);
  const pid = Number(await readFile(driver.pid, "utf8"));
  setCloud(signedOut);
  sharing.cloudChanged();
  const state = sharing.cloudState(env);
  assert.deepEqual([state.on, state.enabled, state.problem], [true, false, "signed-out"]);
  await until(() => !alive(pid), "the driver transport to be closed");
  await until(() => leases.some(entry => entry.startsWith("release:")), "the screen lease to be released");
  assert.ok(server.disconnects >= 1);
  setCloud(signedIn());
  sharing.cloudChanged();
  await connected(sharing, 2, server);
  assert.equal(server.connects[1].id, server.connects[0].id);
  assert.equal(server.secrets[1], server.secrets[0]);
  assert.equal(primes(), 1);
});

test("another later.dog account gets a fresh connection, a new Cloud machine is picked up, and a sign-in that needs renewing only pauses", async t => {
  {
    const { server, sharing, setCloud, saved } = await lendingFixture(t);
    await connected(sharing, 1, server);
    setCloud(signedIn("acct_2"));
    sharing.cloudChanged();
    await connected(sharing, 2, server);
    assert.notEqual(server.connects[1].id, server.connects[0].id);
    assert.notEqual(server.secrets[1], server.secrets[0]);
    assert.ok(server.disconnects >= 1, "the other account's Cloud stops seeing this Mac");
    assert.equal((await saved()).records[env.id].cloud.accountId, "acct_2");
  }
  {
    const environments = [env];
    const { server, sharing, setCloud } = await lendingFixture(t, { environments: () => environments });
    await connected(sharing, 1, server);
    const moved = { id: "my-cloud-2", name: "My Cloud", origin: OTHER };
    environments.push(moved);
    setCloud(signedIn("acct_1", OTHER));
    sharing.cloudChanged();
    await connected(sharing, 2, server, moved);
    assert.deepEqual([sharing.cloudState(env).enabled, sharing.cloudState(env).problem], [false, "machine-changed"]);
    assert.notEqual(server.connects[1].id, server.connects[0].id);
  }
  {
    const { server, sharing, setCloud } = await lendingFixture(t);
    await connected(sharing, 1, server);
    setCloud({ status: "reauth-required", accountId: "acct_1", origin: null });
    sharing.cloudChanged();
    const state = sharing.cloudState(env);
    assert.deepEqual([state.enabled, state.connected, state.problem], [true, false, "paused"]);
    assert.ok(server.disconnects >= 1, "My Cloud stops seeing it while paused");
    setCloud(signedIn());
    sharing.cloudChanged();
    await connected(sharing, 2, server);
    assert.equal(server.connects[1].id, server.connects[0].id);
  }
});

test("a replaced machine at the same address is picked up by itself", async t => {
  const { server, sharing, make, saved } = await lendingFixture(t);
  await connected(sharing, 1, server);
  sharing.close();
  server.environmentId = randomUUID();
  const next = make();
  next.start({ maintainer: false });
  await connected(next, 2, server);
  assert.equal(server.connects[1].environmentId, server.environmentId);
  assert.equal(server.connects[1].id, server.connects[0].id);
  assert.equal((await saved()).records[env.id].environmentId, server.environmentId);
});

test("several changes at once still make one connection", async t => {
  const { server, sharing } = await lendingFixture(t);
  sharing.cloudChanged();
  sharing.cloudChanged();
  sharing.cloudChanged();
  await connected(sharing, 1, server);
  await delay(200);
  assert.equal(server.connects.length, 1);
});

test("quitting the app pauses; it never turns the Mac off, even mid-reconnect", async t => {
  const { server, sharing, make } = await lendingFixture(t);
  await connected(sharing, 1, server);
  const answer = server.fetch;
  let identityStarted;
  const started = new Promise(resolve => { identityStarted = resolve; });
  server.fetch = async (url, init) => {
    if (new URL(url).pathname === "/api/auth/session") { identityStarted(); await delay(200); }
    return answer(url, init);
  };
  sharing.close();
  const restarted = make();
  restarted.start({ maintainer: false });
  await started;
  restarted.close();
  await delay(400);
  server.fetch = answer;
  const after = make();
  assert.deepEqual([after.cloudState(env).on, after.cloudState(env).enabled], [true, true], "the next launch still connects");
});

test("the menu-bar indicator shows only while My Cloud is using the Mac, lingers between steps, and turns it off", async () => {
  const trays = [];
  class Tray {
    constructor() { this.destroyed = false; this.title = ""; this.menu = null; trays.push(this); }
    on() {} setToolTip(value) { this.tip = value; } setTitle(value) { this.title = value; }
    setContextMenu(menu) { this.menu = menu; } isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  }
  const Menu = { buildFromTemplate: items => items };
  const nativeImage = { createFromPath: () => ({ resize: () => ({}) }) };
  let stops = 0, opens = 0;
  const indicator = createLendingIndicator({ Tray, Menu, nativeImage, iconPath: "icon.png", device: "Mac", lingerMs: 50, onStop: () => stops++, onOpen: () => opens++ });
  indicator.update({ lending: false, busy: false });
  indicator.update({ lending: true, busy: false });
  assert.equal(trays.length, 0, "nothing in the menu bar while My Cloud is only allowed to");
  indicator.update({ lending: true, busy: true });
  assert.equal(trays.length, 1);
  assert.equal(trays[0].title, "In use");
  assert.equal(trays[0].tip, "later.dog: My Cloud is using this Mac");
  assert.equal(trays[0].menu[0].label, "My Cloud is using this Mac");
  trays[0].menu.find(item => item.label === "Turn off for this Mac").click();
  trays[0].menu.find(item => item.label === "later.dog Cloud settings…").click();
  assert.deepEqual([stops, opens], [1, 1]);
  indicator.update({ lending: true, busy: false });
  indicator.update({ lending: true, busy: true });
  await delay(100);
  assert.deepEqual([trays.length, trays[0].destroyed], [1, false], "a quick next step keeps the same indicator");
  indicator.update({ lending: true, busy: false });
  assert.equal(trays[0].destroyed, false);
  await delay(100);
  assert.equal(trays[0].destroyed, true, "gone once My Cloud is done");
  indicator.update({ lending: true, busy: true });
  assert.equal(trays.length, 2);
  indicator.update({ lending: false, busy: true });
  assert.equal(trays[1].destroyed, true, "gone as soon as it's turned off");
});

test("every request the Mac makes is marked, pairing included, so it never wakes My Cloud or keeps it awake", async t => {
  const { server, sharing } = await lendingFixture(t, { server: { paired: false } });
  await connected(sharing, 1, server);
  server.push({ action: "read_file", folder_id: server.connects[0].folders[0].id, path: "plan.md" });
  await until(() => server.results.length === 1, "a result");
  await sharing.setHome(false);
  await until(() => server.disconnects >= 1, "the disconnect");
  assert.deepEqual([...server.routes].sort(), [
    "/.well-known/laterdog/environment", "/api/auth/pair", "/api/auth/session", "/api/shared-computers/:id/disconnect",
    "/api/shared-computers/:id/lease", "/api/shared-computers/:id/poll", "/api/shared-computers/:id/result", "/api/shared-computers/connect",
  ]);
  assert.deepEqual(server.unmarked, []);
});
