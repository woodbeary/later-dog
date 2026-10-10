import nodeFs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import profilesModule from "./profiles.cjs";
import { readSecureCredentials } from "./secure-credentials.mjs";
import { createSecureCredentialState } from "./secure-credential-state.mjs";
import { WORKSPACE_CREDENTIALS, workspaceCredentialEnv } from "./workspace-credentials.mjs";

const {
  MAIN_ID,
  activeProfile,
  nextPort,
  parseProfiles,
  profileList,
  profileOrigin,
  profileSeed,
  serializeProfiles,
  withActive,
  withName,
  withPort,
  withProfile,
  withoutProfile,
} = profilesModule;

const STRIPPED_ENV = [
  ...WORKSPACE_CREDENTIALS.map((entry) => entry.env),
  "COMPOSIO_API_KEY",
  "LATERDOG_COMPOSIO_BROKER_URL",
  "LATERDOG_COMPOSIO_BROKER_TOKEN",
  "LATERDOG_BROWSER_CONNECTION",
  "LATERDOG_DESKTOP_PROFILE",
  "LATERDOG_SERVER_COMPILE_CACHE",
  "LATERDOG_TUNNEL_SOCKET",
  "LATERDOG_WEBHOOK_PORT",
  "LATERDOG_PUBLIC_URL",
];

export function profileServerEnvironment(base, { leaseEnvironment, dataDir, port, profileId, credentials, credentialStore, compileCacheDir }) {
  const env = { ...base };
  for (const name of STRIPPED_ENV) delete env[name];
  Object.assign(env, leaseEnvironment, {
    LATERDOG_HOME: dataDir,
    LATERDOG_DESKTOP_PARENT: "1",
    LATERDOG_DESKTOP_PROFILE: profileId,
    LATERDOG_SERVER_PORT: String(port),
    LATERDOG_WEBHOOK_PORT: String(port + 1),
    LATERDOG_CREDENTIAL_STORE: credentialStore === "unavailable" ? "unavailable" : "ok",
  }, workspaceCredentialEnv(credentials));
  if (typeof credentials?.composioApiKey === "string" && credentials.composioApiKey) env.COMPOSIO_API_KEY = credentials.composioApiKey;
  if (compileCacheDir) env.LATERDOG_SERVER_COMPILE_CACHE = compileCacheDir;
  return env;
}

export function portFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

export function createProfileRunner({
  file,
  dataRoot,
  mainDataDir = null,
  credentialsRoot,
  launch,
  baseEnvironment,
  fork,
  probe,
  acquireLease,
  supervise,
  secrets,
  applyCredential,
  trash,
  onSpawn = () => {},
  onMessage = () => false,
  onExit = () => {},
  onReady = () => {},
  onChange = () => {},
  isFree = portFree,
  makeId = () => `p${randomBytes(6).toString("hex")}`,
  bootTimeoutMs = 60_000,
  stopTimeoutMs = 6_500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  fs = nodeFs,
}) {
  let state = load();
  let closed = false;
  let started = false;
  let switchTicket = 0;
  const runs = new Map();
  const vaults = new Map();

  function load() {
    try {
      return parseProfiles(fs.readFileSync(file, "utf8"));
    } catch {
      return parseProfiles("");
    }
  }

  function save(next) {
    if (next === state) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, serializeProfiles(next), { mode: 0o600 });
    fs.renameSync(temporary, file);
    state = next;
    onChange();
  }

  const find = (id) => state.profiles.find((profile) => profile.id === id) ?? null;
  const dataDirFor = (id) => path.join(dataRoot, id);
  const credentialFile = (id) => path.join(credentialsRoot, id, "credentials.bin");

  function setStatus(run, status) {
    if (run.status === status) return;
    run.status = status;
    for (const waiter of run.waiters) waiter();
    if (runs.get(run.id) === run) onChange();
  }

  function waitFor(run) {
    return new Promise((resolve) => {
      let timer;
      const settle = () => {
        if (run.status === "running" || run.status === "failed" || run.status === "stopped") {
          clearTimeout(timer);
          run.waiters.delete(settle);
          resolve(run.status === "running");
        }
      };
      timer = setTimeout(() => {
        run.waiters.delete(settle);
        resolve(false);
      }, bootTimeoutMs * 2 + stopTimeoutMs);
      timer.unref?.();
      run.waiters.add(settle);
      settle();
    });
  }

  function openVault(id) {
    if (!vaults.has(id)) {
      const target = credentialFile(id);
      vaults.set(id, readSecureCredentials({
        exists: () => fs.existsSync(target),
        isAvailable: () => secrets.available(),
        readFile: () => fs.readFileSync(target),
        decrypt: (buffer) => secrets.decrypt(buffer),
        sleep,
      }).then((result) => {
        const writable = result.status !== "unavailable";
        if (!writable) log(`profile ${id} keys could not be read (${result.error}); they are not loaded this launch`);
        return {
          status: writable ? "ok" : "unavailable",
          store: createSecureCredentialState(result.credentials, (credentials) => persistCredentials(id, credentials), { writable }),
        };
      }));
    }
    return vaults.get(id);
  }

  async function persistCredentials(id, credentials) {
    if (!(await secrets.available())) throw new Error("The operating-system credential store is unavailable");
    const target = credentialFile(id);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const encrypted = await secrets.encrypt(JSON.stringify(credentials));
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  async function pairFree(port) {
    return (await isFree(port)) && (await isFree(port + 1));
  }

  async function choosePort(id) {
    const profile = find(id);
    if (!profile) return null;
    if (await pairFree(profile.port)) return profile.port;
    const unavailable = [];
    for (;;) {
      const candidate = nextPort(state, unavailable);
      if (candidate === null) return null;
      if (await pairFree(candidate)) {
        save(withPort(state, id, candidate));
        log(`profile ${id} moved to port ${candidate}; its old port was busy`);
        return candidate;
      }
      unavailable.push(candidate);
    }
  }

  async function stopProc(run, proc) {
    if (!proc) return true;
    const exit = run.exits.get(proc);
    if (!exit) return false;
    try {
      proc.kill();
    } catch {}
    let timer;
    return Promise.race([
      exit.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), stopTimeoutMs);
        timer.unref?.();
      }),
    ]).finally(() => clearTimeout(timer));
  }

  async function spawn(run) {
    const profile = find(run.id);
    if (closed || run.stopping || !profile || !run.vault) return { proc: null, abort: true };
    const { entry, compileCacheDir } = launch();
    const env = profileServerEnvironment(baseEnvironment(), {
      leaseEnvironment: run.lease.utilityServerLeaseEnvironment(),
      dataDir: dataDirFor(run.id),
      port: profile.port,
      profileId: run.id,
      credentials: run.vault.store.read(),
      credentialStore: run.vault.status,
      compileCacheDir,
    });
    log(`profile ${run.id} fork ${entry} port=${profile.port}`);
    const proc = fork(entry, [], { env, stdio: ["ignore", "pipe", "pipe"] });
    let exited = false;
    run.exits.set(proc, new Promise((resolve) => {
      proc.once("exit", (code) => {
        exited = true;
        onExit(proc);
        log(`profile ${run.id} exited code=${code}`);
        resolve();
      });
    }));
    proc.stdout?.on("data", (data) => log(`[${run.id} out] ${String(data).trimEnd()}`));
    proc.stderr?.on("data", (data) => log(`[${run.id} err] ${String(data).trimEnd()}`));
    proc.on("message", (message) => {
      if (!run.supervisor.isCurrent(proc)) return;
      try {
        onMessage(proc, message);
      } catch (error) {
        log(`profile ${run.id} private sync rejected: ${error?.message ?? error}`);
      }
    });
    proc.once("spawn", () => {
      if (run.supervisor.isCurrent(proc)) onSpawn(proc);
    });
    run.supervisor.watch(proc);
    const identity = await probe({
      port: profile.port,
      pid: () => proc.pid,
      bootTimeoutMs,
      isExited: () => exited || closed || run.stopping,
    });
    if (identity.outcome === "ready" && run.supervisor.isCurrent(proc)) return { proc };
    log(`profile ${run.id} did not start on port ${profile.port} (${identity.outcome})`);
    const stopped = await stopProc(run, proc);
    return { proc: null, reason: stopped ? identity.outcome : "stuck-child", abort: !stopped };
  }

  async function boot(run) {
    try {
      run.vault = await openVault(run.id);
      if (closed || run.stopping) return;
      const port = await choosePort(run.id);
      if (closed || run.stopping) return;
      if (port === null) throw new Error("No free port for this profile");
      run.lease = acquireLease(dataDirFor(run.id));
      run.supervisor = supervise({
        restart: () => spawn(run),
        stop: (proc) => stopProc(run, proc),
        onReady(proc) {
          run.proc = proc;
          setStatus(run, "running");
          onReady(run.id);
        },
        onUnavailable() {
          run.proc = null;
          if (run.status === "running") setStatus(run, "starting");
        },
        onExhausted() {
          setStatus(run, "failed");
        },
        log,
      });
      const result = await spawn(run);
      if (result.proc && run.supervisor.ready(result.proc)) return;
      setStatus(run, "failed");
    } catch (error) {
      log(`profile ${run.id} could not start: ${error?.message ?? error}`);
      setStatus(run, "failed");
    }
  }

  function startRun(id) {
    const current = runs.get(id);
    if (current && current.status !== "failed") return waitFor(current);
    const run = {
      id,
      status: "starting",
      proc: null,
      lease: null,
      vault: null,
      supervisor: null,
      stopping: false,
      waiters: new Set(),
      exits: new WeakMap(),
    };
    const previous = current ? stopRun(id) : Promise.resolve(true);
    runs.set(id, run);
    onChange();
    run.booted = previous.then((stopped) => {
      if (!stopped) {
        setStatus(run, "failed");
        return;
      }
      return boot(run);
    });
    return waitFor(run);
  }

  async function stopRun(id) {
    const run = runs.get(id);
    if (!run) return true;
    run.stopping = true;
    await run.booted?.catch(() => {});
    const stopped = run.supervisor ? await run.supervisor.shutdown() : true;
    if (stopped && run.lease) {
      try {
        run.lease.release();
      } catch (error) {
        log(`profile ${id} lease not released: ${error?.message ?? error}`);
      }
    }
    if (runs.get(id) === run) runs.delete(id);
    setStatus(run, "stopped");
    onChange();
    return stopped;
  }

  function statusOf(id) {
    return runs.get(id)?.status ?? "stopped";
  }

  async function start() {
    if (started || closed) return;
    started = true;
    const active = activeProfile(state);
    if (active && !(await startRun(active.id))) {
      log(`profile ${active.id} could not start; opening Personal instead`);
      save(withActive(state, MAIN_ID));
    }
    void (async () => {
      for (const profile of state.profiles) {
        if (closed) return;
        if (!runs.has(profile.id)) await startRun(profile.id);
      }
    })();
  }

  function seed(id, source) {
    if (!source) return;
    let raw;
    try {
      raw = fs.readFileSync(path.join(source, "config.json"), "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") log(`profile ${id} starts with a fresh config: ${error?.message ?? error}`);
      return;
    }
    const start = profileSeed(raw);
    if (!start) return;
    try {
      fs.mkdirSync(dataDirFor(id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dataDirFor(id), "config.json"), JSON.stringify(start, null, 2), { mode: 0o600, flag: "wx" });
    } catch (error) {
      log(`profile ${id} starts with a fresh config: ${error?.message ?? error}`);
    }
  }

  async function add(name) {
    if (closed) throw new Error("later.dog is closing");
    const { state: next, profile } = withProfile(state, name, makeId);
    const source = activeDataDir() ?? mainDataDir;
    save(next);
    seed(profile.id, source);
    const ready = await startRun(profile.id);
    return { id: profile.id, ready };
  }

  function usePersonal() {
    switchTicket++;
    save(withActive(state, MAIN_ID));
  }

  async function switchTo(id) {
    if (id === MAIN_ID) {
      usePersonal();
      return { id: MAIN_ID, origin: null };
    }
    const profile = find(id);
    if (!profile) throw new Error("That profile no longer exists");
    const ticket = ++switchTicket;
    const ready = await startRun(id);
    if (ticket !== switchTicket) return { id: state.activeId, origin: activeOrigin(), superseded: true };
    if (!ready) throw new Error(`${profile.name} could not start`);
    const current = find(id);
    if (!current) throw new Error("That profile no longer exists");
    save(withActive(state, id));
    return { id, origin: profileOrigin(current) };
  }

  function rename(id, name) {
    save(withName(state, id, name));
    return list();
  }

  async function remove(id) {
    if (id === MAIN_ID) throw new Error("Personal can't be removed");
    if (!find(id)) return list();
    if (id === state.activeId) throw new Error("Switch to another profile before removing this one");
    if (!(await stopRun(id))) throw new Error("This profile is still shutting down. Try again in a moment.");
    save(withoutProfile(state, id));
    vaults.delete(id);
    try {
      fs.rmSync(path.dirname(credentialFile(id)), { recursive: true, force: true });
    } catch (error) {
      log(`profile ${id} keys not removed: ${error?.message ?? error}`);
    }
    if (fs.existsSync(dataDirFor(id))) {
      try {
        await trash(dataDirFor(id));
      } catch (error) {
        log(`profile ${id} folder not moved to the Trash: ${error?.message ?? error}`);
      }
    }
    return list();
  }

  async function saveCredential(id, name, value, patch) {
    const profile = find(id);
    if (!profile || statusOf(id) !== "running") throw new Error("This profile's bot server is unavailable");
    const vault = await openVault(id);
    const secret = typeof value === "string" ? value.trim() : "";
    return vault.store.update(
      (credentials) => {
        if (secret) credentials[name] = secret;
        else delete credentials[name];
        return credentials;
      },
      () => applyCredential({ port: profile.port, patch }),
    );
  }

  async function stopAll() {
    closed = true;
    await Promise.all([...runs.keys()].map((id) => stopRun(id)));
  }

  function list() {
    return profileList(state, statusOf);
  }

  function activeOrigin() {
    const profile = activeProfile(state);
    return profile ? profileOrigin(profile) : null;
  }

  function activeProcess() {
    const profile = activeProfile(state);
    if (!profile) return null;
    const run = runs.get(profile.id);
    return run?.status === "running" ? run.proc : null;
  }

  function activeDataDir() {
    const profile = activeProfile(state);
    return profile ? dataDirFor(profile.id) : null;
  }

  function activeCredentialStore() {
    const profile = activeProfile(state);
    if (!profile) return null;
    return runs.get(profile.id)?.vault?.status ?? "ok";
  }

  function ownsPort(port) {
    return state.profiles.some((profile) => profile.port === port && statusOf(profile.id) === "running");
  }

  function isProfileOrigin(origin) {
    return state.profiles.some((profile) => profileOrigin(profile) === origin);
  }

  return {
    activeCredentialStore,
    activeDataDir,
    activeId: () => state.activeId,
    activeOrigin,
    activeProcess,
    add,
    dataRoot,
    isProfileOrigin,
    list,
    ownsPort,
    remove,
    rename,
    saveCredential,
    start,
    stopAll,
    switchTo,
    usePersonal,
  };
}
