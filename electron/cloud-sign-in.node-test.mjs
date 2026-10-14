import assert from "node:assert/strict";
import test from "node:test";
import { createCloudAccountClient } from "./cloud-account.mjs";
import { CloudSignInError, createCloudSignIn, normalizeCode, normalizeEmail } from "./cloud-sign-in.mjs";
import { startFakeAccounts } from "./fixtures/fake-accounts.mjs";

async function setup(t, options = {}) {
  const accounts = await startFakeAccounts();
  const saved = { value: null };
  const states = [];
  const client = createCloudAccountClient({
    origin: accounts.origin, fixture: true, deviceName: "Fixture Mac", platform: "darwin", appVersion: "0.0.fixture",
    store: { read: async () => saved.value, write: async value => { saved.value = structuredClone(value); } },
    openBrowser: async () => { throw new Error("sign-in must not open a browser"); },
    onState: state => states.push(state), setTimer: () => 1, clearTimer: () => {}, ...options,
  });
  const signIn = createCloudSignIn({ origin: accounts.origin, deviceName: "Fixture Mac", platform: "darwin", appVersion: "0.0.fixture" });
  t.after(async () => { client.close(); await accounts.close(); });
  return { accounts, client, signIn, saved, states };
}

test("emails and codes are cleaned the way the phone cleans them", () => {
  assert.equal(normalizeEmail("  Person@Example.TEST "), "person@example.test");
  for (const bad of ["", "nobody", "a@b", "a b@c.d", 5, null, `${"x".repeat(250)}@a.bc`]) assert.equal(normalizeEmail(bad), null);
  assert.equal(normalizeCode("1234 5678"), "12345678");
  assert.equal(normalizeCode("123456"), "123456");
  for (const bad of ["12345", "123456789", "abcdefgh", "", null, 12345678]) assert.equal(normalizeCode(bad), null);
});

test("an email and a code sign this Mac in without a browser and leave no account session behind", async t => {
  const f = await setup(t);
  assert.equal(await f.signIn.sendCode("Person@Example.test"), "person@example.test");
  assert.deepEqual(f.accounts.sent, ["person@example.test"]);
  const grant = await f.signIn.verifyCode("person@example.test", f.accounts.goodCode);
  assert.match(grant.accessToken, /^omc_/);
  const state = await f.client.adopt(grant);
  assert.equal(state.status, "connected");
  assert.equal(state.account.email, "person@example.test");
  assert.equal(state.machine.status, "ready");
  assert.equal(f.saved.value.token, grant.accessToken);
  assert.equal(f.accounts.signedOut.length, 1, "the short-lived account session is ended");
  assert.equal(f.accounts.sessions.size, 0);
  const routes = f.accounts.requests.map(row => row.route);
  assert.deepEqual(routes.slice(0, 6), [
    "/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/email-otp", "/api/cloud/desktop/authorize",
    "/api/cloud/desktop/approve", "/api/cloud/desktop/token", "/api/auth/sign-out",
  ]);
  assert.equal(f.accounts.requests[3].authorization.startsWith("Bearer session."), true);
  assert.ok(!JSON.stringify(f.states).includes(grant.accessToken), "the credential never reaches published state");
  assert.equal(f.accounts.requests[0].body.type, "sign-in");
});

test("a wrong code, an expired code, too many tries and a dead network each say what happened and change nothing", async t => {
  const f = await setup(t);
  await assert.rejects(() => f.signIn.verifyCode("person@example.test", "00000000"), { code: "wrong_code" });
  f.accounts.failVerify = { status: 400, body: { code: "OTP_EXPIRED" } };
  await assert.rejects(() => f.signIn.verifyCode("person@example.test", f.accounts.goodCode), { code: "expired_code" });
  f.accounts.failVerify = { status: 429, body: {} };
  await assert.rejects(() => f.signIn.verifyCode("person@example.test", f.accounts.goodCode), { code: "rate_limited" });
  f.accounts.failSend = { status: 503, body: { error: "email_unavailable" } };
  await assert.rejects(() => f.signIn.sendCode("person@example.test"), { code: "email_unavailable" });
  await assert.rejects(() => f.signIn.sendCode("nobody"), { code: "invalid_email" });
  await assert.rejects(() => f.signIn.verifyCode("person@example.test", "12"), { code: "wrong_code" });
  assert.equal(f.client.state().status, "signed-out");
  assert.equal(f.saved.value, null);
  const dead = createCloudSignIn({ origin: "http://127.0.0.1:1", deviceName: "Fixture Mac", platform: "darwin" });
  await assert.rejects(() => dead.sendCode("person@example.test"), error => error instanceof CloudSignInError && error.code === "network");
});

test("the device is only asked to be approved after the code was right, so a wrong code never uses a sign-in allowance", async t => {
  const f = await setup(t);
  await assert.rejects(() => f.signIn.verifyCode("person@example.test", "00000000"));
  assert.equal(f.accounts.requests.some(row => row.route.includes("/cloud/desktop/authorize")), false);
});

test("the account session is ended even when approving this Mac fails", async t => {
  const f = await setup(t);
  const failing = createCloudSignIn({ origin: f.accounts.origin, deviceName: "Fixture Mac", platform: "darwin",
    fetch: (url, init) => String(url).endsWith("/api/cloud/desktop/approve") ? Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })) : fetch(url, init) });
  await assert.rejects(() => failing.verifyCode("person@example.test", f.accounts.goodCode), { code: "unavailable" });
  assert.equal(f.accounts.sessions.size, 0);
  assert.equal(f.accounts.signedOut.length, 1);
});

test("a person who is already signed in on this Mac cannot be signed in again over their credential", async t => {
  const f = await setup(t);
  const first = await f.signIn.verifyCode("person@example.test", f.accounts.goodCode);
  await f.client.adopt(first);
  const second = await f.signIn.verifyCode("person@example.test", f.accounts.goodCode);
  await assert.rejects(() => f.client.adopt(second), /already signed in/);
  assert.equal(f.client.state().status, "connected");
  assert.equal(f.saved.value.token, first.accessToken);
});

test("an expired sign-in is replaced by signing in again with a code, with no browser", async t => {
  const f = await setup(t);
  const first = await f.signIn.verifyCode("person@example.test", f.accounts.goodCode);
  await f.client.adopt(first);
  f.accounts.tokens.clear();
  assert.equal((await f.client.refresh()).status, "reauth-required");
  const second = await f.signIn.verifyCode("person@example.test", f.accounts.goodCode);
  const state = await f.client.adopt(second);
  assert.equal(state.status, "connected");
  assert.equal(f.saved.value.token, second.accessToken);
});

test("a credential that does not look like Cloud's is refused and leaves the Mac signed out", async t => {
  const f = await setup(t);
  await assert.rejects(() => f.client.adopt({ cloudContractVersion: 1, accessToken: "not-a-token", expiresAt: Date.now() + 1e9, device: { id: "d" }, account: { id: "a", email: "a@b.test" } }));
  assert.equal(f.client.state().status, "signed-out");
  assert.equal(f.saved.value, null);
});
