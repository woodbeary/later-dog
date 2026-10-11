import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import net from "node:net";
import test from "node:test";
import { createServerLiveness, probeServerPort, serverProcessEnded } from "./laterdog-server-liveness.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function child(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exits = [];
  proc.on("exit", (code) => proc.exits.push(code));
  return proc;
}

function fixture(t, { answer = "open", gone = new Set() } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const state = { answer, gone, probed: [], asked: [], logged: [] };
  const liveness = createServerLiveness({
    port: () => 8799,
    intervalMs: 100,
    probe: async (port) => {
      state.probed.push(port);
      if (typeof state.answer === "function") return state.answer();
      return state.answer;
    },
    ended: async (pid) => {
      state.asked.push(pid);
      return state.gone.has(pid);
    },
    log: (line) => state.logged.push(line),
  });
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await settle();
  };
  return { liveness, state, tick };
}

test("leaves a server that still takes connections alone", async (t) => {
  const { liveness, state, tick } = fixture(t);
  const proc = child(41);
  liveness.start(proc);
  await tick(99);
  assert.deepEqual(state.probed, []);
  await tick(1);
  assert.deepEqual(state.probed, [8799]);
  await tick(100);
  assert.deepEqual(state.probed, [8799, 8799]);
  assert.deepEqual(state.asked, []);
  assert.deepEqual(proc.exits, []);
});

test("does nothing about a closed port while the process is still running", async (t) => {
  const { liveness, state, tick } = fixture(t, { answer: "refused" });
  const proc = child(41);
  liveness.start(proc);
  await tick(100);
  await tick(100);
  assert.deepEqual(state.asked, [41, 41]);
  assert.deepEqual(proc.exits, []);
});

test("treats a server that ended without an exit event as exited, once", async (t) => {
  const { liveness, state, tick } = fixture(t, { answer: "refused", gone: new Set([41]) });
  const proc = child(41);
  liveness.start(proc);
  await tick(100);
  assert.deepEqual(proc.exits, [null]);
  assert.deepEqual(state.logged, ["server pid=41 ended without an exit event"]);
  await tick(1_000);
  assert.deepEqual(state.probed, [8799]);
  assert.deepEqual(proc.exits, [null]);
});

test("keeps watching through an unclear answer or a failed check", async (t) => {
  let calls = 0;
  const { liveness, state, tick } = fixture(t, {
    answer: () => {
      calls += 1;
      if (calls === 1) return "unknown";
      if (calls === 2) throw new Error("probe failed");
      return "refused";
    },
    gone: new Set([41]),
  });
  const proc = child(41);
  liveness.start(proc);
  await tick(100);
  await tick(100);
  assert.deepEqual(state.asked, []);
  assert.deepEqual(proc.exits, []);
  await tick(100);
  assert.deepEqual(proc.exits, [null]);
});

test("stops watching a child that stopped or was replaced, even mid-check", async (t) => {
  let release;
  const { liveness, state, tick } = fixture(t, { answer: "refused", gone: new Set([41, 42]) });
  const first = child(41);
  liveness.start(first);
  liveness.stop();
  await tick(1_000);
  assert.deepEqual(state.probed, []);

  state.answer = () => new Promise((resolve) => { release = resolve; });
  liveness.start(first);
  await tick(100);
  assert.equal(state.probed.length, 1);
  const second = child(42);
  liveness.start(second);
  release("refused");
  await settle();
  assert.deepEqual(state.asked, []);
  assert.deepEqual(first.exits, []);

  state.answer = "refused";
  await tick(100);
  assert.deepEqual(state.asked, [42]);
  assert.deepEqual(second.exits, [null]);
  assert.deepEqual(first.exits, []);
});

test("the supervisor restarts a server that ended without an exit event", async (t) => {
  const children = [];
  const ready = [];
  const { state, tick, liveness } = fixture(t, { answer: "refused" });
  const supervisor = createServerSupervisor({
    restart: async () => {
      const proc = child(100 + children.length);
      children.push(proc);
      supervisor.watch(proc);
      return { proc };
    },
    stop: async () => true,
    onReady: (proc) => {
      ready.push(proc.pid);
      liveness.start(proc);
    },
    onUnavailable: () => liveness.stop(),
    onExhausted: () => assert.fail("recovery should not run out"),
    retryDelaysMs: [10],
  });
  const first = child(41);
  supervisor.watch(first);
  supervisor.ready(first);
  state.gone.add(41);
  await tick(100);
  assert.deepEqual(first.exits, [null]);
  assert.equal(supervisor.isCurrent(first), false);
  await tick(10);
  assert.deepEqual(ready, [41, 100]);
  assert.equal(supervisor.isCurrent(children[0]), true);

  first.emit("exit", 0);
  assert.equal(supervisor.isCurrent(children[0]), true, "a late real exit cannot touch the replacement");
  await tick(100);
  assert.equal(state.asked.at(-1), 100);
  assert.deepEqual(children[0].exits, []);
});

test("tells a listening port from a closed one", async () => {
  const server = net.createServer((socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  assert.equal(await probeServerPort(port), "open");
  await new Promise((done) => server.close(done));
  assert.equal(await probeServerPort(port), "refused");
});

test("tells a running process from a zombie and from one that is gone", { skip: !["darwin", "linux"].includes(process.platform) }, async (t) => {
  const until = async (expected, pid) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await serverProcessEnded(pid)) === expected) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  assert.equal(await serverProcessEnded(process.pid), false);
  assert.equal(await serverProcessEnded(undefined), false);
  assert.equal(await serverProcessEnded(0), false);
  assert.equal(await serverProcessEnded(process.pid, "win32"), false);

  const parent = spawn("/bin/sh", ["-c", "sleep 1 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => parent.kill());
  const [line] = await once(parent.stdout, "data");
  const pid = Number(String(line).trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.equal(await serverProcessEnded(pid), false, "still sleeping");
  assert.equal(await until(true, pid), true, "a zombie its parent never collected counts as ended");
  assert.equal(parent.exitCode, null, "the parent that holds the zombie is still running");
  parent.kill();
  await once(parent, "exit");
  assert.equal(await until(true, pid), true);
});

test("the desktop app watches its own server", () => {
  const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  assert.match(main, /createServerLiveness\(\{ port: \(\) => SERVER_PORT, log: slog \}\)/);
  assert.match(main, /onReady\(proc\) \{\s*serverProc = proc;[\s\S]{0,300}?serverLiveness\.start\(proc\);/);
  assert.match(main, /onUnavailable\(\) \{\s*serverLiveness\.stop\(\);/);
});
