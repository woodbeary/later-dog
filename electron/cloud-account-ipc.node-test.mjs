import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import localOrigin from "./local-origin.cjs";
import environments from "./environments.cjs";

const origin = "http://127.0.0.1:48993", methods = ["state", "begin", "signInAgain", "reopen", "cancel", "refresh", "signOut", "openDashboard"];
const bridgeMethods = [...methods, "connectHome", "connectHomeForPhone"];
const codeMethods = ["sendCode", "verifyCode", "offer", "declineOffer"];
function preload({ enabled = true, remote = false } = {}) {
  let bridge; const invoked = [];
  vm.runInNewContext(readFileSync(new URL("./preload.cjs", import.meta.url), "utf8"), {
    process: { platform: "fixture", argv: [`--laterdog-local-origin=${origin}`, ...(enabled ? ["--laterdog-company-desktop=1", "--laterdog-cloud-account=1"] : [])] },
    location: { origin: remote ? "https://remote.example.test" : origin }, TextEncoder, localStorage: { getItem: () => null },
    require: () => ({ webUtils: {}, contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { on() {}, removeListener() {}, send() {}, invoke: (...args) => { invoked.push(args); return Promise.resolve({ status: "signed-out" }); } } }),
  });
  return { bridge, invoked };
}
test("personal Cloud bridge is desktop-local, contains no capability access, and discards all renderer arguments", async () => {
  const f = preload();
  for (const method of bridgeMethods) await f.bridge.cloudAccount[method]({ origin: "https://evil.example.test", paid: true, accessToken: "forged", code: "ABCD-EFGH-JKLM" });
  assert.deepEqual(f.invoked, bridgeMethods.map(method => [`cloud-account:${method}`]));
  assert.equal(f.bridge.cloudAccount.connection, undefined);
  const before = f.invoked.length;
  await f.bridge.cloudAccount.sendCode("person@example.test", { origin: "https://evil.example.test" });
  await f.bridge.cloudAccount.verifyCode("person@example.test", "12345678", { paid: true });
  await f.bridge.cloudAccount.sendCode({ toString: () => "not a string" });
  await f.bridge.cloudAccount.offer({ due: false });
  await f.bridge.cloudAccount.declineOffer({ origin: "x" });
  assert.deepEqual(f.invoked.slice(before), [["cloud-account:sendCode", "person@example.test"], ["cloud-account:verifyCode", "person@example.test", "12345678"],
    ["cloud-account:sendCode", ""], ["cloud-account:offer"], ["cloud-account:declineOffer"]], "only an email and a code can be passed through, and only as text");
  assert.equal(codeMethods.every(method => typeof f.bridge.cloudAccount[method] === "function"), true);
  assert.equal(preload({ enabled: false }).bridge.cloudAccount, undefined);
  assert.equal(preload({ remote: true }).bridge.cloudAccount, undefined);
});
test("production personal Cloud IPC guards exact local main frame and forwards no arguments", async () => {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8"), start = source.indexOf("const workspaceOnly ="), end = source.indexOf('ipcMain.handle("organization:settings-opened"', start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map(), calls = [], frame = { url: `${origin}/` }, contents = { mainFrame: frame };
  localOrigin.setLocalOrigin(origin);
  const context = vm.createContext({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    localOnly: localOrigin.localOnly, workspaceSenderAllowed: environments.workspaceSenderAllowed, mainWindow: { webContents: contents },
    rendererOrigin: () => origin, localPageOrigin: () => origin, environmentsState: { environments: [], activeId: "local" },
    ensureCloudAccount: () => Object.fromEntries(methods.map(method => [method, (...args) => { calls.push([method, ...args]); return { status: "signed-out" }; }])),
    connectCloudHome: (...args) => { calls.push(["connectHome", ...args]); return { status: "connected" }; },
    cloudAccountView: state => state,
    cloudSignInOutcome: async work => { try { return { ok: true, ...(await work()) }; } catch { return { ok: false, code: "unavailable" }; } },
    ensureCloudSignIn: () => ({ sendCode: async email => { calls.push(["sendCode", email]); return email; }, verifyCode: async (email, code) => { calls.push(["verifyCode", email, code]); return { grant: true }; } }),
    CloudSignInError: class extends Error {},
    cloudOfferState: () => ({ due: () => true, decline: () => calls.push(["decline"]) }),
    cloudAccount: null,
  });
  vm.runInContext(source.slice(start, end), context);
  for (const method of bridgeMethods) {
    const handle = handlers.get(`cloud-account:${method}`);
    await handle({ sender: contents, senderFrame: frame }, { paid: true });
    for (const sender of [{ sender: contents, senderFrame: { url: `${origin}/subframe` } }, { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: "https://remote.example.test" } }, { sender: contents }]) assert.throws(() => handle(sender), /only available/);
  }
  assert.deepEqual(calls, bridgeMethods.map(method => method === "connectHomeForPhone" ? ["connectHome", "phone"] : [method]));
  calls.length = 0;
  const send = handlers.get("cloud-account:sendCode"), verify = handlers.get("cloud-account:verifyCode"), offer = handlers.get("cloud-account:offer"), decline = handlers.get("cloud-account:declineOffer");
  const local = { sender: contents, senderFrame: frame };
  const plain = value => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(await send(local, "person@example.test")), { ok: true, email: "person@example.test" });
  assert.deepEqual(plain(await verify(local, "person@example.test", "12345678")), { ok: false, code: "unavailable" }, "a Mac that cannot adopt the credential reports a plain failure");
  assert.deepEqual(plain(await offer(local)), { due: true });
  assert.deepEqual(plain(await decline(local)), { due: false });
  for (const handle of [send, verify, offer, decline]) {
    for (const sender of [{ sender: contents, senderFrame: { url: `${origin}/subframe` } }, { sender: {}, senderFrame: frame },
      { sender: contents, senderFrame: { url: "https://remote.example.test" } }, { sender: contents }]) assert.throws(() => handle(sender, "person@example.test", "12345678"), /only available/);
  }
  assert.deepEqual(calls.slice(0, 3), [["sendCode", "person@example.test"], ["verifyCode", "person@example.test", "12345678"], ["decline"]]);
});
