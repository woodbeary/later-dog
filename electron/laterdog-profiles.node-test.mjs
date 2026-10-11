import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createProfileRunner, portFree, profileServerEnvironment } from "./laterdog-profiles.mjs";
import { createServerLiveness } from "./laterdog-server-liveness.mjs";
import { createServerSupervisor } from "./server-supervisor.mjs";

const tick = (ms = 1) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label) {
  for (let index = 0; index < 500; index++) {
    if (check()) return;
    await tick(2);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function harness({ answers = () => "ready", busy = new Set(), applyCredential, base = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "laterdog-profiles-"));
  const forks = [];
  const leases = [];
  const trashed = [];
  const spawned = [];
  const exited = [];
  const applied = [];
  let nextPid = 4000;
  let ids = 0;
  const fork = (entry, args, options) => {
    const proc = new EventEmitter();
    proc.pid = undefined;
    proc.kills = 0;
    proc.stuck = false;
    proc.kill = () => {
      proc.kills++;
      if (proc.stuck || proc.dead) return;
      proc.dead = true;
      setImmediate(() => proc.emit("exit", 0));
    };
    proc.crash = () => {
      proc.dead = true;
      proc.emit("exit", 1);
    };
    setImmediate(() => {
      proc.pid = nextPid++;
      proc.emit("spawn");
    });
    forks.push({ entry, args, env: options.env, proc });
    return proc;
  };
  const probe = async ({ port, pid, isExited }) => {
    for (;;) {
      if (isExited()) return { outcome: "exited" };
      if (pid() !== undefined) break;
      await tick();
    }
    const answer = await answers(port);
    if (answer === "ready") return { outcome: "ready" };
    for (let index = 0; index < 20; index++) {
      if (isExited()) return { outcome: "exited" };
      await tick();
    }
    return { outcome: answer };
  };
  const acquireLease = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    const lease = {
      dir,
      released: false,
      release() {
        lease.released = true;
        return true;
      },
      utilityServerLeaseEnvironment: () => ({ LATERDOG_INTERNAL_DATA_DIR_LEASE: `lease:${path.basename(dir)}` }),
    };
    leases.push(lease);
    return lease;
  };
  const secrets = {
    available: async () => true,
    encrypt: async (text) => Buffer.from(`sealed:${text}`),
    decrypt: async (buffer) => String(buffer).replace(/^sealed:/, ""),
  };
  const options = {
    file: path.join(root, "userData", "profiles.json"),
    dataRoot: path.join(root, ".laterdog-profiles"),
    credentialsRoot: path.join(root, "userData", "profiles"),
    launch: () => ({ entry: "/app/server/index.js", compileCacheDir: null }),
    baseEnvironment: () => ({ PATH: "/usr/bin", XAI_API_KEY: "personal-key", LATERDOG_HOME: "/Users/me/.laterdog", ...base }),
    fork,
    probe,
    acquireLease,
    supervise: (settings) => createServerSupervisor({ ...settings, retryDelaysMs: [1, 1, 1] }),
    secrets,
    applyCredential: applyCredential ?? (async (request) => {
      applied.push(request);
      return { ok: true };
    }),
    trash: async (dir) => {
      trashed.push(dir);
      fs.rmSync(dir, { recursive: true, force: true });
    },
    onSpawn: (proc) => spawned.push(proc),
    onExit: (proc) => exited.push(proc),
    isFree: async (port) => !busy.has(port),
    makeId: () => `p${String(++ids).padStart(12, "0")}`,
    bootTimeoutMs: 200,
    stopTimeoutMs: 50,
    sleep: async () => {},
  };
  return {
    root,
    forks,
    leases,
    trashed,
    spawned,
    exited,
    applied,
    options,
    secrets,
    runner: (extra = {}) => createProfileRunner({ ...options, ...extra }),
    saved: () => JSON.parse(fs.readFileSync(options.file, "utf8")),
  };
}

test("a profile's server gets its own folder, ports and lease, and none of Personal's keys", () => {
  const env = profileServerEnvironment(
    {
      PATH: "/usr/bin",
      XAI_API_KEY: "personal",
      OPENCODE_API_KEY: "personal",
      COMPOSIO_API_KEY: "personal",
      LATERDOG_COMPOSIO_BROKER_TOKEN: "personal",
      LATERDOG_BROWSER_CONNECTION: "{}",
      LATERDOG_DESKTOP_PROFILE: "pffffffffffff",
      LATERDOG_TUNNEL_SOCKET: "/tmp/tunnel",
      LATERDOG_WEBHOOK_PORT: "8800",
      LATERDOG_SERVER_COMPILE_CACHE: "/inherited",
      LATERDOG_HOME: "/Users/me/.laterdog",
    },
    {
      leaseEnvironment: { LATERDOG_INTERNAL_DATA_DIR_LEASE: "capability" },
      dataDir: "/Users/me/.laterdog-profiles/p00000000000a",
      port: 8811,
      profileId: "p00000000000a",
      credentials: { xaiApiKey: "business", composioApiKey: "ak_business" },
      credentialStore: "ok",
      compileCacheDir: "/cache",
    },
  );
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    XAI_API_KEY: "business",
    COMPOSIO_API_KEY: "ak_business",
    LATERDOG_INTERNAL_DATA_DIR_LEASE: "capability",
    LATERDOG_HOME: "/Users/me/.laterdog-profiles/p00000000000a",
    LATERDOG_DESKTOP_PARENT: "1",
    LATERDOG_DESKTOP_PROFILE: "p00000000000a",
    LATERDOG_SERVER_PORT: "8811",
    LATERDOG_WEBHOOK_PORT: "8812",
    LATERDOG_CREDENTIAL_STORE: "ok",
    LATERDOG_SERVER_COMPILE_CACHE: "/cache",
  });
  const unreadable = profileServerEnvironment({}, {
    leaseEnvironment: {},
    dataDir: "/d",
    port: 8813,
    profileId: "p00000000000b",
    credentials: {},
    credentialStore: "unavailable",
    compileCacheDir: null,
  });
  assert.equal(unreadable.LATERDOG_CREDENTIAL_STORE, "unavailable");
  assert.equal("LATERDOG_SERVER_COMPILE_CACHE" in unreadable, false);
});

test("only Personal means no extra servers", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  await tick(5);
  assert.equal(setup.forks.length, 0);
  assert.deepEqual(runner.list(), {
    activeId: "main",
    canAdd: true,
    profiles: [{ id: "main", name: "", main: true, status: "running" }],
  });
  assert.equal(runner.activeOrigin(), null);
});

test("adding a profile starts its own server in the background", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  const added = await runner.add("Business");
  assert.deepEqual(added, { id: "p000000000001", ready: true });
  assert.equal(setup.forks.length, 1);
  const { env, entry } = setup.forks[0];
  assert.equal(entry, "/app/server/index.js");
  assert.equal(env.LATERDOG_HOME, path.join(setup.options.dataRoot, "p000000000001"));
  assert.equal(env.LATERDOG_SERVER_PORT, "8811");
  assert.equal(env.XAI_API_KEY, undefined);
  assert.equal(env.LATERDOG_INTERNAL_DATA_DIR_LEASE, "lease:p000000000001");
  assert.deepEqual(setup.spawned, [setup.forks[0].proc]);
  assert.equal(runner.list().profiles[1].status, "running");
  assert.equal(runner.ownsPort(8811), true);
  assert.equal(runner.ownsPort(8813), false);
  assert.equal(runner.activeId(), "main");
  assert.deepEqual(setup.saved().profiles, [{ id: "p000000000001", name: "Business", port: 8811 }]);
  await runner.stopAll();
});

test("a new profile starts with the open profile's name and tour progress, and nothing else", async () => {
  const setup = harness();
  const personal = path.join(setup.root, ".laterdog");
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, "config.json"), JSON.stringify({
    profile: { name: "Anthony", email: "a@example.com", aboutMe: "Private notes" },
    onboarding: { completedAt: "2026-10-01T09:00:00.000Z", version: 2, hintsSeen: ["composer"] },
    xai: { key: "xai-secret" },
  }));
  const runner = setup.runner({ mainDataDir: personal });
  await runner.start();
  const business = await runner.add("Business");
  const seeded = path.join(setup.options.dataRoot, business.id, "config.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(seeded, "utf8")), {
    profile: { name: "Anthony", email: "a@example.com" },
    onboarding: { completedAt: "2026-10-01T09:00:00.000Z", version: 2, hintsSeen: ["composer"] },
  });
  assert.equal(fs.statSync(seeded).mode & 0o777, 0o600);
  fs.writeFileSync(seeded, JSON.stringify({ profile: { name: "Anthony at work" }, onboarding: { completedAt: "2026-10-02T09:00:00.000Z", version: 2 } }));
  await runner.switchTo(business.id);
  const second = await runner.add("Business 2");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(setup.options.dataRoot, second.id, "config.json"), "utf8")), {
    profile: { name: "Anthony at work" },
    onboarding: { completedAt: "2026-10-02T09:00:00.000Z", version: 2 },
  });
  await runner.stopAll();
});

test("a new profile starts fresh when there is nothing to carry over", async () => {
  const setup = harness();
  const personal = path.join(setup.root, ".laterdog");
  const runner = setup.runner({ mainDataDir: personal });
  await runner.start();
  const first = await runner.add("Business");
  assert.equal(fs.existsSync(path.join(setup.options.dataRoot, first.id, "config.json")), false);
  fs.mkdirSync(personal, { recursive: true });
  fs.writeFileSync(path.join(personal, "config.json"), "{ not json");
  const second = await runner.add("Business 2");
  assert.equal(fs.existsSync(path.join(setup.options.dataRoot, second.id, "config.json")), false);
  assert.equal(second.ready, true);
  await runner.stopAll();
});

test("switching opens the profile and is remembered for next time", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  const { id } = await runner.add("Business");
  assert.deepEqual(await runner.switchTo(id), { id, origin: "http://127.0.0.1:8811" });
  assert.equal(runner.activeOrigin(), "http://127.0.0.1:8811");
  assert.equal(runner.activeProcess(), setup.forks[0].proc);
  assert.equal(runner.activeDataDir(), path.join(setup.options.dataRoot, id));
  assert.equal(setup.saved().activeId, id);
  await runner.stopAll();

  const reopened = setup.runner();
  await reopened.start();
  assert.equal(reopened.activeId(), id);
  assert.equal(reopened.list().profiles[1].status, "running");
  assert.deepEqual(await reopened.switchTo("main"), { id: "main", origin: null });
  assert.equal(reopened.activeOrigin(), null);
  assert.equal(reopened.activeProcess(), null);
  await reopened.stopAll();
});

test("switching away leaves the other profile running", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  const business = await runner.add("Business");
  const second = await runner.add("Business 2");
  await runner.switchTo(business.id);
  await runner.switchTo(second.id);
  await runner.switchTo("main");
  assert.equal(setup.forks.length, 2);
  assert.deepEqual(setup.forks.map(({ env }) => env.LATERDOG_DESKTOP_PROFILE), [business.id, second.id]);
  assert.equal(setup.forks.every(({ proc }) => proc.kills === 0), true);
  assert.deepEqual(runner.list().profiles.map((profile) => profile.status), ["running", "running", "running"]);
  await runner.stopAll();
});

test("the last profile picked wins, even when an earlier one is slower to start", async () => {
  const answers = new Map([[8811, "timeout"]]);
  let gate = Promise.resolve();
  const hold = () => {
    let open;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    return open;
  };
  const setup = harness({
    answers: async (port) => {
      const answer = answers.get(port) ?? "ready";
      if (answer !== "slow") return answer;
      await gate;
      return "ready";
    },
  });
  const runner = setup.runner();
  await runner.start();
  const business = await runner.add("Business");
  const second = await runner.add("Business 2");
  answers.set(8811, "slow");
  let open = hold();
  const first = runner.switchTo(business.id);
  assert.deepEqual(await runner.switchTo(second.id), { id: second.id, origin: "http://127.0.0.1:8813" });
  open();
  assert.deepEqual(await first, { id: second.id, origin: "http://127.0.0.1:8813", superseded: true });
  assert.equal(setup.saved().activeId, second.id);
  assert.equal(runner.list().profiles[1].status, "running");

  open = hold();
  setup.forks.filter(({ env }) => env.LATERDOG_SERVER_PORT === "8811").at(-1).proc.crash();
  await until(() => runner.list().profiles[1].status === "starting", "the restart");
  const again = runner.switchTo(business.id);
  runner.usePersonal();
  open();
  assert.deepEqual(await again, { id: "main", origin: null, superseded: true });
  assert.equal(runner.activeId(), "main");
  await runner.stopAll();
});

test("a busy port moves the profile to the next free pair", async () => {
  const setup = harness({ busy: new Set([8812, 8813]) });
  const runner = setup.runner();
  await runner.start();
  await runner.add("Business");
  assert.equal(setup.forks[0].env.LATERDOG_SERVER_PORT, "8815");
  assert.equal(setup.saved().profiles[0].port, 8815);
  assert.equal(runner.ownsPort(8815), true);
  await runner.stopAll();
});

test("a profile that cannot start is reported, and launch falls back to Personal", async () => {
  let answer = "timeout";
  const setup = harness({ answers: () => answer });
  const runner = setup.runner();
  await runner.start();
  const added = await runner.add("Business");
  assert.equal(added.ready, false);
  assert.equal(runner.list().profiles[1].status, "failed");
  assert.equal(setup.forks[0].proc.kills > 0, true);
  await assert.rejects(runner.switchTo(added.id), /Business could not start/);
  answer = "ready";
  assert.deepEqual(await runner.switchTo(added.id), { id: added.id, origin: "http://127.0.0.1:8811" });
  assert.deepEqual(setup.leases.map((lease) => lease.released), [true, true, false]);
  await runner.stopAll();

  answer = "timeout";
  const reopened = setup.runner();
  await reopened.start();
  assert.equal(reopened.activeId(), "main");
  assert.equal(setup.saved().activeId, "main");
  await reopened.stopAll();
});

test("a crashed profile server restarts on the same port", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  await runner.add("Business");
  setup.forks[0].proc.crash();
  await until(() => setup.forks.length === 2 && runner.list().profiles[1].status === "running", "the restart");
  assert.equal(setup.forks[1].env.LATERDOG_SERVER_PORT, "8811");
  assert.deepEqual(setup.exited, [setup.forks[0].proc]);
  await runner.stopAll();
});

test("a profile server that ended without an exit event restarts on the same port", async () => {
  const setup = harness();
  const gone = new Set();
  const probed = [];
  const runner = setup.runner({
    watchLiveness: (settings) => createServerLiveness({
      ...settings,
      intervalMs: 5,
      probe: async (port) => {
        probed.push(port);
        return gone.size ? "refused" : "open";
      },
      ended: async (pid) => gone.has(pid),
    }),
  });
  await runner.start();
  await runner.add("Business");
  await until(() => runner.list().profiles[1].status === "running" && probed.length > 0, "the first check");
  setup.forks[0].proc.dead = true;
  gone.add(setup.forks[0].proc.pid);
  await until(() => setup.forks.length === 2 && runner.list().profiles[1].status === "running", "the restart");
  assert.equal(setup.forks[1].env.LATERDOG_SERVER_PORT, "8811");
  assert.deepEqual(setup.exited, [setup.forks[0].proc]);
  assert.deepEqual([...new Set(probed)], [8811]);
  await runner.stopAll();
});

test("keys saved in a profile stay in that profile, encrypted", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  const { id } = await runner.add("Business");
  await runner.saveCredential(id, "xaiApiKey", "  business-key ", { xai: { key: "business-key" } });
  assert.deepEqual(setup.applied, [{ port: 8811, patch: { xai: { key: "business-key" } } }]);
  const sealed = fs.readFileSync(path.join(setup.options.credentialsRoot, id, "credentials.bin"), "utf8");
  assert.equal(sealed, `sealed:${JSON.stringify({ xaiApiKey: "business-key" })}`);
  assert.equal(fs.existsSync(path.join(setup.root, "userData", "credentials.bin")), false);
  setup.forks[0].proc.crash();
  await until(() => setup.forks.length === 2 && runner.list().profiles[1].status === "running", "the restart");
  assert.equal(setup.forks[1].env.XAI_API_KEY, "business-key");
  await runner.saveCredential(id, "xaiApiKey", "", { xai: { key: "" } });
  assert.equal(
    fs.readFileSync(path.join(setup.options.credentialsRoot, id, "credentials.bin"), "utf8"),
    `sealed:${JSON.stringify({})}`,
  );
  await runner.stopAll();
});

test("a key the profile's server refuses is rolled back", async () => {
  const setup = harness({
    applyCredential: async () => {
      throw new Error("Could not save credential (HTTP 400)");
    },
  });
  const runner = setup.runner();
  await runner.start();
  const { id } = await runner.add("Business");
  await assert.rejects(runner.saveCredential(id, "xaiApiKey", "bad", { xai: { key: "bad" } }), /HTTP 400/);
  assert.equal(
    fs.readFileSync(path.join(setup.options.credentialsRoot, id, "credentials.bin"), "utf8"),
    `sealed:${JSON.stringify({})}`,
  );
  await assert.rejects(runner.saveCredential("p0000000000ff", "xaiApiKey", "x", {}), /unavailable/);
  await runner.stopAll();
});

test("removing a profile stops its server and moves its folder to the Trash", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  const { id } = await runner.add("Business");
  await runner.switchTo(id);
  await runner.saveCredential(id, "xaiApiKey", "business-key", { xai: { key: "business-key" } });
  await assert.rejects(runner.remove(id), /Switch to another profile/);
  assert.equal(setup.forks[0].proc.kills, 0);
  runner.usePersonal();
  assert.equal(runner.activeId(), "main");
  const list = await runner.remove(id);
  assert.deepEqual(list.profiles.map((profile) => profile.id), ["main"]);
  assert.equal(list.activeId, "main");
  assert.equal(setup.forks[0].proc.kills, 1);
  assert.equal(setup.leases[0].released, true);
  assert.deepEqual(setup.trashed, [path.join(setup.options.dataRoot, id)]);
  assert.equal(fs.existsSync(path.join(setup.options.credentialsRoot, id)), false);
  assert.equal(runner.activeOrigin(), null);
  await assert.rejects(runner.remove("main"), /Personal can't be removed/);
});

test("a server that will not stop keeps its folder", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  const { id } = await runner.add("Business");
  setup.forks[0].proc.stuck = true;
  await assert.rejects(runner.remove(id), /still shutting down/);
  assert.deepEqual(setup.trashed, []);
  assert.equal(setup.leases[0].released, false);
  assert.equal(setup.saved().profiles.length, 1);
});

test("renaming keeps the profile's server and folder", async () => {
  const setup = harness();
  const runner = setup.runner();
  await runner.start();
  const { id } = await runner.add("Business");
  const list = runner.rename(id, "Work");
  assert.equal(list.profiles[1].name, "Work");
  assert.equal(runner.rename("main", "Home").profiles[0].name, "Home");
  assert.equal(setup.forks.length, 1);
  assert.equal(setup.forks[0].proc.kills, 0);
  await runner.stopAll();
});

test("closing the app stops every profile server and releases its folder", async () => {
  const changes = [];
  const setup = harness();
  const runner = setup.runner({ onChange: () => changes.push(true) });
  await runner.start();
  await runner.add("Business");
  await runner.add("Business 2");
  await runner.stopAll();
  assert.equal(setup.forks.every(({ proc }) => proc.kills === 1), true);
  assert.equal(setup.leases.every((lease) => lease.released), true);
  assert.equal(changes.length > 0, true);
  await assert.rejects(runner.add("Late"), /closing/);
});

test("every saved profile starts at launch, the open one first", async () => {
  const setup = harness();
  const first = setup.runner();
  await first.start();
  await first.add("Business");
  const second = await first.add("Business 2");
  await first.switchTo(second.id);
  await first.stopAll();

  const reopened = setup.runner();
  await reopened.start();
  assert.equal(setup.forks[2].env.LATERDOG_SERVER_PORT, "8813");
  await until(() => setup.forks.length === 4, "the second profile");
  assert.equal(setup.forks[3].env.LATERDOG_SERVER_PORT, "8811");
  await until(() => reopened.list().profiles.every((profile) => profile.status === "running"), "both running");
  await reopened.stopAll();
});

test("portFree tells a taken port from a free one", async () => {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.equal(await portFree(port), false);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portFree(port), true);
});
