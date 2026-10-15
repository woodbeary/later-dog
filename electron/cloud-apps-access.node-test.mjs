import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { APPS_SESSION_LABEL, MINT_RETRY_DELAYS_MS, createCloudAppsAccess, parseCloudAccess } from "./cloud-apps-access.mjs";

const ORIGIN = "https://abc-home.later.dog";
const OTHER_ORIGIN = "https://xyz-home.later.dog";
const destinationFor = (origin, grant = async () => ({ origin, code: "ABCD-EFGH-JKLM" })) => ({ kind: "cloud", origin, grant });
const destination = destinationFor(ORIGIN);
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fake({ rejectSaved = false, pairStatus = 200, pairGate = null } = {}) {
  const calls = [];
  let minted = 0;
  return { calls, fetchImpl: async (url, init = {}) => {
    const { origin, pathname } = new URL(url);
    const authorization = new Headers(init.headers).get("authorization");
    calls.push({ method: init.method ?? "GET", origin, path: pathname, body: init.body ? JSON.parse(init.body) : undefined, authorization });
    if (pathname === "/api/auth/pair") {
      if (pairGate) await pairGate;
      if (pairStatus !== 200) return json(pairStatus, { error: "nope" });
      minted += 1;
      return json(200, { token: `laterdog_sess_fresh${minted}` });
    }
    if (pathname === "/api/auth/session") return rejectSaved ? json(401, { error: "unauthorized" }) : json(200, { kind: "session", ...(authorization?.includes("full") ? {} : { localTools: true }) });
    if (pathname === "/api/auth/logout") return json(200, { ok: true });
    return json(404, {});
  } };
}

const pairs = (calls) => calls.filter((call) => call.path === "/api/auth/pair");
const logouts = (calls) => calls.filter((call) => call.path === "/api/auth/logout");

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-apps-access-"));
  return { dir, file: join(dir, "cloud-access.json"), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("signing in gives apps on this Mac a scoped local-tools session for My Cloud, once", async () => {
  const { file, done } = workspace();
  try {
    const f = fake();
    const access = createCloudAppsAccess({ file, fetchImpl: f.fetchImpl });
    const first = await access.ensure(destination);
    assert.equal(first.url, ORIGIN);
    assert.match(first.token, /^laterdog_sess_/);
    assert.deepEqual(parseCloudAccess(JSON.parse(readFileSync(file, "utf8"))), first);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(pairs(f.calls)[0].body, { code: "ABCD-EFGH-JKLM", label: APPS_SESSION_LABEL, localTools: true });
    assert.equal(await access.ensure(destination), null, "nothing more happens for the same Cloud");
    assert.equal(pairs(f.calls).length, 1);
  } finally { done(); }
});

test("signing out revokes the apps session on the Cloud before the file goes", async () => {
  const { file, done } = workspace();
  try {
    const f = fake();
    const access = createCloudAppsAccess({ file, fetchImpl: f.fetchImpl });
    const first = await access.ensure(destination);
    await access.forget();
    assert.deepEqual(logouts(f.calls).map(({ method, origin, authorization }) => ({ method, origin, authorization })),
      [{ method: "POST", origin: ORIGIN, authorization: `Bearer ${first.token}` }]);
    assert.equal(existsSync(file), false);
    const again = await access.ensure(destination);
    assert.notEqual(again.token, first.token, "signing in again mints a new session");
  } finally { done(); }
});

test("signing out still deletes the file when the Cloud cannot be reached", async () => {
  const { file, done } = workspace();
  try {
    writeFileSync(file, JSON.stringify({ url: ORIGIN, token: "laterdog_sess_kept" }), { mode: 0o600 });
    const access = createCloudAppsAccess({ file, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
    await access.forget();
    assert.equal(existsSync(file), false);
  } finally { done(); }
});

test("a saved session the Cloud still accepts is kept; a refused one is revoked and replaced", async () => {
  const { file, done } = workspace();
  try {
    writeFileSync(file, JSON.stringify({ url: ORIGIN, token: "laterdog_sess_kept" }), { mode: 0o600 });
    const kept = fake();
    assert.equal((await createCloudAppsAccess({ file, fetchImpl: kept.fetchImpl }).ensure(destination)).token, "laterdog_sess_kept");
    assert.equal(pairs(kept.calls).length, 0);
    assert.equal(logouts(kept.calls).length, 0);
    const refused = fake({ rejectSaved: true });
    assert.notEqual((await createCloudAppsAccess({ file, fetchImpl: refused.fetchImpl }).ensure(destination)).token, "laterdog_sess_kept");
    assert.deepEqual(logouts(refused.calls).map(({ origin, authorization }) => ({ origin, authorization })),
      [{ origin: ORIGIN, authorization: "Bearer laterdog_sess_kept" }]);
  } finally { done(); }
});

test("moving to a different Cloud revokes the old session at the old Cloud", async () => {
  const { file, done } = workspace();
  try {
    writeFileSync(file, JSON.stringify({ url: ORIGIN, token: "laterdog_sess_old" }), { mode: 0o600 });
    const f = fake();
    const moved = await createCloudAppsAccess({ file, fetchImpl: f.fetchImpl }).ensure(destinationFor(OTHER_ORIGIN));
    assert.equal(moved.url, OTHER_ORIGIN);
    assert.deepEqual(parseCloudAccess(JSON.parse(readFileSync(file, "utf8"))), moved);
    assert.deepEqual(logouts(f.calls).map(({ origin, authorization }) => ({ origin, authorization })),
      [{ origin: ORIGIN, authorization: "Bearer laterdog_sess_old" }]);
    assert.equal(pairs(f.calls)[0].origin, OTHER_ORIGIN);
    assert.equal(f.calls.some((call) => call.origin === OTHER_ORIGIN && call.authorization === "Bearer laterdog_sess_old"), false);
  } finally { done(); }
});

test("signing out while a session is being minted revokes it and saves nothing", async () => {
  const { file, done } = workspace();
  try {
    let release;
    const f = fake({ pairGate: new Promise((resolve) => { release = resolve; }) });
    const access = createCloudAppsAccess({ file, fetchImpl: f.fetchImpl });
    const ensuring = access.ensure(destination);
    while (pairs(f.calls).length === 0) await new Promise((resolve) => setImmediate(resolve));
    let forgotten = false;
    const forgetting = access.forget().then(() => { forgotten = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(forgotten, false, "forget waits for the mint in flight");
    release();
    assert.equal(await ensuring, null);
    await forgetting;
    assert.equal(existsSync(file), false);
    assert.deepEqual(logouts(f.calls).map(({ authorization }) => authorization), ["Bearer laterdog_sess_fresh1"]);
    const again = await access.ensure(destination);
    assert.equal(again.token, "laterdog_sess_fresh2", "the abandoned mint did not mark the Cloud ready");
  } finally { done(); }
});

test("signing in again right after signing out mid-mint gets a fresh session", async () => {
  const { file, done } = workspace();
  try {
    let release;
    const f = fake({ pairGate: new Promise((resolve) => { release = resolve; }) });
    const access = createCloudAppsAccess({ file, fetchImpl: f.fetchImpl });
    const abandoned = access.ensure(destination);
    while (pairs(f.calls).length === 0) await new Promise((resolve) => setImmediate(resolve));
    const forgetting = access.forget();
    const signedInAgain = access.ensure(destination);
    assert.notEqual(signedInAgain, abandoned, "the new sign-in does not wait on the abandoned mint's answer");
    release();
    assert.equal(await abandoned, null);
    await forgetting;
    const fresh = await signedInAgain;
    assert.equal(fresh.token, "laterdog_sess_fresh2");
    assert.deepEqual(parseCloudAccess(JSON.parse(readFileSync(file, "utf8"))), fresh);
    assert.deepEqual(logouts(f.calls).map(({ authorization }) => authorization), ["Bearer laterdog_sess_fresh1"]);
  } finally { done(); }
});

test("signing out while the grant is being fetched never mints", async () => {
  const { file, done } = workspace();
  try {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const f = fake();
    const access = createCloudAppsAccess({ file, fetchImpl: f.fetchImpl });
    const ensuring = access.ensure(destinationFor(ORIGIN, async () => { await gate; return { origin: ORIGIN, code: "ABCD-EFGH-JKLM" }; }));
    await new Promise((resolve) => setImmediate(resolve));
    const forgetting = access.forget();
    release();
    assert.equal(await ensuring, null);
    await forgetting;
    assert.equal(existsSync(file), false);
    assert.equal(pairs(f.calls).length, 0);
    assert.equal(logouts(f.calls).length, 0);
  } finally { done(); }
});

test("a failed mint backs off instead of retrying on every account refresh", async () => {
  const { file, done } = workspace();
  try {
    let clock = 1_000_000;
    const f = fake({ pairStatus: 500 });
    const access = createCloudAppsAccess({ file, fetchImpl: f.fetchImpl, now: () => clock });
    assert.equal(await access.ensure(destination), null);
    assert.equal(pairs(f.calls).length, 1);
    assert.equal(await access.ensure(destination), null);
    assert.equal(pairs(f.calls).length, 1, "an immediate refresh does not mint again");
    clock += MINT_RETRY_DELAYS_MS[0];
    await access.ensure(destination);
    assert.equal(pairs(f.calls).length, 2);
    for (let refresh = 0; refresh < 4; refresh += 1) { clock += 60_000; await access.ensure(destination); }
    assert.equal(pairs(f.calls).length, 2, "minute-by-minute refreshes wait for the longer delay");
    clock += MINT_RETRY_DELAYS_MS[1];
    await access.ensure(destination);
    assert.equal(pairs(f.calls).length, 3);
    for (let refresh = 0; refresh < 30; refresh += 1) { clock += 60_000; await access.ensure(destination); }
    assert.equal(pairs(f.calls).length, 3, "after repeated failures it waits about an hour");
    await access.forget();
    await access.ensure(destination);
    assert.equal(pairs(f.calls).length, 4, "signing out and in again tries straight away");
    await access.ensure(destinationFor(OTHER_ORIGIN));
    assert.equal(pairs(f.calls).length, 5, "a different Cloud is tried straight away");
  } finally { done(); }
});

test("a minted session that cannot be saved is revoked, not left behind", async () => {
  const { dir, done } = workspace();
  try {
    writeFileSync(join(dir, "blocker"), "not a folder");
    const file = join(dir, "blocker", "cloud-access.json");
    let clock = 1_000_000;
    const f = fake();
    const access = createCloudAppsAccess({ file, fetchImpl: f.fetchImpl, now: () => clock });
    assert.equal(await access.ensure(destination), null);
    assert.deepEqual(logouts(f.calls).map(({ authorization }) => authorization), ["Bearer laterdog_sess_fresh1"]);
    await access.ensure(destination);
    assert.equal(pairs(f.calls).length, 1, "a save failure backs off too");
    clock += MINT_RETRY_DELAYS_MS[0];
    await access.ensure(destination);
    assert.equal(pairs(f.calls).length, 2);
    assert.equal(logouts(f.calls).length, 2);
  } finally { done(); }
});

test("an older apps session with full access is signed out and replaced by a limited one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-apps-access-"));
  const file = join(dir, "cloud-access.json");
  try {
    writeFileSync(file, JSON.stringify({ url: ORIGIN, token: "laterdog_sess_full" }), { mode: 0o600 });
    const f = fake();
    const access = await createCloudAppsAccess({ file, fetchImpl: f.fetchImpl }).ensure(destination);
    assert.notEqual(access.token, "laterdog_sess_full");
    assert.deepEqual(logouts(f.calls).map((call) => call.authorization), ["Bearer laterdog_sess_full"]);
    assert.equal(pairs(f.calls).at(-1).body.localTools, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
