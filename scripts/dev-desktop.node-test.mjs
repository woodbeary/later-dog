import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { desktopPlan, runDesktop } from "./dev-desktop.mjs";

const fixtureHome = "/Users/desktop-fixture";
const ROOT = "/fixtures/laterdog";
const planFor = (env = {}) => desktopPlan({ env, home: fixtureHome, root: ROOT });

function fakeProcesses(plan, { delayServiceClose = false, failSpawnAt, emitSpawnErrorAt } = {}) {
  const children = [];
  const calls = [];
  let pid = 10_000;
  const signature = (step) => JSON.stringify([step.file, step.args]);
  const services = new Set(plan.services.map(signature));
  const spawnProcess = (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    if (calls.length === failSpawnAt) throw new Error("fixture spawn failed");
    const child = new EventEmitter();
    Object.assign(child, { pid: pid++, exitCode: null, signalCode: null, killed: false, signals: [], closed: false });
    child.finish = (code = 0, signal = null, close = true) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.exitCode = code;
        child.signalCode = signal;
        child.emit("exit", code, signal);
      }
      if (close && !child.closed) {
        child.closed = true;
        child.emit("close", code, signal);
      }
    };
    child.kill = (signal = "SIGTERM") => {
      child.signals.push(signal);
      child.killed = true;
      queueMicrotask(() => child.finish(null, signal, !(delayServiceClose && services.has(signature(call)))));
      return true;
    };
    children.push({ call, child });
    if (calls.length === emitSpawnErrorAt) {
      queueMicrotask(() => {
        child.emit("error", new Error("fixture executable missing"));
        child.finish(1);
      });
    } else if (signature(call) === signature(plan.prepare)) {
      queueMicrotask(() => child.finish(0));
    }
    return child;
  };
  return {
    calls, children, spawnProcess,
    get electron() { return children.find(({ call }) => signature(call) === signature(plan.electron))?.child; },
    get services() { return children.filter(({ call }) => services.has(signature(call))).map(({ child }) => child); },
  };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error("fixture did not reach its expected state");
}

function lifecycleOptions(processes, changes = {}) {
  return { spawnProcess: processes.spawnProcess, assertPorts: async () => {}, waitReady: async () => {}, signals: new EventEmitter(), ...changes };
}

test("one desktop plan keeps renderer, API and supervisor on the isolated Dev target", () => {
  const plan = planFor();
  assert.equal(plan.env.LATERDOG_HOME, `${fixtureHome}/.laterdog-dev`);
  assert.equal(plan.env.LATERDOG_USER_DATA, `${fixtureHome}/.laterdog-dev/desktop`);
  assert.equal(plan.env.LATERDOG_VARIANT, "dev");
  assert.equal(plan.env.LATERDOG_APP_VARIANT, "dev");
  assert.equal(plan.env.LATERDOG_SERVER_PORT, "8999");
  assert.equal(plan.env.LATERDOG_PORT, "9110");
  assert.equal(plan.env.LATERDOG_UI_PORT, "5299");
  assert.equal(plan.serverUrl, "http://127.0.0.1:8999");
  assert.equal(plan.supervisorUrl, "http://127.0.0.1:9110");
  assert.equal(plan.uiUrl, "http://127.0.0.1:5299");
  assert.equal(plan.env.ELECTRON_START_URL, plan.uiUrl);
  assert.deepEqual(plan.ports, [8999, 9000, 9110, 5299]);
  assert.equal(plan.services.length, 3);
  const vite = plan.services.find(({ args }) => args.some((arg) => arg.includes("vite")));
  assert.ok(vite, "Vite starts with the other owned services");
  assert.ok(vite.args.includes("--strictPort"), "Vite cannot silently move away from Electron's origin");
});

test("inherited release connections cannot redirect the Dev launch", () => {
  const deleted = ["LATERDOG_URL", "LATERDOG_SUPERVISOR_URL", "LATERDOG_TOKEN", "LATERDOG_TOKEN_FILE", "LATERDOG_DATA_DIR", "LATERDOG_HARNESS_URL", "LATERDOG_COMPANION_DIR", "LATERDOG_WEBHOOK_PORT", "ELECTRON_RUN_AS_NODE"];
  const plan = planFor({
    ...Object.fromEntries(deleted.map((name) => [name, "release-fixture"])),
    LATERDOG_VARIANT: "release", LATERDOG_APP_VARIANT: "release",
    LATERDOG_SERVER_PORT: "8799", LATERDOG_PORT: "9010",
    LATERDOG_USER_DATA: `${fixtureHome}/Library/Application Support/later.dog`,
    LATERDOG_BRIDGE_DIR: `${fixtureHome}/.laterdog/bridge`, LATERDOG_BIND: "0.0.0.0",
    ELECTRON_START_URL: "http://127.0.0.1:8799", KEEP_FIXTURE: "kept",
  });
  for (const name of deleted) assert.equal(plan.env[name], undefined, name);
  assert.equal(plan.env.LATERDOG_SERVER_PORT, "8999");
  assert.equal(plan.env.LATERDOG_PORT, "9110");
  assert.equal(plan.env.LATERDOG_VARIANT, "dev");
  assert.equal(plan.env.LATERDOG_USER_DATA, `${fixtureHome}/.laterdog-dev/desktop`);
  assert.equal(plan.env.LATERDOG_BRIDGE_DIR, `${fixtureHome}/.laterdog-dev/bridge`);
  assert.equal(plan.env.LATERDOG_BIND, "127.0.0.1");
  assert.equal(plan.env.ELECTRON_START_URL, plan.uiUrl);
  assert.equal(plan.env.KEEP_FIXTURE, "kept");
});

test("each isolated workspace has its own desktop profile despite inherited overrides", () => {
  const first = planFor({ LATERDOG_HOME: `${fixtureHome}/experiment-one`, LATERDOG_USER_DATA: `${fixtureHome}/Library/Application Support/later.dog` });
  const second = planFor({ LATERDOG_HOME: `${fixtureHome}/experiment-two`, LATERDOG_USER_DATA: first.env.LATERDOG_USER_DATA });
  assert.equal(first.env.LATERDOG_USER_DATA, `${fixtureHome}/experiment-one/desktop`);
  assert.equal(second.env.LATERDOG_USER_DATA, `${fixtureHome}/experiment-two/desktop`);
  assert.notEqual(first.env.LATERDOG_USER_DATA, second.env.LATERDOG_USER_DATA);
});

test("the desktop launcher refuses release data and live-data opt-in", () => {
  for (const name of [".laterdog", ".laterdog/profiles/example", ".laterdog-profiles/example", ".laterdog-v0"]) {
    assert.throws(() => planFor({ LATERDOG_HOME: `${fixtureHome}/${name}` }), undefined, name);
  }
  assert.throws(() => planFor({ LATERDOG_USE_MY_LIVE_DOGS: "1" }));
  assert.equal(planFor({ LATERDOG_HOME: `${fixtureHome}/isolated-experiment` }).env.LATERDOG_HOME, `${fixtureHome}/isolated-experiment`);
});

test("a custom renderer port stays aligned and invalid or reserved ports fail before spawning", () => {
  const plan = planFor({ LATERDOG_UI_PORT: "5399" });
  assert.equal(plan.uiUrl, "http://127.0.0.1:5399");
  assert.equal(plan.env.ELECTRON_START_URL, plan.uiUrl);
  assert.equal(plan.env.LATERDOG_UI_PORT, "5399");
  assert.deepEqual(plan.ports, [8999, 9000, 9110, 5399]);
  for (const port of ["0", "-1", "65536", "12.5", "5299junk", "8799", "8999", "9000", "9010", "9110"]) {
    assert.throws(() => planFor({ LATERDOG_UI_PORT: port }), undefined, port);
  }
});

test("Electron starts only after all owned services are ready and quitting cleans them up", { timeout: 5_000 }, async () => {
  const plan = planFor();
  const processes = fakeProcesses(plan);
  const checked = [];
  const signals = new EventEmitter();
  const result = runDesktop(plan, lifecycleOptions(processes, {
    signals,
    assertPorts: async (ports) => { assert.deepEqual(ports, plan.ports); assert.equal(processes.calls.length, 0); },
    waitReady: async (url) => {
      assert.equal(processes.services.length, 3);
      assert.equal(processes.electron, undefined);
      checked.push(url);
    },
  }));
  await until(() => processes.electron);
  assert.deepEqual(new Set(checked), new Set([`${plan.supervisorUrl}/v1/workspace`, `${plan.serverUrl}/api/health`, `${plan.uiUrl}/@vite/client`]));
  assert.deepEqual(processes.calls[0].args, plan.prepare.args);
  for (const { call } of processes.children) {
    assert.equal(call.options.cwd, plan.root);
    assert.equal(call.options.env.LATERDOG_HOME, plan.env.LATERDOG_HOME);
    assert.equal(call.options.env.LATERDOG_USER_DATA, `${fixtureHome}/.laterdog-dev/desktop`);
  }
  processes.electron.finish(0);
  assert.equal(await result, 0);
  for (const child of processes.services) {
    assert.ok(child.signals.includes("SIGTERM"));
    assert.equal(child.closed, true);
  }
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("completion waits for owned service close events, not merely their exit events", { timeout: 5_000 }, async () => {
  const plan = planFor();
  const processes = fakeProcesses(plan, { delayServiceClose: true });
  let settled = false;
  const result = runDesktop(plan, lifecycleOptions(processes)).then((code) => { settled = true; return code; });
  await until(() => processes.electron);
  processes.electron.finish(0);
  await until(() => processes.services.every((child) => child.killed));
  await nextTurn();
  assert.equal(settled, false);
  for (const child of processes.services) child.finish(null, "SIGTERM");
  assert.equal(await result, 0);
});

test("a port conflict starts no preparation or service process", { timeout: 5_000 }, async () => {
  const plan = planFor();
  const processes = fakeProcesses(plan);
  const code = await runDesktop(plan, lifecycleOptions(processes, {
    assertPorts: async () => { throw new Error("fixture port is occupied"); },
  }));
  assert.notEqual(code, 0);
  assert.equal(processes.calls.length, 0);
});

test("a readiness failure closes all owned services without launching Electron", { timeout: 5_000 }, async () => {
  const plan = planFor();
  const processes = fakeProcesses(plan);
  const code = await runDesktop(plan, lifecycleOptions(processes, {
    waitReady: async () => { throw new Error("fixture never became ready"); },
  }));
  assert.notEqual(code, 0);
  assert.equal(processes.electron, undefined);
  assert.equal(processes.services.length, 3);
  for (const child of processes.services) assert.equal(child.closed, true);
});

for (const option of ["failSpawnAt", "emitSpawnErrorAt"]) {
  test(`${option} cleans up previously started services`, { timeout: 5_000 }, async () => {
    const plan = planFor();
    const processes = fakeProcesses(plan, { [option]: 3 });
    const code = await runDesktop(plan, lifecycleOptions(processes));
    assert.notEqual(code, 0);
    assert.equal(processes.electron, undefined);
    for (const { child } of processes.children) assert.equal(child.closed, true);
  });
}

test("a service crash stops Electron and every other owned service", { timeout: 5_000 }, async () => {
  const plan = planFor();
  const processes = fakeProcesses(plan);
  const result = runDesktop(plan, lifecycleOptions(processes));
  await until(() => processes.electron);
  processes.services[1].finish(7);
  assert.notEqual(await result, 0);
  assert.equal(processes.electron.closed, true);
  for (const child of processes.services) assert.equal(child.closed, true);
});

test("an error from a running child retains ownership until that child closes", { timeout: 5_000 }, async () => {
  const plan = planFor();
  const processes = fakeProcesses(plan, { delayServiceClose: true });
  let settled = false;
  const result = runDesktop(plan, lifecycleOptions(processes)).then((code) => { settled = true; return code; });
  await until(() => processes.electron);
  const failed = processes.services[0];
  failed.emit("error", new Error("fixture child operation failed"));
  await nextTurn();
  assert.ok(failed.signals.includes("SIGTERM"), "the running child with the error still needs cleanup");
  assert.equal(settled, false);
  for (const child of processes.services.slice(1)) child.finish(null, "SIGTERM");
  await nextTurn();
  assert.equal(settled, false, "the errored child has not closed yet");
  failed.finish(null, "SIGTERM");
  assert.notEqual(await result, 0);
});

test("interruption during port checks launches nothing and removes signal listeners", { timeout: 5_000 }, async () => {
  const plan = planFor();
  const processes = fakeProcesses(plan);
  const signals = new EventEmitter();
  let releaseCheck;
  const result = runDesktop(plan, lifecycleOptions(processes, {
    signals, assertPorts: () => new Promise((resolve) => { releaseCheck = resolve; }),
  }));
  await until(() => releaseCheck);
  signals.emit("SIGINT");
  releaseCheck();
  await result;
  assert.equal(processes.calls.length, 0);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("SIGINT shuts down the owned app and services", { timeout: 5_000 }, async () => {
  const plan = planFor();
  const processes = fakeProcesses(plan);
  const signals = new EventEmitter();
  const result = runDesktop(plan, lifecycleOptions(processes, { signals }));
  await until(() => processes.electron);
  signals.emit("SIGINT");
  await result;
  assert.equal(processes.electron.closed, true);
  for (const child of processes.services) assert.equal(child.closed, true);
  assert.equal(signals.listenerCount("SIGINT"), 0);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});
