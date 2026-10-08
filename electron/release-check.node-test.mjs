import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  LATEST_RELEASE_API,
  RELEASE_CHECK_DELAY_MS,
  RELEASE_CHECK_FAILED,
  RELEASE_CHECK_INTERVAL_MS,
  RELEASE_CHECK_TIMEOUT_MS,
  RELEASES_PAGE,
  compareVersions,
  createReleaseCheck,
  releaseCheckEnabled,
  releaseOffer,
  releaseTagVersion,
  rememberReleaseCheck,
  startReleaseCheck,
} from "./release-check.mjs";

const HOUR = 60 * 60 * 1000;
const PAGE = `${RELEASES_PAGE}/tag/v0.2.0`;

/** GitHub's latest-release answer, trimmed to what the check reads. */
const release = (tag, extra = {}) => ({ tag_name: tag, html_url: `${RELEASES_PAGE}/tag/${tag}`, draft: false, prerelease: false, ...extra });
const respond = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A release check at 0.1.2 on a fake clock, recording every request and
 * every state patch. `h.answer(url, init)` is what GitHub says. */
function harness(t, { on = true, currentVersion = "0.1.2", answer = () => respond(release("v0.1.2")) } = {}) {
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
  } catch (error) {
    if (error?.code !== "ERR_INVALID_STATE") throw error;
  }
  let clock = 1_000_000;
  const h = {
    answer,
    requests: [],
    states: [],
    saved: [],
    state: {},
    async tick(ms) {
      clock += ms;
      t.mock.timers.tick(ms);
      await settle();
    },
  };
  h.check = createReleaseCheck({
    currentVersion,
    setState: (patch) => {
      h.states.push(patch);
      h.state = { ...h.state, ...patch };
    },
    enabled: () => on,
    saveEnabled: (value) => {
      on = value;
      h.saved.push(value);
    },
    fetch: async (url, init) => {
      h.requests.push({ url, init, at: clock });
      return h.answer(url, init);
    },
    now: () => clock,
  });
  t.after(() => h.check.stop());
  return h;
}

test("versions compare in semver order: numbers as numbers, a prerelease before its release, build metadata ignored", () => {
  // semver.org §11's own chain, then the release line after it.
  const chain = [
    "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1",
    "1.0.0", "1.0.1", "1.0.10", "1.2.0", "1.10.0", "2.0.0",
  ];
  for (const [i, a] of chain.entries()) {
    for (const [j, b] of chain.entries()) assert.equal(Math.sign(compareVersions(a, b)), Math.sign(i - j), `${a} vs ${b}`);
  }
  assert.ok(compareVersions("0.1.10", "0.1.2") > 0, "not compared as text");
  assert.equal(compareVersions("1.0.0+build.9", "1.0.0"), 0);
  assert.ok(compareVersions("123456789012345678901.0.0", "123456789012345678900.0.0") > 0, "past what a double holds");
  for (const bad of ["1.2", "1.2.3.4", "01.2.3", "1.02.3", "v1.2.3", "1.2.3-", "1.2.3-01", " 1.2.3", "", "dev", null, undefined, 123]) {
    assert.equal(compareVersions(bad, "1.2.3"), null, String(bad));
    assert.equal(compareVersions("1.2.3", bad), null, String(bad));
  }
});

test("only a vX.Y.Z tag names a release; prerelease-looking and malformed tags are ignored", () => {
  assert.equal(releaseTagVersion("v0.2.0"), "0.2.0");
  assert.equal(releaseTagVersion("v10.20.30"), "10.20.30");
  for (const tag of ["0.2.0", "V0.2.0", "v0.2", "v0.2.0-preview.1", "v0.2.0-rc.1", "v0.2.0+build.1", "v01.2.0", " v0.2.0", "v0.2.0\n", "nightly", "", null, 2]) {
    assert.equal(releaseTagVersion(tag), null, JSON.stringify(tag));
  }
});

test("an answer offers only a plain release newer than this app, at this repository's page for it", () => {
  assert.deepEqual(releaseOffer(release("v0.2.0"), "0.1.2"), { version: "0.2.0", url: PAGE });
  assert.deepEqual(releaseOffer(release("v0.1.10"), "0.1.2"), { version: "0.1.10", url: `${RELEASES_PAGE}/tag/v0.1.10` });
  assert.equal(releaseOffer(release("v0.1.2"), "0.1.2"), null, "the same version");
  assert.equal(releaseOffer(release("v0.1.1"), "0.1.2"), null, "an older version");
  assert.equal(releaseOffer(release("v0.2.0-preview.1"), "0.1.2"), null, "a prerelease-looking tag");
  assert.equal(releaseOffer(release("v0.2.0", { prerelease: true }), "0.1.2"), null, "a prerelease");
  assert.equal(releaseOffer(release("v0.2.0", { draft: true }), "0.1.2"), null, "a draft");
  assert.equal(releaseOffer(release("nightly"), "0.1.2"), null, "a malformed tag");
  for (const answer of [null, undefined, "v0.2.0", [], {}, { message: "Not Found" }]) assert.equal(releaseOffer(answer, "0.1.2"), null, JSON.stringify(answer));
  assert.equal(releaseOffer(release("v0.2.0"), "dev"), null, "a version this app cannot compare");
  // A preview build hears about the release it previewed.
  assert.deepEqual(releaseOffer(release("v0.2.0"), "0.2.0-preview.1"), { version: "0.2.0", url: PAGE });
  // The download page is this repository's, whatever the answer names.
  for (const html_url of [
    "https://evil.example/woodbeary/later-dog/releases/tag/v0.2.0",
    "http://github.com/woodbeary/later-dog/releases/tag/v0.2.0",
    "https://github.com/someone-else/later-dog/releases/tag/v0.2.0",
    "https://user:secret@github.com/woodbeary/later-dog/releases/tag/v0.2.0",
    "https://github.com:8443/woodbeary/later-dog/releases/tag/v0.2.0",
    "javascript:alert(1)",
    "not a url",
    undefined,
  ]) {
    assert.equal(releaseOffer(release("v0.2.0", { html_url }), "0.1.2")?.url, PAGE, String(html_url));
  }
});

test("asks GitHub once a short while after launch, carrying nothing about the person", async (t) => {
  const h = harness(t);
  h.check.start();
  assert.deepEqual(h.state, { releaseCheck: "on" });
  await h.tick(RELEASE_CHECK_DELAY_MS - 1);
  assert.equal(h.requests.length, 0, "not while the app settles");
  await h.tick(1);
  assert.equal(h.requests.length, 1);
  const [{ url, init }] = h.requests;
  assert.equal(url, LATEST_RELEASE_API);
  assert.equal(init.method, "GET");
  assert.equal(init.credentials, "omit");
  assert.equal(init.body, undefined);
  // Only what GitHub's API asks of every caller; the User-Agent names the app, not its version.
  assert.deepEqual(init.headers, { accept: "application/vnd.github+json", "user-agent": "later.dog", "x-github-api-version": "2022-11-28" });
});

test("a newer release is offered; the same, an older or a prerelease-looking one is not", async (t) => {
  for (const [tag, offered] of [
    ["v0.2.0", { version: "0.2.0", url: PAGE }],
    ["v0.1.2", undefined],
    ["v0.1.1", undefined],
    ["v0.2.0-preview.1", undefined],
  ]) {
    const h = harness(t, { answer: () => respond(release(tag)) });
    h.check.start();
    await h.tick(RELEASE_CHECK_DELAY_MS);
    assert.equal(h.requests.length, 1, tag);
    assert.equal(h.state.status, "idle", tag);
    assert.deepEqual(h.state.available, offered, tag);
    h.check.stop();
  }

  // A release withdrawn later is no longer offered.
  const h = harness(t, { answer: () => respond(release("v0.2.0")) });
  h.check.start();
  await h.tick(RELEASE_CHECK_DELAY_MS);
  assert.deepEqual(h.state.available, { version: "0.2.0", url: PAGE });
  h.answer = () => respond(release("v0.1.2"));
  await h.tick(RELEASE_CHECK_INTERVAL_MS);
  assert.equal(h.state.available, undefined);
});

test("offline, rate-limited or unreadable: nothing is shown, and the next interval tries again", async (t) => {
  const failures = {
    offline: () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })),
    "rate-limited (403)": () => respond({ message: "API rate limit exceeded" }, 403),
    "rate-limited (429)": () => respond({}, 429),
    "server error": () => respond({}, 502),
    "no release yet (404)": () => respond({ message: "Not Found" }, 404),
    "malformed JSON": () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token '<'"); } }),
  };
  for (const [name, fail] of Object.entries(failures)) {
    const h = harness(t, { answer: fail });
    h.check.start();
    await h.tick(RELEASE_CHECK_DELAY_MS);
    assert.equal(h.requests.length, 1, name);
    assert.deepEqual(h.states, [{ releaseCheck: "on" }], `${name}: the update UI hears nothing`);
    h.answer = () => respond(release("v0.2.0"));
    await h.tick(RELEASE_CHECK_INTERVAL_MS);
    assert.equal(h.requests.length, 2, `${name}: tried again at the next interval`);
    assert.deepEqual(h.state.available, { version: "0.2.0", url: PAGE }, name);
    h.check.stop();
  }
});

test("a request that never answers is given up quietly and does not hold off the next check", async (t) => {
  const h = harness(t, {
    answer: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
  });
  h.check.start();
  await h.tick(RELEASE_CHECK_DELAY_MS);
  assert.equal(h.requests.length, 1);
  await h.tick(RELEASE_CHECK_TIMEOUT_MS);
  assert.equal(h.requests[0].init.signal.aborted, true);
  assert.deepEqual(h.states, [{ releaseCheck: "on" }]);
  h.answer = () => respond(release("v0.2.0"));
  await h.tick(RELEASE_CHECK_INTERVAL_MS - RELEASE_CHECK_TIMEOUT_MS);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.state.available, { version: "0.2.0", url: PAGE });
});

test("checks at most every 12 hours, the person's own checks included", async (t) => {
  const h = harness(t);
  h.check.start();
  await h.tick(RELEASE_CHECK_DELAY_MS);
  await h.tick(RELEASE_CHECK_INTERVAL_MS - 1);
  assert.equal(h.requests.length, 1);
  await h.tick(1);
  assert.equal(h.requests.length, 2, "12 hours after the first");

  // The person checks 6 hours later: the timer's next request waits 12 hours from theirs.
  await h.tick(6 * HOUR);
  await h.check.check(true);
  assert.equal(h.requests.length, 3);
  await h.tick(12 * HOUR - 1);
  assert.equal(h.requests.length, 3);
  await h.tick(1);
  assert.equal(h.requests.length, 4);

  // Three more days, a step at a time (a mock tick runs a timer once): two a day.
  for (let step = 0; step < 6 * 12; step += 1) await h.tick(HOUR);
  const times = h.requests.map((request) => request.at);
  assert.equal(times.length, 4 + 6);
  for (let index = 1; index < times.length; index += 1) {
    const apart = times[index] - times[index - 1];
    // The person's own check (the third) came 6 hours after the timer's second.
    assert.ok(apart >= (index === 2 ? 6 * HOUR : RELEASE_CHECK_INTERVAL_MS), `request ${index + 1} came ${apart / HOUR} h after the one before`);
  }
});

test("off means no request at all, the person's check included; on asks at once", async (t) => {
  const h = harness(t, { on: false, answer: () => respond(release("v0.2.0")) });
  h.check.start();
  assert.deepEqual(h.state, { releaseCheck: "off" });
  await h.tick(RELEASE_CHECK_DELAY_MS);
  await h.tick(3 * 24 * HOUR);
  await h.check.check(true);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.states, [{ releaseCheck: "off" }], "not even a passing \"checking\"");

  assert.equal(h.check.setEnabled(true), true);
  assert.deepEqual(h.saved, [true]);
  await h.tick(0);
  assert.equal(h.requests.length, 1, "switched on: asks at once");
  assert.equal(h.state.releaseCheck, "on");
  assert.deepEqual(h.state.available, { version: "0.2.0", url: PAGE });

  // Off again: the offer comes down, and nothing more is asked.
  assert.equal(h.check.setEnabled(false), false);
  assert.deepEqual(h.saved, [true, false]);
  assert.deepEqual({ ...h.state }, { releaseCheck: "off", status: "idle", available: undefined, message: undefined });
  await h.tick(3 * 24 * HOUR);
  await h.check.check(true);
  assert.equal(h.requests.length, 1);

  // On again within 12 hours of the last request: the spacing holds.
  const quick = harness(t, { answer: () => respond(release("v0.1.2")) });
  quick.check.start();
  await quick.tick(RELEASE_CHECK_DELAY_MS);
  quick.check.setEnabled(false);
  quick.check.setEnabled(true);
  await quick.tick(0);
  assert.equal(quick.requests.length, 1);
});

test("switched off while a request is out: it is cancelled and its answer never shown", async (t) => {
  let finish;
  const h = harness(t, { answer: () => new Promise((resolve) => { finish = resolve; }) });
  h.check.start();
  await h.tick(RELEASE_CHECK_DELAY_MS);
  assert.equal(h.requests.length, 1);
  h.check.setEnabled(false);
  assert.equal(h.requests[0].init.signal.aborted, true);
  finish(respond(release("v0.2.0")));
  await settle();
  assert.equal(h.state.available, undefined);
  assert.equal(h.state.releaseCheck, "off");
});

test("the person's check shows checking, and says when it failed; the timer's never does", async (t) => {
  const h = harness(t, { answer: () => respond({}, 403) });
  h.check.start();
  await h.check.check(true);
  assert.deepEqual(h.states.slice(1), [{ status: "checking" }, { status: "error", message: RELEASE_CHECK_FAILED }]);
  // GitHub answers again: the result replaces the failure.
  h.answer = () => respond(release("v0.1.2"));
  await h.check.check(true);
  assert.equal(h.state.status, "idle");
  assert.equal(h.state.available, undefined);

  // The person asks while the timer's request is out: one request, and its failure is theirs to see.
  let fail;
  const shared = harness(t, { answer: () => new Promise((_resolve, reject) => { fail = reject; }) });
  shared.check.start();
  await shared.tick(RELEASE_CHECK_DELAY_MS);
  const asked = shared.check.check(true);
  assert.equal(shared.requests.length, 1);
  assert.equal(shared.state.status, "checking");
  fail(new TypeError("fetch failed"));
  await asked;
  assert.deepEqual(shared.state, { releaseCheck: "on", status: "error", message: RELEASE_CHECK_FAILED });

  // A failure while a newer release is on offer leaves the offer up.
  const offered = harness(t, { answer: () => respond(release("v0.2.0")) });
  offered.check.start();
  await offered.check.check(true);
  offered.answer = () => Promise.reject(new TypeError("fetch failed"));
  await offered.check.check(true);
  assert.equal(offered.state.status, "idle");
  assert.deepEqual(offered.state.available, { version: "0.2.0", url: PAGE });
});

test("the switch is remembered in userData, on until switched off", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "laterdog-release-check-"));
  try {
    assert.equal(releaseCheckEnabled(dir), true);
    rememberReleaseCheck(dir, false);
    assert.equal(releaseCheckEnabled(dir), false);
    rememberReleaseCheck(dir, true);
    assert.equal(releaseCheckEnabled(dir), true);
    writeFileSync(join(dir, "release-check.json"), "{ not json");
    assert.equal(releaseCheckEnabled(dir), true);

    // Started from a saved "off": nothing is asked, and switching on is saved.
    rememberReleaseCheck(dir, false);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fetch = t.mock.method(globalThis, "fetch", async () => respond(release("v0.1.2")));
    const states = [];
    const check = startReleaseCheck({ userData: dir, currentVersion: "0.1.2", setState: (patch) => states.push(patch), log: () => {} });
    t.after(() => check.stop());
    t.mock.timers.tick(RELEASE_CHECK_DELAY_MS + RELEASE_CHECK_INTERVAL_MS);
    await check.check(true);
    assert.equal(fetch.mock.callCount(), 0);
    assert.deepEqual(states, [{ releaseCheck: "off" }]);
    check.setEnabled(true);
    assert.equal(releaseCheckEnabled(dir), true);
    await settle();
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
