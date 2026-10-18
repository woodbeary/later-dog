import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { speechSender, stopSpeechWhenPageLeaves } from "./speech-sender.mjs";

const LOCAL = "http://127.0.0.1:48995";
const HOME = "https://laterdog-t-0123456789ab.fly.dev";
const OTHER = "https://someone-else.example";

test("speech runs for this Mac's page and the person's Cloud home page, and refuses any other page", () => {
  const calls = [];
  const start = speechSender("speech:start", (event, options) => {
    calls.push([event.origin, options]);
    return "listening";
  }, {
    isLocal: (event) => event.origin === LOCAL,
    isCloudPage: (event) => event.origin === HOME,
  });
  assert.equal(start({ origin: LOCAL }, { endpointMs: 850 }), "listening");
  assert.equal(start({ origin: HOME }), "listening");
  assert.throws(() => start({ origin: OTHER }), /speech:start is only available in this app's window/);
  assert.deepEqual(calls, [[LOCAL, { endpointMs: 850 }], [HOME, undefined]]);
});

test("main lets every speech channel through the speech sender, never a looser guard", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  for (const channel of ["speech:start", "speech:stop", "speech:audio", "speech:finish"]) {
    assert.ok(main.includes(`ipcMain.handle("${channel}", speechPage("${channel}", `), channel);
  }
  assert.match(main, /isCloudPage: \(asking\) => cloudPageAsking\(asking\) === "cloud"/);
  assert.match(main, /ipcMain\.handle\("desktop:capabilities", \(event\) => capabilitiesFor\(event, senderIsLocal\)\)/);
  assert.match(main, /capabilitiesFor\(windowPage\(window\.webContents\), windowIsLocal\)/);
  assert.equal(main.match(/desktop:capabilities-changed/g)?.length, 1);
});

test("dictation stops when the page that started it navigates to another document", () => {
  const listeners = [];
  const contents = { on: (name, listener) => listeners.push([name, listener]) };
  let stops = 0;
  const stop = () => { stops += 1; };
  stopSpeechWhenPageLeaves(contents, stop);
  stopSpeechWhenPageLeaves(contents, stop);
  assert.equal(listeners.length, 1);
  const [name, leave] = listeners[0];
  assert.equal(name, "did-start-navigation");
  leave({ isMainFrame: true, isSameDocument: true });
  leave({ isMainFrame: false, isSameDocument: false });
  assert.equal(stops, 0);
  leave({ isMainFrame: true, isSameDocument: false });
  assert.equal(stops, 1);
  leave({}, "https://other.example", false, true);
  assert.equal(stops, 2);
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /stopSpeechWhenPageLeaves\(win\.webContents, stopSpeech\);\n  startSpeech\(/);
});

test("a remote page gets the speech bridge but still not permissions or local controls", () => {
  const preload = readFileSync(new URL("./preload.cjs", import.meta.url), "utf8");
  let bridge;
  runInNewContext(preload, {
    process: { platform: "darwin", argv: [`--laterdog-local-origin=${LOCAL}`] },
    location: { origin: HOME },
    TextEncoder,
    localStorage: { getItem: () => null },
    queueMicrotask,
    require: () => ({
      webUtils: {},
      contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, sendSync: () => false, invoke: async () => undefined },
    }),
  });
  for (const key of ["speechStart", "speechStop", "speechFinish", "speechAudio", "onSpeechTranscript", "onSpeechEnd"]) {
    assert.equal(typeof bridge[key], "function", key);
  }
  for (const key of ["permissions", "localControl", "screenFrame", "copyText"]) {
    assert.equal(key in bridge, false, key);
  }
});
