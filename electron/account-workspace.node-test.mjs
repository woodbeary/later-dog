import assert from "node:assert/strict";
import test from "node:test";
import { createAccountWorkspace } from "./account-workspace.mjs";

const installationId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const clientInstanceId = "33333333-3333-4333-8333-333333333333";
const credential = `laterdog_install_${"a".repeat(22)}.${"b".repeat(43)}`;
const pairing = `laterdog_pair_${"c".repeat(43)}`;
const origin = "https://c-fixture.later.dog";

function fixture(t, overrides = {}) {
  const f = { now: 1_800_000_000_000, document: {}, state: { status: "connected", account: { id: "account-a" }, deviceId: "device-a" },
    heartbeats: [], enrollments: [], provisions: [], stops: 0, opened: 0, closed: [], bound: true, ready: true, enabled: true,
    request: null, manual: false, window: false, timer: null, failCompletion: false, revoked: 0 };
  const account = {
    state: () => f.state,
    workspaceInstallation: async body => {
      f.enrollments.push(body);
      return { installation: { id: installationId }, credential, credentialExpiresAt: f.now + 86_400_000 };
    },
    workspaceHeartbeat: async body => {
      f.heartbeats.push(structuredClone(body));
      if (body.pairing && f.failCompletion) throw new Error("lost response");
      return { bound: f.bound, ...(f.request ? { request: f.request } : {}) };
    },
  };
  f.account = account;
  f.bridge = createAccountWorkspace({
    account: () => account,
    controlPlane: { ensureEndpoint: async value => {
      f.provisions.push(value);
      return { endpoint: { url: origin }, connectorToken: "d".repeat(60) };
    } },
    readCredentials: () => f.document,
    updateCredentials: async derive => { f.document = derive(f.document); },
    identity: { name: "Fixture Mac", platform: "darwin", appVersion: "0.3.fixture" },
    startCompanion: async () => {}, stopEndpoint: async () => { f.stops++; },
    companionState: async () => ({ enabled: f.enabled, accountPairingActive: f.window }),
    connectionState: () => ({ ready: f.ready, url: origin }),
    openPairing: async () => {
      f.opened++;
      if (f.manual || f.window) return { opened: false };
      f.window = true;
      return { opened: true, credential: pairing, expiresAt: f.now + 120_000 };
    },
    closePairing: async token => { f.closed.push(token); f.window = false; },
    revokeAccountDevices: async () => { f.revoked++; },
    now: () => f.now, newId: () => clientInstanceId,
    setTimer: callback => { f.timer = callback; return 1; }, clearTimer: () => { f.timer = null; },
    ...overrides,
  });
  t.after(() => f.bridge.close());
  return f;
}

test("existing account sign-in enrolls once, starts its companion and reports only verified readiness", async t => {
  const f = fixture(t);
  await f.bridge.refresh();
  assert.deepEqual(f.enrollments, [{ clientInstanceId, name: "Fixture Mac", platform: "darwin", appVersion: "0.3.fixture" }]);
  assert.deepEqual(f.provisions, [credential]);
  assert.equal(f.document.accountWorkspace.credential, credential);
  assert.deepEqual(f.heartbeats.map(row => row.ready), [false, true]);
  await f.bridge.refresh();
  assert.equal(f.enrollments.length, 1);
  assert.equal(f.provisions.length, 1);
  f.ready = false;
  await f.bridge.refresh();
  assert.equal(f.heartbeats.at(-1).ready, false);
  assert.equal(f.opened, 0);
});

test("pending requests receive a short opaque grant and a lost completion response reuses that grant", async t => {
  const f = fixture(t);
  f.request = { id: requestId, label: "Fixture phone", expiresAt: f.now + 90_000 };
  f.failCompletion = true;
  await f.bridge.refresh();
  assert.equal(f.opened, 1);
  assert.deepEqual(f.heartbeats.at(-1).pairing, { requestId, credential: pairing, expiresAt: f.now + 90_000 });
  f.failCompletion = false;
  await f.bridge.refresh();
  assert.equal(f.opened, 1);
  assert.equal(f.heartbeats.at(-1).pairing.credential, pairing);
  assert.ok(!JSON.stringify(f.heartbeats).includes(credential));
});

test("a manual pairing window is preserved and offline transport never opens an account grant", async t => {
  const f = fixture(t);
  f.request = { id: requestId, label: "Fixture phone", expiresAt: f.now + 90_000 };
  f.manual = true;
  await f.bridge.refresh();
  assert.equal(f.opened, 1);
  assert.equal(f.heartbeats.some(row => row.pairing), false);
  assert.deepEqual(f.closed, []);
  f.manual = false;
  f.ready = false;
  await f.bridge.refresh();
  assert.equal(f.opened, 1);
});

test("another bound Mac stops before provisioning a tunnel or opening pairing", async t => {
  const f = fixture(t);
  f.bound = false;
  await f.bridge.refresh();
  assert.deepEqual(f.provisions, []);
  assert.equal(f.opened, 0);
  assert.equal(f.heartbeats.at(-1).ready, false);
});

test("sign-out closes only its account grant, stops the endpoint and clears its tunnel credentials", async t => {
  const f = fixture(t);
  f.request = { id: requestId, label: "Fixture phone", expiresAt: f.now + 90_000 };
  await f.bridge.refresh();
  f.state = { status: "signed-out" };
  await f.bridge.changed();
  assert.equal(f.stops, 1);
  assert.equal(f.revoked, 1);
  assert.deepEqual(f.closed, [pairing]);
  assert.equal(f.document.managedCompanionConnectorToken, undefined);
  assert.equal(f.timer, null);
});

test("sign-out while enrollment is in flight cannot install the old account's credential or tunnel", async t => {
  const f = fixture(t);
  let finish;
  f.account.workspaceInstallation = () => new Promise(resolve => { finish = resolve; });
  const pending = f.bridge.refresh();
  while (!finish) await Promise.resolve();
  f.state = { status: "signed-out" };
  void f.bridge.changed();
  finish({ installation: { id: installationId }, credential, credentialExpiresAt: f.now + 86_400_000 });
  await pending;
  assert.equal(f.document.accountWorkspace.credential, undefined);
  assert.deepEqual(f.provisions, []);
  assert.equal(f.opened, 0);
});

test("endpoint setup failure keeps a bound workspace offline and backs off provisioning", async t => {
  let attempts = 0;
  const f = fixture(t, { controlPlane: { ensureEndpoint: async () => { attempts++; throw new Error("endpoint unavailable"); } } });
  await f.bridge.refresh();
  await f.bridge.refresh();
  assert.equal(attempts, 1);
  assert.ok(f.heartbeats.every(row => row.ready === false));
  assert.equal(f.enrollments.length, 1);
});

test("a saved tunnel is replaced by the enrolled installation's verified endpoint once per launch", async t => {
  const f = fixture(t);
  f.document = {
    accountWorkspace: { clientInstanceId, accountId: "account-a", deviceId: "device-a", installationId, credential, expiresAt: f.now + 86_400_000 },
    managedCompanionEndpointUrl: "https://c-other.later.dog", managedCompanionConnectorToken: "e".repeat(60), managedCompanionOriginVersion: 2,
  };
  await f.bridge.refresh();
  assert.equal(f.enrollments.length, 0);
  assert.deepEqual(f.provisions, [credential]);
  assert.equal(f.document.managedCompanionEndpointUrl, origin);
  await f.bridge.refresh();
  assert.equal(f.provisions.length, 1);
});

test("failure status never contains a service's unrecognized message or credential", async t => {
  const statuses = [];
  const f = fixture(t, { onStatus: value => statuses.push(value), controlPlane: { ensureEndpoint: async () => {
    throw Object.assign(new Error(credential), { code: credential });
  } } });
  await f.bridge.refresh();
  assert.deepEqual(statuses, ["workspace_unavailable"]);
});

test("failed account-phone revocation blocks the next account's endpoint until its durable retry succeeds", async t => {
  let fail = true, revoked = 0;
  const f = fixture(t, { revokeAccountDevices: async () => { revoked++; if (fail) throw new Error("fixture storage failure"); } });
  await f.bridge.refresh();
  f.state = { status: "signed-out" };
  await f.bridge.changed();
  assert.equal(f.document.accountWorkspace.revokePending, true);
  assert.equal(f.document.managedCompanionConnectorToken, undefined);
  f.state = { status: "connected", account: { id: "account-b" }, deviceId: "device-b" };
  await f.bridge.changed();
  assert.equal(f.enrollments.length, 1);
  fail = false;
  await f.bridge.refresh();
  assert.equal(revoked, 3);
  assert.equal(f.document.accountWorkspace.accountId, "account-b");
  assert.equal(f.enrollments.length, 2);
});

test("a revoked backend device refreshes account identity and removes its paired phones immediately", async t => {
  const f = fixture(t);
  await f.bridge.refresh();
  f.account.workspaceHeartbeat = async () => { throw Object.assign(new Error("invalid token"), { code: "invalid_token", status: 401 }); };
  f.account.refresh = async () => {
    f.state = { status: "reauth-required", account: { id: "account-a" }, deviceId: "device-a" };
    void f.bridge.changed();
  };
  await f.bridge.refresh();
  assert.equal(f.revoked, 1);
  assert.equal(f.document.managedCompanionConnectorToken, undefined);
});
