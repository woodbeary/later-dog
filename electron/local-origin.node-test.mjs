import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lo = require("./local-origin.cjs");

const from = (url) => ({ senderFrame: { url }, sender: { getURL: () => url } });

test("nothing is local until the origin is known, then only that origin is", () => {
  lo.setLocalOrigin(null);
  assert.equal(lo.isLocalSender(from("http://127.0.0.1:8799/")), false);
  lo.setLocalOrigin("http://127.0.0.1:8799");
  assert.equal(lo.isLocalSender(from("http://127.0.0.1:8799/chat?x=1")), true);
  assert.equal(lo.isLocalSender(from("https://mini.example/")), false);
  assert.equal(lo.isLocalSender(from("http://127.0.0.1:8800/")), false);
  assert.equal(lo.isLocalSender(from("about:blank")), false);
  assert.equal(lo.isLocalSender({ sender: { getURL: () => "http://127.0.0.1:8799/" } }), true);
  assert.equal(lo.isLocalSender({}), false);
});

test("a local native main frame remains local while its frame URL is briefly empty", () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const mainFrame = { url: "" };
  const event = {
    senderFrame: mainFrame,
    sender: {
      mainFrame,
      getURL: () => "http://127.0.0.1:8799/?desktop-settings=organization",
    },
  };
  assert.equal(lo.senderOrigin(event), "http://127.0.0.1:8799");
  assert.equal(lo.isLocalSender(event), true);
});

test("an empty child frame never inherits the native main frame's local origin", () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const event = {
    senderFrame: { url: "" },
    sender: {
      mainFrame: { url: "http://127.0.0.1:8799/" },
      getURL: () => "http://127.0.0.1:8799/",
    },
  };
  assert.equal(lo.senderOrigin(event), null);
  assert.equal(lo.isLocalSender(event), false);
});

test("localOnly answers the local page and refuses a remote one by name", async () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  const handler = lo.localOnly("screen:frame", async (_event, x) => `frame:${x}`);
  assert.equal(await handler(from("http://127.0.0.1:8799/"), 1), "frame:1");
  assert.throws(() => handler(from("https://mini.example/"), 1), /screen:frame is only available while using the local server/);
  const sync = lo.localOnlySync("screen:preview-intent", (event) => { event.returnValue = "ok"; });
  const remote = from("https://mini.example/");
  sync(remote);
  assert.equal(remote.returnValue, false);
  const local = from("http://127.0.0.1:8799/");
  sync(local);
  assert.equal(local.returnValue, "ok");

  const openExternal = lo.localOnly("desktop:open-external", async (_event, url) => `opened:${url}`);
  assert.equal(await openExternal(local, "https://example.com"), "opened:https://example.com");
  assert.throws(
    () => openExternal(remote, "https://example.com"),
    /desktop:open-external is only available while using the local server/,
  );
});

test("the open profile's page reaches only the desktop features a profile may use", async () => {
  lo.setLocalOrigin("http://127.0.0.1:8799");
  let open = "http://127.0.0.1:8811";
  lo.setProfileOrigin(() => open);
  const profile = from("http://127.0.0.1:8811/chat");
  const other = from("http://127.0.0.1:8813/");
  assert.equal(lo.isProfileSender(profile), true);
  assert.equal(lo.isLocalSender(profile), false);
  assert.equal(lo.isProfileSender(other), false);
  const speech = lo.localOnly("speech:start", async () => "listening");
  assert.equal(await speech(profile), "listening");
  assert.throws(() => speech(other), /speech:start is only available/);
  const companion = lo.localOnly("companion:start", async () => "started");
  assert.throws(() => companion(profile), /companion:start is only available/);
  const preview = lo.localOnlySync("screen:preview-intent", (event) => { event.returnValue = "ok"; });
  preview(profile);
  assert.equal(profile.returnValue, "ok");
  const wake = lo.localOnlySync("routines:wake-state", (event) => { event.returnValue = "ok"; });
  const asking = from("http://127.0.0.1:8811/");
  wake(asking);
  assert.equal(asking.returnValue, false);
  open = null;
  assert.throws(() => speech(profile), /speech:start is only available/);
  lo.setProfileOrigin(() => {
    throw new Error("not ready");
  });
  assert.equal(lo.isProfileSender(profile), false);
  lo.setProfileOrigin(null);
  assert.equal(lo.isProfileSender(profile), false);
});

test("profile pages get no Cloud, Companion, sharing, backups or viewer channels", () => {
  for (const channel of lo.PROFILE_CHANNELS) {
    assert.doesNotMatch(channel, /^(cloud|companion|sharing|company-backups|organization|desktop-viewer|desktop-workspace|desktop-remote|routines|environments|cua):/);
  }
});
