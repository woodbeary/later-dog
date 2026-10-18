import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { pageCapabilities, windowPage } from "./page-capabilities.mjs";

const require = createRequire(import.meta.url);
const { desktopCapabilities } = require("./capabilities.cjs");

const LOCAL = "http://127.0.0.1:48995";
const HOME = "https://laterdog-t-0123456789ab.fly.dev";
const OTHER = "https://someone-else.example";

const contentsAt = (url) => {
  const contents = { getURL: () => url };
  contents.mainFrame = { url };
  return contents;
};
const originOf = (page) => new URL(page.senderFrame.url).origin;
const options = {
  isLocal: (page) => originOf(page) === LOCAL,
  isCloudPage: (page) => originOf(page) === HOME,
  computerName: async (page) => (originOf(page) === OTHER ? null : "Jacob's Mac"),
  build: (forPage) => desktopCapabilities({
    ...forPage,
    platform: "darwin",
    env: {},
    packaged: true,
    localConnection: { status: "ready", enabled: true },
  }),
};

test("a capabilities change keeps the Cloud home page's dictation from this Mac", async () => {
  const home = await pageCapabilities(windowPage(contentsAt(`${HOME}/chat/rex`)), options);
  assert.equal(home.dictation.available, true);
  assert.equal(home.host.name, "Jacob's Mac");
});

test("any other remote page still gets no dictation", async () => {
  const other = await pageCapabilities(windowPage(contentsAt(`${OTHER}/`)), options);
  assert.equal(other.dictation.available, false);
  assert.equal(other.dictation.reasonCode, "remote-server");
});

test("this Mac's own page keeps local dictation", async () => {
  const local = await pageCapabilities(windowPage(contentsAt(`${LOCAL}/`)), options);
  assert.equal(local.dictation.available, true);
});

test("a window page reads its main frame like an IPC sender does", () => {
  const contents = contentsAt(HOME);
  assert.deepEqual(windowPage(contents), { sender: contents, senderFrame: contents.mainFrame });
});
