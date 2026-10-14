import assert from "node:assert/strict";
import test from "node:test";
import { createCloudOffer, enterHomeNow, hasCloudAccount, leaveHomeNow, parseOffer, readyHome, showsServerMenu } from "./cloud-default-home.mjs";

const HOME = "https://home.fixture.test";
const connected = (machine = { status: "ready", origin: HOME }) => ({ status: "connected", account: { id: "a", email: "a@b.test" }, machine });

test("only a signed-in person whose home is ready has a home to open", () => {
  assert.deepEqual(readyHome(connected()), { origin: HOME });
  for (const state of [null, { status: "signed-out" }, connected({ status: "provisioning", origin: HOME }), connected(null), { ...connected(), status: "unavailable" }]) assert.equal(readyHome(state), null);
});

test("the window opens the home once per home, never again after the person was sent back, and never when it is already showing it", () => {
  assert.equal(enterHomeNow({ state: connected(), activeOrigin: "http://127.0.0.1:8799", enteredOrigin: null }), true);
  assert.equal(enterHomeNow({ state: connected(), activeOrigin: HOME, enteredOrigin: null }), false);
  assert.equal(enterHomeNow({ state: connected(), activeOrigin: "http://127.0.0.1:8799", enteredOrigin: HOME }), false);
  assert.equal(enterHomeNow({ state: connected(), activeOrigin: "http://127.0.0.1:8799", enteredOrigin: "https://old.fixture.test" }), true);
  assert.equal(enterHomeNow({ state: connected({ status: "provisioning", origin: HOME }), activeOrigin: "x", enteredOrigin: null }), false);
});

test("signing out leaves the home for this Mac, but the quiet start-up state does not", () => {
  const entry = { id: "cloud-1" };
  assert.equal(leaveHomeNow({ state: { status: "signed-out" }, homeEntry: entry, environments: { activeId: "cloud-1" } }), true);
  assert.equal(leaveHomeNow({ state: { status: "signed-out", message: "restoring" }, homeEntry: entry, environments: { activeId: "cloud-1" } }), false);
  assert.equal(leaveHomeNow({ state: { status: "signed-out" }, homeEntry: entry, environments: { activeId: "local" } }), false);
  assert.equal(leaveHomeNow({ state: connected(), homeEntry: entry, environments: { activeId: "cloud-1" } }), false);
  assert.equal(leaveHomeNow({ state: { status: "reauth-required", account: { id: "a" } }, homeEntry: entry, environments: { activeId: "cloud-1" } }), false);
});

test("a signed-in person sees no Server menu, and a signed-out person sees what they always saw", () => {
  assert.equal(showsServerMenu({ status: "signed-out" }), true);
  assert.equal(showsServerMenu(null), true);
  for (const state of [connected(), { status: "unavailable", account: { id: "a" } }, { status: "reauth-required", account: { id: "a" } }]) assert.equal(showsServerMenu(state), false);
  assert.equal(hasCloudAccount({ status: "connecting" }), false);
});

test("the sign-in screen is offered once: a Mac that said not now, or signed in, is never asked again", () => {
  const files = { value: null };
  const offer = createCloudOffer({ read: () => files.value, write: contents => { files.value = contents; }, now: () => 1_800_000_000_000 });
  assert.equal(offer.due(), true);
  offer.decline();
  assert.equal(offer.due(), false);
  assert.deepEqual(parseOffer(files.value), { answeredAt: 1_800_000_000_000, answer: "not-now" });
  offer.signedIn();
  assert.equal(parseOffer(files.value).answer, "signed-in");
  assert.equal(offer.due(), false);
  assert.equal(parseOffer("garbage"), null);
  const unreadable = createCloudOffer({ read: () => { throw new Error("no file"); }, write() {} });
  assert.equal(unreadable.due(), true);
});
